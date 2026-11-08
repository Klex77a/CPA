'use strict';
// Exercises an actual interrupted CLI process with offline model responses.
// No requests to providers are permitted in these tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { openJournal } = require('../src/benchmark-journal');
const { parseArgs } = require('../scripts/benchmark');
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-benchmark-journal-'));
const options = { identity: { prompt: 'test-v1', source: 'frozen' }, metadata: { mode: 'offline-test' }, caseIds: ['one', 'two', 'three'] };
let count = 0;
function test(name, fn) { fn(); count++; console.log('✔ ' + name); }
try {
  test('dispatch is durable before work; resume preserves answers and never retries ambiguous work', () => {
    const file = path.join(dir, 'resume.json');
    let journal = openJournal(file, options);
    journal.dispatch('one');
    assert.equal(JSON.parse(fs.readFileSync(file)).cases[0].state, 'dispatched');
    const outcome = { case_id: 'one', evaluation: { original: 'retained' } };
    journal.finish(outcome); journal.dispatch('two'); journal.close();
    journal = openJournal(file, { ...options, resume: true });
    assert.deepEqual(journal.pending(), ['three']);
    assert.deepEqual(journal.outcomes()[0], outcome);
    assert.equal(journal.outcomes()[1].error.code, 'INTERRUPTED_UNKNOWN_USAGE');
    assert.equal(journal.outcomes()[1].cost_usd, null);
    assert.equal(journal.outcomes()[1].billing_complete, false);
    assert.throws(() => journal.dispatch('two'), /duplicate/);
    journal.close();
  });

  test('existing journals, missing recovery files and changed source/rules/settings fail closed', () => {
    const file = path.join(dir, 'resume.json');
    assert.throws(() => openJournal(file, options), /already exists/);
    assert.throws(() => openJournal(path.join(dir, 'missing.json'), { ...options, resume: true }), /No journal/);
    assert.throws(() => openJournal(file, { ...options, resume: true, identity: { ...options.identity, source: 'changed' } }), /configuration\/source changed/);
    assert.throws(() => openJournal(file, { ...options, resume: true, caseIds: ['one', 'three', 'two'] }), /case list/);
    assert.equal(fs.existsSync(file + '.lock'), false, 'failures release the process lock');
    assert.throws(() => parseArgs(['--resume']), /requires --live/);
  });

  test('lost dispatch billing keeps a configured upper bound, never an invented exact request count', () => {
    const file = path.join(dir, 'billing-bound.json');
    const scoped = { ...options, identity: { metadata: { settings: { samples: 3, repair_attempts: 1, llm_max_attempts: 2 } } } };
    let journal = openJournal(file, scoped);
    journal.dispatch('one'); journal.close();
    journal = openJournal(file, { ...scoped, resume: true });
    assert.equal(journal.outcomes()[0].unknown_call_count, 12);
    assert.equal(journal.outcomes()[0].unknown_call_count_is_upper_bound, true);
    journal.close();
  });

  test('a second process cannot share a live journal; an exited process lock is recoverable', () => {
    const file = path.join(dir, 'locked.json');
    const journal = openJournal(file, options);
    assert.throws(() => openJournal(file, { ...options, resume: true }), /locked/);
    journal.close();
    const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.equal(exited.status, 0);
    fs.writeFileSync(file + '.lock', JSON.stringify({ pid: exited.pid, token: 'exited-test-process' }));
    const recovered = openJournal(file, { ...options, resume: true });
    recovered.close();
    assert.equal(fs.existsSync(file + '.lock'), false);
  });

  test('a failed checkpoint throws before dispatch can reach an API call', () => {
    const file = path.join(dir, 'write-failed.json');
    const journal = openJournal(file, options);
    const rename = fs.renameSync;
    let calls = 0;
    try {
      fs.renameSync = () => { throw new Error('simulated disk failure'); };
      assert.throws(() => { journal.dispatch('one'); calls++; }, /disk failure/);
    } finally { fs.renameSync = rename; journal.close(); }
    assert.equal(calls, 0);
    assert.equal(JSON.parse(fs.readFileSync(file)).cases[0].state, 'pending');
  });

  test('real CLI interruption resumes only unstarted cases, keeps failures in denominator and avoids all repeated calls', () => {
    const preload = path.join(dir, 'offline.cjs');
    const calls = path.join(dir, 'calls.jsonl');
    const output = path.join(dir, 'cli-report.json');
    fs.writeFileSync(preload, `
      const fs = require('fs');
      global.fetch = async () => { throw new Error('Network forbidden in offline interruption test'); };
      const fixture = require(process.cwd() + '/test/fixtures/benchmark-cases.json');
      const checklist = require(process.cwd() + '/src/default-checklist.json');
      require(process.cwd() + '/src/llm').complete = async (_system, user) => {
        const reference = fixture.cases.find(c => user.includes('ДИАЛОГ ' + c.record.conversation_id + ' |'));
        if (!reference) throw new Error('Unknown offline input');
        fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify(reference.id) + '\\n');
        if (process.env.TEST_INTERRUPT === '1' && reference.id === fixture.cases[1].id) process.exit(17);
        return { text: JSON.stringify({ criteria: checklist.criteria.map(c => {
          const r = reference.expected[c.id];
          return { id: c.id, answer: r.value === null ? 'NA' : c.type === 'scale' ? 'SCORE' : r.value ? 'YES' : 'NO', score: typeof r.value === 'number' ? r.value : null, explanation: r.grounding, evidence: r.evidence_turns.map(n => ({msg: 'm' + (n - 1)})), na_reason: r.value === null ? r.grounding : null };
        }), coaching: [] }), usage: {input: 10, output: 10, thoughts: 0}, metrics: {http_attempts: 1, usage_reported: true} };
      };
    `, 'utf8');
    const env = { ...process.env, LLM_PROVIDER: 'deepseek', LLM_MODEL: 'offline-test', DEEPSEEK_API_KEY: 'offline-only', SAMPLES: '1', REPAIR_ATTEMPTS: '0', LLM_MAX_ATTEMPTS: '1', TEST_CALLS: calls };
    const args = ['--require', preload, 'scripts/benchmark.js', '--live', '--out', output];
    const interrupted = spawnSync(process.execPath, args, { cwd: root, env: { ...env, TEST_INTERRUPT: '1' }, encoding: 'utf8' });
    assert.equal(interrupted.status, 17, interrupted.stderr);
    assert.equal(fs.existsSync(output), false);
    const afterInterruption = JSON.parse(fs.readFileSync(output + '.journal.json'));
    assert.equal(afterInterruption.cases[0].state, 'finished');
    assert.equal(afterInterruption.cases[1].state, 'dispatched');
    const resumed = spawnSync(process.execPath, [...args, '--resume'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(resumed.status, 1, resumed.stderr);
    const report = JSON.parse(fs.readFileSync(output));
    assert.equal(report.metrics.cases.completed, 14);
    assert.equal(report.metrics.cases.failed, 1);
    assert.equal(report.metrics.criterion_match.total, 120);
    assert.equal(report.metrics.criterion_match.matched, 112);
    assert.equal(report.metrics.cost.total_usd, null);
    assert.equal(report.metrics.cost.unknown_call_count_is_upper_bound, true);
    assert.equal(report.cases[1].error.code, 'INTERRUPTED_UNKNOWN_USAGE');
    assert.equal(report.run.started_at, afterInterruption.metadata.started_at);
    const sent = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(sent.length, 15); assert.equal(new Set(sent).size, 15);
    const repeated = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8' });
    assert.equal(repeated.status, 2); assert.ok(repeated.stderr.includes('already exists'));
    const completeResume = spawnSync(process.execPath, [...args, '--resume'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(completeResume.status, 1, completeResume.stderr);
    assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse), sent);
  });
  console.log(`\nBenchmark journal: ${count} checks passed (offline only).`);
} finally {
  // Only remove the exact temporary directory created above.
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(dir, { recursive: true, force: true });
}

'use strict';
// Isolated filesystem and evaluator doubles. No provider requests or real DEV data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-dataset-runner-'));
Object.assign(process.env, { CQA_DATA_DIR: dataDir, LLM_PROVIDER: 'mock' });
const { parseArgs, runDataset } = require('../scripts/evaluate-dataset');
const store = require('../src/store');
const { cacheKey } = require('../src/evaluator');
const { saveEvaluationFailure } = require('../src/evaluation-failure');
const checklist = require('../src/default-checklist.json');
const cfg = { provider: 'fixture-provider', model: 'test-double', CONCURRENCY: 32 };
const clone = (value) => JSON.parse(JSON.stringify(value));
const records = Array.from({ length: 5 }, (_, index) => ({ conversation_id: `runner-${index}`, channel: 'agent chat', language: 'RU', transcript: [{ speaker: 'client', timestamp: '', text: 'Synthetic fixture' }] }));
store.write('checklists', 'default', checklist);
store.write('datasets', 'FIXTURE', { group_id: 'FIXTURE', records });
const cached = (index, status, group = 'FIXTURE', key = cacheKey(records[index], checklist)) => ({ id: `cached-${index}-${group}-${status}`, conversation_id: records[index].conversation_id, group_id: group, status, cache_key: key, created_at: '2026-01-01T00:00:00Z' });
for (const evaluation of [cached(0, 'ok'), cached(1, 'needs_review'), cached(2, 'ok', 'OTHER'), cached(3, 'ok', 'FIXTURE', 'old-prompt')]) store.write('evaluations', evaluation.id, evaluation);
let passed = 0;
async function test(name, fn) { await fn(); console.log('✔', name); passed++; }

(async () => {
  await test('explicit source, strict flags, numeric caps and bounded concurrency', () => {
    assert.equal(parseArgs(['--group=DEV']).live, false);
    assert.deepEqual(parseArgs(['--group', 'DEV', '--checklist=default', '--live', '--force', '--retry-review', '--max-new=10', '--concurrency', '1']), { group: 'DEV', checklist: 'default', live: true, force: true, retryReview: true, maxNew: 10, concurrency: 1 });
    for (const args of [[], ['--group='], ['--group', '--live'], ['--group=DEV', '--max-new=-1'], ['--group=DEV', '--max-new=1.5'], ['--group=DEV', '--concurrency=3'], ['--group=DEV', '--live=false'], ['--group=DEV', '--live', '--live'], ['--unknown=secret']]) assert.throws(() => parseArgs(args));
    assert.equal(parseArgs(['--help']).help, true);
  });
  const logs = [];
  let calls = 0;
  const dependencies = { cfg, store, cacheKey, saveEvaluationFailure, log: (line) => logs.push(line), evaluate: async () => { calls++; throw new Error('MUST_NOT_CALL'); } };
  await test('dry-run never evaluates or writes and isolates group/current prompt/review state', async () => {
    const before = store.list('evaluations').length;
    const summary = await runDataset(parseArgs(['--group=FIXTURE']), dependencies);
    assert.deepEqual([summary.total, summary.planned, summary.skipped, summary.review_blocked, summary.exitCode], [5, 3, 1, 1, 1]);
    assert.equal(calls, 0);
    assert.equal(store.list('evaluations').length, before);
    assert.equal(store.list('failures').length, 0);
    const retry = await runDataset(parseArgs(['--group=FIXTURE', '--retry-review']), dependencies);
    assert.deepEqual([retry.planned, retry.skipped, retry.review_blocked, retry.exitCode], [4, 1, 0, 0]);
  });
  await test('new-attempt cap and invalid source fail before any model call', async () => {
    await assert.rejects(runDataset(parseArgs(['--group=FIXTURE', '--live', '--max-new=2']), dependencies), /лимит/);
    await assert.rejects(runDataset(parseArgs(['--group=MISSING', '--live']), dependencies), /не найден/);
    store.write('datasets', 'DUPLICATES', { group_id: 'DUPLICATES', records: [records[0], records[0]] });
    await assert.rejects(runDataset(parseArgs(['--group=DUPLICATES', '--live']), dependencies), /повторяющиеся/);
    assert.equal(calls, 0);
  });
  await test('bounded workers persist every outcome and include billed failures without printing bodies', async () => {
    let active = 0, peak = 0;
    const evaluated = [];
    const evaluate = async (record, cl, group, options) => {
      active++; peak = Math.max(peak, active); evaluated.push({ id: record.conversation_id, options });
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      const index = records.indexOf(record);
      const metrics = { cost_usd: index === 2 ? 0.01 : index === 3 ? 0.02 : 0.03, timing: { http_attempts: index - 1, calls: [{}] }, usage: { input: 10, output: 5, thoughts: 0 } };
      if (index === 3) throw Object.assign(new Error('DO_NOT_LOG_PROVIDER_BODY api_key=sk-fixture-secret'), { status: 429, evaluation_metrics: metrics });
      return { id: `new-${index}`, status: index === 4 ? 'needs_review' : 'ok', ...metrics };
    };
    // store.read returns new objects, so match by the preserved source ID.
    const byId = async (record, ...rest) => evaluate(records.find((item) => item.conversation_id === record.conversation_id), ...rest);
    const summary = await runDataset(parseArgs(['--group=FIXTURE', '--live']), { ...dependencies, evaluate: byId });
    assert.equal(peak, 2, 'cfg concurrency 32 is capped at two active conversations');
    assert.deepEqual(evaluated.map((item) => item.id).sort(), ['runner-2', 'runner-3', 'runner-4']);
    assert.deepEqual([summary.done, summary.needs_review, summary.failed, summary.review_blocked, summary.exitCode], [1, 1, 1, 1, 1]);
    assert.equal(summary.cost_usd, 0.06);
    assert.equal(summary.http_attempts, 6);
    assert.equal(summary.model_calls, 3);
    assert.ok(store.read('evaluations', 'new-2'));
    assert.ok(store.read('evaluations', 'new-4'));
    const failure = store.list('failures')[0];
    assert.equal(failure.conversation_id, 'runner-3');
    assert.equal(failure.cost_usd, 0.02);
    assert.equal(failure.status, 'error');
    assert.doesNotMatch(failure.validation_errors[0], /sk-fixture-secret/);
    assert.doesNotMatch(logs.join('\n'), /DO_NOT_LOG_PROVIDER_BODY|sk-fixture-secret|Synthetic fixture/);
    assert.match(logs.join('\n'), /HTTP_429/);
    assert.equal(summary.done + summary.skipped + summary.review_blocked + summary.needs_review + summary.failed, summary.total);
  });
  await test('explicit review retry/force preserve historical records and generate fresh attempts', async () => {
    const seen = [];
    const evaluate = async (record, cl, group, options) => {
      seen.push({ id: record.conversation_id, force: options.force });
      return { id: `force-${record.conversation_id}`, status: 'ok', cost_usd: 0, timing: { calls: [], http_attempts: 0 } };
    };
    await runDataset(parseArgs(['--group=FIXTURE', '--live', '--retry-review']), { ...dependencies, evaluate });
    assert.equal(seen.find((item) => item.id === 'runner-1').force, true, 'same-key review retry creates a fresh history entry');
    assert.ok(store.read('evaluations', 'cached-1-FIXTURE-needs_review'));
    seen.length = 0;
    const forced = await runDataset(parseArgs(['--group=FIXTURE', '--live', '--force']), { ...dependencies, evaluate });
    assert.equal(forced.planned, 5);
    assert.equal(seen.length, 5);
    assert.ok(seen.every((item) => item.force));
    assert.ok(store.read('evaluations', 'cached-0-FIXTURE-ok'));
  });
  await test('actual CLI defaults to dry-run and refuses a mock live run', () => {
    const script = path.join(__dirname, '../scripts/evaluate-dataset.js');
    const before = store.list('evaluations').length;
    const child = spawnSync(process.execPath, [script, '--group=FIXTURE'], { encoding: 'utf8', env: process.env });
    assert.equal(child.status, 1, child.stderr); // one original same-key review stays blocked
    assert.match(child.stdout, /DRY-RUN/);
    assert.match(child.stdout, /Запросов к модели и новых записей нет/);
    assert.equal(store.list('evaluations').length, before);
    const live = spawnSync(process.execPath, [script, '--group=FIXTURE', '--live', '--force'], { encoding: 'utf8', env: process.env });
    assert.equal(live.status, 2);
    assert.match(live.stderr, /настоящая настроенная модель/);
    assert.equal(store.list('evaluations').length, before);
  });
  console.log(`dataset-runner: пройдено ${passed}`);
})().catch((error) => { console.error(error); process.exitCode = 1; });

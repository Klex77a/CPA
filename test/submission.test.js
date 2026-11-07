'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-submission-data-'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-submission-root-'));
Object.assign(process.env, { CQA_DATA_DIR: data, LLM_PROVIDER: 'mock' });
const cfg = require('../src/config');
const store = require('../src/store');
const checklist = require('../src/default-checklist.json');
const { prepareSubmission, inspectSubmission, submissionPath } = require('../src/submission-service');
const { inspectBenchmark, getReadiness, benchmarkReportPath } = require('../src/readiness');
const { buildBenchmarkReport, aggregateBenchmark } = require('../src/benchmark');
const { settingsFingerprint, PROMPT_VERSION } = require('../src/evaluator');
const { computeScore } = require('../src/scoring');
const fixture = require('./fixtures/benchmark-cases.json');
const transcript = [{ timestamp: '00:00', speaker: 'operator', text: 'Synthetic submission fixture.' }];
const answers = Object.fromEntries(checklist.criteria.map((criterion) => [criterion.id, {
  answer: criterion.type === 'flag' ? 'NO' : criterion.type === 'scale' ? 'SCORE' : 'YES',
  value: criterion.type === 'scale' ? Math.max(...criterion.scale.map((step) => step.value)) : null,
  explanation: `Fixture proof for ${criterion.id}`, evidence: [{ msg: 0 }],
}]));
store.write('checklists', checklist.id, checklist);
const records = Array.from({ length: 65 }, (_, index) => ({ conversation_id: `fixture-${index}`, transcript, channel: 'agent chat', language: 'RU' }));
store.write('datasets', 'DEV', { group_id: 'DEV', records });
for (const record of records) store.write('evaluations', record.conversation_id, {
  id: record.conversation_id, group_id: 'DEV', conversation_id: record.conversation_id, channel: record.channel, language: record.language,
  transcript_hash: crypto.createHash('sha256').update(JSON.stringify(transcript)).digest('hex').slice(0, 16),
  checklist: { id: checklist.id, version: checklist.version }, checklist_snapshot: checklist,
  created_at: '2026-11-07T00:00:00Z', provider: 'deepseek', model: 'submission-test-fixture', status: 'ok', final_criteria: answers,
});
let count = 0;
const test = (name, fn) => { fn(); count++; console.log('✔', name); };
test('dry-run validates without writing; official output preserves all source IDs', () => {
  assert.equal(inspectSubmission({ split: 'dev', root }).state, 'missing_file');
  assert.equal(prepareSubmission({ split: 'dev', groupId: 'DEV', root, dryRun: true }).written, false);
  assert.equal(fs.existsSync(submissionPath('dev', root)), false);
  const prepared = prepareSubmission({ split: 'dev', groupId: 'DEV', root });
  assert.equal(prepared.total, 65); assert.equal(prepared.errors, 0);
  const output = JSON.parse(fs.readFileSync(submissionPath('dev', root), 'utf8'));
  assert.deepEqual(output.results.map((row) => row.conversation_id), records.map((record) => record.conversation_id));
  assert.equal(inspectSubmission({ split: 'dev', root }).state, 'ready');
});
test('changed results make the saved file stale; real error rows are retained', () => {
  const evaluation = store.read('evaluations', 'fixture-0');
  store.write('evaluations', evaluation.id, { ...evaluation, status: 'needs_review', validation_errors: ['proof requires review'] });
  assert.equal(inspectSubmission({ split: 'dev', root }).state, 'stale');
  assert.equal(prepareSubmission({ split: 'dev', groupId: 'DEV', root }).errors, 1);
  assert.equal(inspectSubmission({ split: 'dev', root }).state, 'valid_with_errors');
});
test('missing PROD remains pending; invalid JSON and paths cannot become ready', () => {
  assert.equal(inspectSubmission({ split: 'prod', root }).state, 'waiting_dataset');
  assert.throws(() => prepareSubmission({ split: 'prod', groupId: 'missing', root }), /не загружен/);
  for (const split of ['../escape', 'constructor', '__proto__', null]) assert.throws(() => submissionPath(split, root));
  fs.writeFileSync(submissionPath('dev', root), '{invalid');
  assert.equal(inspectSubmission({ split: 'dev', root }).state, 'blocked');
  fs.mkdirSync(path.dirname(submissionPath('prod', root)), { recursive: true });
  for (const invalid of [null, { results: '0123456789' }, { results: [null] }]) {
    fs.writeFileSync(submissionPath('prod', root), JSON.stringify(invalid));
    assert.equal(inspectSubmission({ split: 'prod', root }).state, 'blocked', 'malformed JSON structure produces a status rather than crashing readiness');
  }
  fs.unlinkSync(submissionPath('prod', root));
  prepareSubmission({ split: 'dev', groupId: 'DEV', root });
});
test('benchmark readiness requires current live metadata and internally consistent measurements', () => {
  assert.equal(inspectBenchmark({ root }).state, 'not_run');
  cfg.provider = 'deepseek'; cfg.model = 'readiness-test-fixture';
  const outcomes = fixture.cases.map((reference) => {
    const criteria = Object.fromEntries(checklist.criteria.map((criterion) => {
      const expected = reference.expected[criterion.id];
      return [criterion.id, { answer: expected.value === null ? 'NA' : criterion.type === 'scale' ? 'SCORE' : expected.value ? 'YES' : 'NO', value: typeof expected.value === 'number' ? expected.value : null, explanation: expected.grounding, na_reason: expected.value === null ? expected.grounding : null, evidence: expected.evidence_turns.map((turn) => ({ msg: turn - 1 })) }];
    }));
    return { case_id: reference.id, evaluation: { criteria, original_result: computeScore(checklist, criteria), status: 'ok', provider: cfg.provider, model: cfg.model, prompt_version: PROMPT_VERSION, duration_ms: 10, cost_usd: 0 } };
  });
  const report = buildBenchmarkReport(fixture, outcomes, { mode: 'live', provider: cfg.provider, model: cfg.model, prompt_version: PROMPT_VERSION, settings_fingerprint: settingsFingerprint() });
  const directory = path.join(root, 'docs', 'benchmark-results'); fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, 'latest.json');
  const write = (value) => fs.writeFileSync(target, JSON.stringify(value));
  write(report);
  assert.equal(benchmarkReportPath(root), target, 'versioned report works after a clean clone');
  assert.equal(inspectBenchmark({ root }).state, 'measured');
  write({ ...report, run: { ...report.run, mode: 'offline' } });
  assert.equal(inspectBenchmark({ root }).state, 'unverified_run');
  write({ ...report, run: { ...report.run, prompt_version: 'old' } });
  assert.equal(inspectBenchmark({ root }).state, 'stale');
  write({ ...report, metrics: { ...report.metrics, criterion_match: { ...report.metrics.criterion_match, matched: 0 } } });
  assert.equal(inspectBenchmark({ root }).state, 'blocked');
  write(report);
  const readiness = getReadiness({ root });
  assert.equal(readiness.publication.state, 'not_verified');
  assert.equal(readiness.demo.steps.reduce((sum, step) => sum + step.seconds, 0), 300);

  const mismatchOutcomes = structuredClone(outcomes);
  mismatchOutcomes[0].evaluation.criteria.c01.answer = 'NO';
  mismatchOutcomes[0].evaluation.original_result = computeScore(checklist, mismatchOutcomes[0].evaluation.criteria);
  const mismatch = buildBenchmarkReport(fixture, mismatchOutcomes, report.run);
  write(mismatch);
  assert.equal(inspectBenchmark({ root }).state, 'measured', 'a real recorded disagreement remains measurable');
  const forged = structuredClone(mismatch);
  forged.cases[0].criteria[0].match = true;
  forged.cases[0].exact_match = true;
  forged.cases[0].mismatches = [];
  forged.metrics = aggregateBenchmark(forged.cases);
  write(forged);
  assert.equal(inspectBenchmark({ root }).state, 'blocked', 'reaggregating metrics cannot hide an actual/reference disagreement');

  for (const mutate of [
    (value) => { value.cases[0].criteria[0].expected = false; },
    (value) => { value.cases[0].transcript[0].text = 'Changed source'; },
    (value) => { value.cases[0].criteria[0].observed_evidence[0].fragment = 'not in the cited source'; },
    (value) => { value.cases[0].score.expected = 0; },
    (value) => { value.cases[0].prompt_version = 'different-observed-prompt'; },
    (value) => { value.cases[0].cost_usd = -1; },
  ]) {
    const changed = structuredClone(report); mutate(changed);
    changed.metrics = aggregateBenchmark(changed.cases);
    write(changed);
    assert.equal(inspectBenchmark({ root }).state, 'blocked');
  }
  const invalidOutcomes = structuredClone(outcomes);
  invalidOutcomes[0].evaluation.status = 'needs_review';
  invalidOutcomes[0].evaluation.criteria.c01.evidence.push({ msg: 1000 });
  const invalid = buildBenchmarkReport(fixture, invalidOutcomes, report.run);
  write(invalid);
  assert.equal(inspectBenchmark({ root }).state, 'measured', 'invalid evidence stays counted even though unsafe indices are omitted from saved observations');
  assert.equal(inspectBenchmark({ root }).metrics.cases.invalid, 1);
  write(report);
});

test('the saved real report, when present, passes replay consistency with its recorded model settings', () => {
  const actualFile = path.join(cfg.ROOT, 'output', 'benchmark', 'latest.json');
  if (!fs.existsSync(actualFile)) return; // clean clones need no ignored live artifact
  const actual = JSON.parse(fs.readFileSync(actualFile, 'utf8'));
  const previous = { provider: cfg.provider, model: cfg.model };
  try {
    cfg.provider = actual.run.provider; cfg.model = actual.run.model;
    const target = path.join(root, 'docs', 'benchmark-results', 'latest.json');
    fs.writeFileSync(target, JSON.stringify(actual));
    const status = inspectBenchmark({ root });
    assert.notEqual(status.state, 'blocked', 'the existing live report must not be rejected as corrupt');
    if (JSON.stringify(actual.run.settings_fingerprint) === JSON.stringify(settingsFingerprint())) assert.equal(status.state, 'measured');
  } finally { Object.assign(cfg, previous); }
});
console.log(`submission: пройдено ${count}`);

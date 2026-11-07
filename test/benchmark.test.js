'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const fixture = require('./fixtures/benchmark-cases.json');
const checklist = require('../src/default-checklist.json');
const { computeScore } = require('../src/scoring');
const { validateBenchmarkCases, compareEvaluation, aggregateBenchmark, buildBenchmarkReport, digest } = require('../src/benchmark');
const { parseArgs } = require('../scripts/benchmark');
const clone = (value) => JSON.parse(JSON.stringify(value));
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('✔', name); }

function evaluationFor(c) {
  const criteria = {};
  for (const criterion of checklist.criteria) {
    const ref = c.expected[criterion.id], value = ref.value;
    criteria[criterion.id] = {
      answer: value === null ? 'NA' : criterion.type === 'scale' ? 'SCORE' : value ? 'YES' : 'NO',
      value: typeof value === 'number' ? value : null, explanation: ref.grounding,
      evidence: ref.evidence_turns.map((n) => ({ msg: n - 1, fragment: c.record.transcript[n - 1].text })),
      checked_range: { from: 0, to: c.record.transcript.length - 1 }, missing_range: null,
      na_reason: value === null ? ref.grounding : null,
    };
  }
  return { status: 'ok', criteria, original_result: computeScore(checklist, criteria), provider: 'test', model: 'offline', prompt_version: 'test-v1', duration_ms: 10, cost_usd: 0.01, validation_errors: [] };
}
const outcomesFor = () => fixture.cases.map((c) => ({ case_id: c.id, evaluation: evaluationFor(c) }));

test('15 references are balanced, complete and grounded within source bounds', () => {
  assert.deepStrictEqual(validateBenchmarkCases(fixture), []);
  assert.strictEqual(fixture.cases.length, 15);
  for (const language of ['RU', 'KZ', 'EN']) assert.strictEqual(fixture.cases.filter((c) => c.record.language === language).length, 5);
  const report = buildBenchmarkReport(fixture, []);
  assert.deepStrictEqual(report.dataset.label_distribution.c06, { 4: 1, 7: 1, 10: 13 });
  assert.strictEqual(report.dataset.independent_expert_validation, false);
  assert(report.dataset.limitations.includes('Consultation steps 5/10/15'));
});

test('reference validator rejects missing labels, illegal NA, scale/type errors and bogus proof', () => {
  const broken = clone(fixture);
  delete broken.cases[0].expected.c02;
  broken.cases[0].expected.c01.value = null;
  broken.cases[0].expected.c04.value = 17;
  broken.cases[0].expected.c05.value = 'true';
  broken.cases[0].expected.c06.grounding = '';
  broken.cases[0].expected.c07.evidence_turns = [999];
  broken.cases[1].id = broken.cases[0].id;
  broken.cases[1].record.conversation_id = broken.cases[0].record.conversation_id;
  const errors = validateBenchmarkCases(broken);
  for (const expected of ['missing c02', 'prohibited NA', 'invalid reference value', 'grounding', 'evidence_turns', 'duplicate case id', 'duplicate conversation_id']) assert(errors.some((e) => e.includes(expected)), expected);
  assert.throws(() => buildBenchmarkReport(broken, []), /Invalid benchmark fixture/);
});

test('canonical weighting excludes NA and critical flag never zeroes score', () => {
  const get = (id) => fixture.cases.find((c) => c.id === id);
  for (const [id, expected] of [['ru-generic-apology-no-answer', 46.15], ['ru-injection-private-paid', 53.85], ['en-action-without-identity', 76.47], ['kz-wrong-greeting-language', 84.62]]) {
    const comparison = compareEvaluation(get(id), evaluationFor(get(id)));
    assert.strictEqual(comparison.score.expected, expected, id);
    assert.strictEqual(comparison.score.actual, expected, id);
    assert.strictEqual(comparison.score.absolute_error, 0);
  }
});

test('all correct original answers yield 120 matches, explicit precision/recall denominators and class coverage', () => {
  const report = buildBenchmarkReport(fixture, outcomesFor());
  assert.deepStrictEqual(report.metrics.criterion_match, { matched: 120, total: 120, valid: 120, invalid: 0, rate: 1, valid_only_rate: 1 });
  assert.strictEqual(report.metrics.cases.completed, 15);
  assert.strictEqual(report.metrics.critical.tp, 2);
  assert.strictEqual(report.metrics.critical.tn, 13);
  assert.strictEqual(report.metrics.critical.precision_denominator, 2);
  assert.strictEqual(report.metrics.critical.recall_denominator, 2);
  assert.strictEqual(report.metrics.final_score.mean_absolute_error, 0);
  assert.strictEqual(report.metrics.evidence.valid, 120);
  assert.strictEqual(report.metrics.by_language.KZ.total, 40);
  assert.strictEqual(report.metrics.by_criterion.c04.total, 15);
});

test('a failed critical-positive case stays in accuracy and recall denominators, with observed failure cost', () => {
  const outcomes = outcomesFor();
  outcomes[0].evaluation.criteria.c01.answer = 'NO';
  outcomes[0].evaluation.criteria.c02.answer = 'YES';
  outcomes[0].evaluation.criteria.c08.answer = 'YES';
  outcomes[0].evaluation.original_result = computeScore(checklist, outcomes[0].evaluation.criteria);
  outcomes[14] = { case_id: fixture.cases[14].id, error: { code: 'PROVIDER_TIMEOUT' }, duration_ms: 100, cost_usd: 0.02, usage: { input: 20, output: 10, thoughts: 0 } };
  const report = buildBenchmarkReport(fixture, outcomes);
  const { critical, criterion_match: match, na, cost, final_score: score } = report.metrics;
  assert.strictEqual(match.matched, 109);
  assert.strictEqual(match.total, 120);
  assert.strictEqual(match.invalid, 8);
  assert.deepStrictEqual([critical.tp, critical.fp, critical.fn, critical.unknown_positive], [1, 1, 0, 1]);
  assert.strictEqual(critical.precision, 0.5);
  assert.strictEqual(critical.recall, 0.5);
  assert.strictEqual(critical.recall_denominator, 2);
  assert.strictEqual(na.fn, 1);
  assert.strictEqual(na.unknown, 4);
  assert.strictEqual(cost.complete, true);
  assert(Math.abs(cost.total_usd - 0.16) < 1e-10);
  assert.strictEqual(score.compared, 14);
  assert.strictEqual(score.missing, 1);
  assert(score.mean_absolute_error > 0);
  assert.strictEqual(report.cases[14].usage.input, 20);
});

test('missing outcomes remain failed cases rather than disappearing; no predicted positives means null precision', () => {
  const report = buildBenchmarkReport(fixture, [outcomesFor()[0]]);
  assert.strictEqual(report.metrics.cases.failed, 14);
  assert.strictEqual(report.metrics.criterion_match.total, 120);
  assert.strictEqual(report.metrics.criterion_match.matched, 8);
  assert.strictEqual(report.metrics.critical.precision, null);
  assert.strictEqual(report.metrics.critical.recall, 0);
  assert.strictEqual(report.metrics.critical.recall_denominator, 2);
  assert.strictEqual(report.metrics.cost.observed_count, 1);
  assert.strictEqual(report.metrics.cost.missing_count, 14);
  assert.strictEqual(report.metrics.cost.complete, false);
  assert.strictEqual(aggregateBenchmark([]).critical.recall, null);
  assert.strictEqual(aggregateBenchmark([]).final_score.mean_absolute_error, null);
});

test('INVALID is unknown, not NA, and reported final scores are checked independently', () => {
  const c = fixture.cases[0], ev = evaluationFor(c);
  ev.criteria.c03.answer = 'INVALID';
  ev.original_result.total = 100;
  const comparison = compareEvaluation(c, ev);
  assert.strictEqual(comparison.status, 'invalid');
  assert.strictEqual(comparison.criteria.find((r) => r.criterion_id === 'c03').valid, false);
  assert.strictEqual(comparison.score.actual, null);
  assert.strictEqual(comparison.score.absolute_error, null);
  const report = aggregateBenchmark([comparison]);
  assert.strictEqual(report.na.unknown_positive, 1);
  assert.strictEqual(report.na.fn, 0);
  assert.strictEqual(report.final_score.inconsistent_reported, 1);
});

test('fake quotes, reversed ranges, missing NA reasons and invalid proof indices cannot pass evidence checks', () => {
  const c = fixture.cases[0], ev = evaluationFor(c);
  ev.criteria.c01.evidence = [{ msg: 1, fragment: 'This quote was never said.' }];
  ev.criteria.c02.na_reason = '';
  ev.criteria.c03.checked_range = { from: 3, to: 0 };
  ev.criteria.c04.evidence = [{ msg: 999, fragment: '' }];
  const comparison = compareEvaluation(c, ev);
  assert.strictEqual(comparison.status, 'invalid');
  assert(comparison.criteria[0].evidence_errors.some((e) => e.includes('quote')));
  assert(comparison.criteria[1].evidence_errors.some((e) => e.includes('reason')));
  assert(comparison.criteria[2].evidence_errors.some((e) => e.includes('range')));
  assert(comparison.criteria[3].evidence_errors.some((e) => e.includes('bounds')));
  assert.deepStrictEqual(comparison.criteria[3].observed_evidence_turns, []);
  assert.deepStrictEqual(comparison.criteria[0].observed_evidence_turns, [2]);
});

test('appeals cannot improve benchmark answers, and report retains replayable observed proof with 1-based turns', () => {
  const c = fixture.cases[0], ev = evaluationFor(c);
  ev.final_criteria = clone(ev.criteria);
  ev.final_criteria.c01.answer = 'NO';
  ev.final_result = { total: 0 };
  const comparison = compareEvaluation(c, ev);
  assert.strictEqual(comparison.exact_match, true);
  assert.strictEqual(comparison.score.actual, 100);
  assert.strictEqual(comparison.criteria[0].observed_rationale, c.expected.c01.grounding);
  assert.deepStrictEqual(comparison.criteria[0].observed_evidence_turns, [2]);
  assert.deepStrictEqual(comparison.criteria[0].observed_ranges.checked, { from: 1, to: 4 });
  assert.strictEqual(comparison.transcript[0].turn, 1);
  assert.strictEqual(comparison.transcript[0].text, c.record.transcript[0].text);
});

test('digest changes with reference edits and duplicate/foreign outcomes fail loudly', () => {
  const modified = clone(fixture); modified.cases[0].expected.c01.value = false;
  assert.notStrictEqual(digest(fixture), digest(modified));
  const outcome = outcomesFor()[0];
  assert.throws(() => buildBenchmarkReport(fixture, [outcome, outcome]), /Duplicate/);
  assert.throws(() => buildBenchmarkReport(fixture, [{ case_id: 'foreign' }]), /Unknown/);
});

test('runner gates live costs behind explicit --live + --out and never permits mock evidence', () => {
  assert.throws(() => parseArgs(['--live']), /require --out/);
  assert.throws(() => parseArgs(['--live', '--out', 'x', '--from', 'y']), /mutually exclusive/);
  assert.throws(() => parseArgs(['--out', 'x']), /requires --live/);
  assert.throws(() => parseArgs(['--live', '--out', 'x', '--concurrency', '3']), /1 or 2/);
  const result = spawnSync(process.execPath, ['scripts/benchmark.js', '--live', '--out', path.join(os.tmpdir(), 'cqa-should-not-exist.json')], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, LLM_PROVIDER: 'mock' } });
  assert.strictEqual(result.status, 2);
  assert(result.stderr.includes('mock results are not quality evidence'));
});

test('dry-run creates no model report; offline replay includes all missing cases and emits no raw provider error', () => {
  const cwd = path.join(__dirname, '..');
  const dry = execFileSync(process.execPath, ['scripts/benchmark.js'], { cwd, encoding: 'utf8' });
  assert(dry.includes('No API calls'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-benchmark-'));
  try {
    const input = path.join(dir, 'outcomes.json'), output = path.join(dir, 'report.json');
    fs.writeFileSync(input, JSON.stringify([{ case_id: fixture.cases[0].id, error: { code: 'TIMEOUT', message: 'sk-never-copy-this-provider-body' }, cost_usd: 0.001, duration_ms: 20 }]));
    const replay = spawnSync(process.execPath, ['scripts/benchmark.js', '--from', input, '--out', output], { cwd, encoding: 'utf8' });
    assert.strictEqual(replay.status, 1);
    const saved = fs.readFileSync(output, 'utf8');
    assert(!saved.includes('never-copy-this'));
    assert.strictEqual(JSON.parse(saved).metrics.cases.failed, 15);
    assert.strictEqual(JSON.parse(saved).run.mode, 'offline');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\nBenchmark: ${passed} checks passed.`);

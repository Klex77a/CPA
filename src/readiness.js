'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config');
const { inspectSubmission } = require('./submission-service');
const { digest, aggregateBenchmark, compareEvaluation, referenceCoverage } = require('./benchmark');
const { PROMPT_VERSION, settingsFingerprint, runtimeFingerprint } = require('./evaluator');
const checklist = require('./default-checklist.json');
const fixtures = { regression: require('../test/fixtures/benchmark-cases.json'), challenge: require('../test/fixtures/benchmark-challenge-cases.json') };

function inspectReferenceReview(root, suite, fixture) {
  if (suite !== 'challenge') return undefined;
  const file = path.join(root, 'docs', 'benchmark-results', 'challenge-review.json');
  if (!fs.existsSync(file)) return undefined;
  try {
    const review = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (review.kind !== 'engineering_reference_review' || review.state !== 'disputed' || review.fixture_digest !== digest(fixture) || review.independent_expert_validation !== false || review.reviewer_type !== 'engineering_peer_review' || typeof review.summary !== 'string' || !review.summary.trim() || !Array.isArray(review.findings) || !review.findings.length) return undefined;
    const keys = new Set(), cases = new Set(), categories = {};
    for (const finding of review.findings) {
      const reference = fixture.cases.find(item => item.id === finding.case_id);
      const key = `${finding.case_id}:${finding.criterion_id}`;
      if (!reference || !checklist.criteria.some(item => item.id === finding.criterion_id) || keys.has(key) || !['reference_questionable', 'boundary_disagreement', 'model_risk'].includes(finding.category) || typeof finding.rule !== 'string' || !finding.rule.trim() || !Array.isArray(finding.source_turns) || !finding.source_turns.length || finding.source_turns.some(turn => !Number.isInteger(turn) || turn < 1 || turn > reference.record.transcript.length)) return undefined;
      keys.add(key); cases.add(finding.case_id); categories[finding.category] = (categories[finding.category] || 0) + 1;
    }
    return { kind: review.kind, state: review.state, reviewer_type: review.reviewer_type, independent_expert_validation: false, summary: review.summary, disputed_label_count: keys.size, case_count: cases.size, findings_by_category: categories, link: '/api/benchmark/reference-review?suite=challenge' };
  } catch (_) { return undefined; }
}

function benchmarkReportPath(root = cfg.ROOT, suite = 'regression') {
  if (!Object.hasOwn(fixtures, suite)) throw new Error('Unknown benchmark suite');
  const filename = suite === 'challenge' ? 'challenge-latest.json' : 'latest.json';
  const working = path.join(root, 'output', 'benchmark', filename);
  const versioned = path.join(root, 'docs', 'benchmark-results', filename);
  return fs.existsSync(working) ? working : fs.existsSync(versioned) ? versioned : working;
}

/** Recompute conclusions from saved observations and the current reference.
 * This checks internal consistency, not the authenticity of a provider call.
 */
function assertBenchmarkCases(report, bindRunIdentity, fixture) {
  const same = (a, b) => digest(a) === digest(b);
  const assert = (condition) => { if (!condition) throw new Error('Inconsistent benchmark observations'); };
  for (const reference of fixture.cases) {
    const saved = report.cases.find((item) => item.case_id === reference.id);
    assert(saved && Array.isArray(saved.criteria) && saved.criteria.length === checklist.criteria.length);
    assert(saved.title === reference.title && saved.conversation_id === reference.record.conversation_id && saved.language === reference.record.language);
    assert(same(saved.transcript, reference.record.transcript.map((turn, index) => ({ turn: index + 1, ...turn }))));
    assert([null, 'ok', 'needs_review', 'error'].includes(saved.source_status));
    assert(Number.isSafeInteger(saved.validation_error_count) && saved.validation_error_count >= 0);
    for (const field of ['duration_ms', 'cost_usd']) assert(saved[field] === null || typeof saved[field] === 'number' && Number.isFinite(saved[field]) && saved[field] >= 0);
    assert(saved.http_attempts === null || Number.isSafeInteger(saved.http_attempts) && saved.http_attempts >= 0);
    if (saved.usage !== null) for (const field of ['input', 'output', 'thoughts']) assert(saved.usage && (saved.usage[field] === null || Number.isSafeInteger(saved.usage[field]) && saved.usage[field] >= 0));
    if (saved.billing_complete !== undefined) {
      assert(typeof saved.billing_complete === 'boolean' && Number.isSafeInteger(saved.unknown_call_count) && saved.unknown_call_count >= 0);
      assert(typeof saved.known_cost_usd === 'number' && Number.isFinite(saved.known_cost_usd) && saved.known_cost_usd >= 0);
      if (saved.known_usage !== null) for (const field of ['input', 'output', 'thoughts']) assert(saved.known_usage && Number.isSafeInteger(saved.known_usage[field]) && saved.known_usage[field] >= 0);
      assert(saved.billing_complete ? saved.cost_usd !== null && saved.unknown_call_count === 0 : saved.cost_usd === null);
    }
    const rows = new Map(saved.criteria.map((row) => [row?.criterion_id, row]));
    assert(rows.size === checklist.criteria.length);
    const criteria = {};
    let recordedInvalidProof = false;
    for (const criterion of checklist.criteria) {
      const row = rows.get(criterion.id), expected = reference.expected[criterion.id];
      assert(row && row.expected === expected.value && same(row.reference_evidence_turns, expected.evidence_turns) && row.grounding === expected.grounding);
      assert(typeof row.valid === 'boolean' && typeof row.match === 'boolean' && typeof row.evidence_valid === 'boolean');
      if (row.review_required !== undefined) assert(typeof row.review_required === 'boolean');
      if (row.observed_issues !== undefined) assert(Array.isArray(row.observed_issues) && row.observed_issues.every((issue) => typeof issue === 'string'));
      assert(Array.isArray(row.evidence_errors) && row.evidence_errors.every((error) => typeof error === 'string'));
      assert(row.evidence_valid === (row.evidence_errors.length === 0));
      assert(Array.isArray(row.observed_evidence) && Array.isArray(row.observed_evidence_turns));
      assert(row.observed_evidence.every((item) => item && Number.isInteger(item.turn) && item.turn >= 1 && item.turn <= reference.record.transcript.length && (item.fragment === null || typeof item.fragment === 'string')));
      assert(same(row.observed_evidence_turns, [...new Set(row.observed_evidence.map((item) => item.turn))]));
      assert(row.observed_ranges && typeof row.observed_ranges === 'object');
      recordedInvalidProof ||= !row.evidence_valid;
      const range = (value) => value == null ? null : { from: value.from - 1, to: value.to - 1 };
      criteria[criterion.id] = {
        answer: !row.valid ? 'INVALID' : row.actual === null ? 'NA' : criterion.type === 'scale' ? 'SCORE' : typeof row.actual === 'boolean' ? row.actual ? 'YES' : 'NO' : 'INVALID',
        value: criterion.type === 'scale' ? row.actual : null,
        explanation: row.observed_rationale, na_reason: row.observed_na_reason,
        evidence: row.observed_evidence.map((item) => ({ msg: item.turn - 1, fragment: item.fragment })),
        missing_range: range(row.observed_ranges.missing), checked_range: range(row.observed_ranges.checked),
        review_required: row.review_required || false, issues: row.observed_issues || [],
      };
    }
    const failed = saved.source_status === null || saved.source_status === 'error';
    if (bindRunIdentity && report.run.mode === 'live' && !failed) assert(saved.provider === report.run.provider && saved.model === report.run.model && saved.prompt_version === report.run.prompt_version);
    const billing = Object.fromEntries(['billing_complete', 'unknown_call_count', 'known_usage', 'known_cost_usd'].filter(key => Object.hasOwn(saved, key)).map(key => [key, saved[key]]));
    const observed = { duration_ms: saved.duration_ms, cost_usd: saved.cost_usd, usage: saved.usage, timing: { http_attempts: saved.http_attempts }, error: saved.error, ...billing };
    const evaluation = failed ? null : {
      ...observed, status: saved.source_status, criteria, original_result: { total: saved.score?.reported },
      // Invalid source indices are intentionally omitted from the report's
      // observed proof. Keep their recorded failure conservative on replay.
      validation_errors: saved.validation_error_count || recordedInvalidProof ? ['Recorded validation failure'] : [],
    };
    const derived = compareEvaluation(reference, evaluation, checklist, observed);
    for (const row of derived.criteria) {
      const original = rows.get(row.criterion_id);
      assert(row.expected === original.expected && row.actual === original.actual && row.valid === original.valid && row.match === original.match);
      if (original.evidence_valid) assert(row.evidence_valid);
    }
    assert(saved.exact_match === derived.exact_match && same(saved.mismatches, derived.mismatches));
    assert(saved.status === derived.status && same(saved.score, derived.score));
    for (const key of Object.keys(billing)) assert(same(saved[key], derived[key]));
  }
}

/** Operational identity is separate from settingsFingerprint used by score/cache keys. */
function inspectRuntime(run, current = runtimeFingerprint()) {
  const full = run?.runtime_fingerprint;
  const legacy = run?.settings || {};
  const observed = full || {
    timeout_ms: legacy.llm_timeout_ms, max_attempts: legacy.llm_max_attempts,
    repair_attempts: legacy.repair_attempts, samples: legacy.samples, concurrency: run?.concurrency,
  };
  const fields = ['execution_mode', 'timeout_ms', 'max_attempts', 'repair_attempts', 'samples', 'concurrency'];
  if (full && (full.version !== 1 || !['cloud-stepped', 'local', 'direct-benchmark'].includes(full.execution_mode) || fields.filter((key) => key !== 'execution_mode').some((key) => !Number.isSafeInteger(full[key]) || full[key] < (key === 'repair_attempts' ? 0 : 1)))) throw new Error('Invalid runtime fingerprint');
  if (full) {
    const aliases = { timeout_ms: 'llm_timeout_ms', max_attempts: 'llm_max_attempts', repair_attempts: 'repair_attempts', samples: 'samples' };
    if (run.concurrency !== undefined && run.concurrency !== full.concurrency) throw new Error('Contradictory runtime concurrency');
    for (const [key, alias] of Object.entries(aliases)) if (legacy[alias] !== undefined && legacy[alias] !== full[key]) throw new Error(`Contradictory runtime ${key}`);
  }
  const recorded = fields.filter((key) => observed[key] !== undefined && observed[key] !== null);
  const differences = recorded.filter((key) => observed[key] !== current[key]);
  const state = differences.length ? 'changed' : full ? 'matched' : 'unverified';
  return { state, complete: !!full, recorded: Object.fromEntries(recorded.map((key) => [key, observed[key]])), current, differences, note: state === 'matched' ? 'Параметры выполнения совпадают с сохранённым запуском.' : state === 'changed' ? 'Время, стоимость и частота ошибок сохранённого запуска не подтверждают текущие параметры выполнения.' : 'Исторический отчёт не содержит полного отпечатка параметров выполнения; время и стоимость относятся только к записанному запуску.' };
}

function inspectBenchmark({ root = cfg.ROOT, suite = 'regression' } = {}) {
  if (!Object.hasOwn(fixtures, suite)) throw new Error('Unknown benchmark suite');
  const fixture = fixtures[suite];
  const referenceReview = inspectReferenceReview(root, suite, fixture);
  const location = benchmarkReportPath(root, suite);
  if (!fs.existsSync(location)) return { state: 'not_run', suite, quality_state: 'not_run', runtime_state: 'not_run', independent_expert_validation: false, case_count: fixture.cases.length, coverage: referenceCoverage(fixture), ...(referenceReview ? { reference_review: referenceReview } : {}), message: suite === 'challenge' ? 'Расширенный инженерный набор подготовлен; живой прогон ещё не выполнен.' : 'Живой прогон регрессионных примеров ещё не выполнен' };
  try {
    const report = JSON.parse(fs.readFileSync(location, 'utf8'));
    if (report.kind !== 'engineering_reference_benchmark' || report.provenance !== 'engineering_reference' || !Array.isArray(report.cases) || report.cases.length !== fixture.cases.length || new Set(report.cases.map((row) => row.case_id)).size !== fixture.cases.length || report.cases.some((row) => !fixture.cases.some((reference) => reference.id === row.case_id))) throw new Error('Invalid benchmark report');
    const currentReference = report.dataset?.digest === digest(fixture) && report.checklist?.digest === digest(checklist);
    const current = currentReference && report.run.prompt_version === PROMPT_VERSION && report.run.provider === cfg.provider && report.run.model === cfg.model && !!report.run.settings_fingerprint && digest(report.run.settings_fingerprint) === digest(settingsFingerprint());
    if (currentReference) assertBenchmarkCases(report, current, fixture);
    const metrics = aggregateBenchmark(report.cases);
    if (digest(metrics) !== digest(report.metrics)) throw new Error('Report metrics do not match case results');
    const live = report.run.mode === 'live' && report.run.provider !== 'mock';
    const runtime = inspectRuntime(report.run);
    const state = !live ? 'unverified_run' : !current ? 'stale' : runtime.state === 'changed' ? 'runtime_changed' : runtime.state === 'unverified' ? 'runtime_unverified' : 'measured';
    return {
      state, suite, quality_state: !live ? 'unverified_run' : !current ? 'stale' : 'measured', runtime_state: runtime.state, runtime,
      message: !live ? 'Отчёт не подтверждён живым прогоном' : !current ? 'Настройки модели, правила или примеры изменились после прогона' : runtime.state !== 'matched' ? `Совпадение с инженерной разметкой измерено. ${runtime.note}` : 'Измерено совпадение с синтетическими инженерными примерами; независимая экспертная проверка отсутствует.',
      model: report.run.model, provider: report.run.provider, generated_at: report.generated_at,
      independent_expert_validation: false, case_count: report.cases.length, coverage: referenceCoverage(fixture),
      ...(referenceReview ? { reference_review: referenceReview } : {}),
      metrics, limitations: fixture.limitations,
    };
  } catch (_) { return { state: 'blocked', suite, message: 'Отчёт повреждён или его метрики не соответствуют результатам' }; }
}

function getReadiness({ root = cfg.ROOT } = {}) {
  const regression = inspectBenchmark({ root });
  const challenge = inspectBenchmark({ root, suite: 'challenge' });
  return {
    generated_at: new Date().toISOString(),
    benchmark: regression,
    benchmarks: { regression, challenge },
    submissions: ['dev', 'prod'].map((split) => inspectSubmission({ split, root })),
    publication: { state: 'not_verified', message: 'Локальная проверка файлов не подтверждает commit и push в репозиторий' },
    demo: {
      total_seconds: 300,
      steps: [
        { seconds: 60, title: 'Интерфейс и выбранный диалог', detail: 'Покажите набор, язык, роли и выбранный чек-лист.' },
        { seconds: 120, title: 'Оценка и доказательства', detail: 'Откройте критерий, перейдите к реплике, объясните N/A и итог; включите фрагмент настоящего звонка.' },
        { seconds: 60, title: 'Апелляция и пересмотр', detail: 'На синтетическом примере сохраните комментарий и решение с причиной; сравните исходный и финальный баллы.' },
        { seconds: 60, title: 'Замена критерия', detail: 'Измените копию чек-листа и примените её, сохраняя исходные DEV-оценки.' },
      ],
    },
  };
}

module.exports = { getReadiness, inspectBenchmark, inspectRuntime, benchmarkReportPath };

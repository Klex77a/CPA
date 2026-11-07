'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config');
const { inspectSubmission } = require('./submission-service');
const { digest, aggregateBenchmark, compareEvaluation } = require('./benchmark');
const { PROMPT_VERSION, settingsFingerprint } = require('./evaluator');
const checklist = require('./default-checklist.json');
const fixture = require('../test/fixtures/benchmark-cases.json');

function benchmarkReportPath(root = cfg.ROOT) {
  const working = path.join(root, 'output', 'benchmark', 'latest.json');
  const versioned = path.join(root, 'docs', 'benchmark-results', 'latest.json');
  return fs.existsSync(working) ? working : fs.existsSync(versioned) ? versioned : working;
}

/** Recompute conclusions from saved observations and the current reference.
 * This checks internal consistency, not the authenticity of a provider call.
 */
function assertBenchmarkCases(report, bindRunIdentity) {
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
    const rows = new Map(saved.criteria.map((row) => [row?.criterion_id, row]));
    assert(rows.size === checklist.criteria.length);
    const criteria = {};
    let recordedInvalidProof = false;
    for (const criterion of checklist.criteria) {
      const row = rows.get(criterion.id), expected = reference.expected[criterion.id];
      assert(row && row.expected === expected.value && same(row.reference_evidence_turns, expected.evidence_turns) && row.grounding === expected.grounding);
      assert(typeof row.valid === 'boolean' && typeof row.match === 'boolean' && typeof row.evidence_valid === 'boolean');
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
      };
    }
    const failed = saved.source_status === null || saved.source_status === 'error';
    if (bindRunIdentity && report.run.mode === 'live' && !failed) assert(saved.provider === report.run.provider && saved.model === report.run.model && saved.prompt_version === report.run.prompt_version);
    const observed = { duration_ms: saved.duration_ms, cost_usd: saved.cost_usd, usage: saved.usage, timing: { http_attempts: saved.http_attempts } };
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
  }
}

function inspectBenchmark({ root = cfg.ROOT } = {}) {
  const location = benchmarkReportPath(root);
  if (!fs.existsSync(location)) return { state: 'not_run', message: 'Живой прогон контрольных примеров ещё не выполнен' };
  try {
    const report = JSON.parse(fs.readFileSync(location, 'utf8'));
    if (report.kind !== 'engineering_reference_benchmark' || report.provenance !== 'engineering_reference' || !Array.isArray(report.cases) || report.cases.length !== fixture.cases.length || new Set(report.cases.map((row) => row.case_id)).size !== fixture.cases.length || report.cases.some((row) => !fixture.cases.some((reference) => reference.id === row.case_id))) throw new Error('Invalid benchmark report');
    const currentReference = report.dataset?.digest === digest(fixture) && report.checklist?.digest === digest(checklist);
    const current = currentReference && report.run.prompt_version === PROMPT_VERSION && report.run.provider === cfg.provider && report.run.model === cfg.model && !!report.run.settings_fingerprint && digest(report.run.settings_fingerprint) === digest(settingsFingerprint());
    if (currentReference) assertBenchmarkCases(report, current);
    const metrics = aggregateBenchmark(report.cases);
    if (digest(metrics) !== digest(report.metrics)) throw new Error('Report metrics do not match case results');
    const live = report.run.mode === 'live' && report.run.provider !== 'mock';
    return {
      state: !live ? 'unverified_run' : !current ? 'stale' : 'measured',
      message: !live ? 'Отчёт не подтверждён живым прогоном' : !current ? 'Настройки, правила или примеры изменились после прогона' : 'Измерено совпадение с синтетическими контрольными примерами',
      model: report.run.model, provider: report.run.provider, generated_at: report.generated_at,
      independent_expert_validation: false, case_count: report.cases.length,
      metrics, limitations: fixture.limitations,
    };
  } catch (_) { return { state: 'blocked', message: 'Отчёт повреждён или его метрики не соответствуют результатам' }; }
}

function getReadiness({ root = cfg.ROOT } = {}) {
  return {
    generated_at: new Date().toISOString(),
    benchmark: inspectBenchmark({ root }),
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

module.exports = { getReadiness, inspectBenchmark, benchmarkReportPath };

'use strict';
// Engineering reference measurements. No model calls, storage or environment access here.
const crypto = require('crypto');
const defaultChecklist = require('./default-checklist.json');
const { computeScore, validateAnswer } = require('./scoring');

const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const ratio = (n, d) => d ? n / d : null;
const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
const own = (value, key) => value != null && Object.prototype.hasOwnProperty.call(value, key);

/** Coverage describes the reference, never a measured model success rate. */
function referenceCoverage(fixture, checklist = defaultChecklist) {
  const cases = Array.isArray(fixture?.cases) ? fixture.cases : [];
  const languages = {}, channels = {}, distribution = {}, critical = {};
  let turns = 0, maxTurns = 0, requestCharacters = 0;
  for (const reference of cases) {
    const record = reference.record || {}, language = record.language;
    languages[language] = (languages[language] || 0) + 1;
    channels[record.channel] = (channels[record.channel] || 0) + 1;
    const count = record.transcript?.length || 0;
    turns += count; maxTurns = Math.max(maxTurns, count);
    requestCharacters += JSON.stringify({ checklist, transcript: record.transcript }).length;
    for (const criterion of checklist.criteria) {
      distribution[criterion.id] ||= {};
      const value = reference.expected?.[criterion.id]?.value;
      const label = value === null ? 'NA' : String(value);
      distribution[criterion.id][label] = (distribution[criterion.id][label] || 0) + 1;
    }
    critical[language] ||= { positive: 0, negative: 0, types: {} };
    if (reference.expected?.c08?.value === true) {
      critical[language].positive++;
      for (const type of ['insult', 'private-paid', 'confidential-disclosure']) if (reference.tags?.includes(type)) critical[language].types[type] = (critical[language].types[type] || 0) + 1;
    } else critical[language].negative++;
  }
  return { cases: cases.length, labels: cases.length * checklist.criteria.length, languages, channels, label_distribution: distribution, critical_by_language: critical, source_turns: turns, max_source_turns: maxTurns, request_characters_without_system_prompt: requestCharacters, measured: false };
}

function coverageErrors(fixture) {
  const requirements = fixture?.coverage_requirements;
  if (!requirements) return [];
  const errors = [];
  for (const language of requirements.languages || []) {
    const cases = fixture.cases.filter((reference) => reference?.record?.language === language);
    if (!cases.length) errors.push(`coverage: no ${language} cases`);
    for (const [key, field] of [['discovery_values', 'c02'], ['identification_values', 'c03'], ['consultation_values', 'c04'], ['dialogue_values', 'c06']]) {
      for (const value of requirements[key] || []) if (!cases.some((reference) => reference.expected?.[field]?.value === value)) errors.push(`coverage: ${language} ${field}=${value} missing`);
    }
    for (const type of requirements.critical_positive_types_per_language || []) if (!cases.some((reference) => reference.expected?.c08?.value === true && reference.tags?.includes(type))) errors.push(`coverage: ${language} critical ${type} missing`);
    if (cases.filter((reference) => reference.record.channel === 'voice call' && reference.tags?.includes('synthetic-voice-like')).length < (requirements.synthetic_voice_like_per_language || 0)) errors.push(`coverage: ${language} synthetic voice-like case missing`);
  }
  return errors;
}

function referenceAnswer(criterion, value) {
  if (value === null) return { answer: 'NA', value: null };
  if (criterion.type === 'scale') return { answer: 'SCORE', value };
  return { answer: value ? 'YES' : 'NO', value: null };
}

function validateBenchmarkCases(fixture, checklist = defaultChecklist) {
  const errors = [];
  if (!fixture || fixture.provenance !== 'engineering_reference') errors.push('provenance must be engineering_reference');
  const cases = fixture && fixture.cases;
  if (!Array.isArray(cases) || !cases.length) return [...errors, 'cases must be a nonempty array'];
  const ids = new Set(), conversations = new Set();
  for (const c of cases) {
    const id = c && c.id;
    const fail = (message) => errors.push(`${id || '?'}: ${message}`);
    if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) fail('invalid case id');
    if (ids.has(id)) fail('duplicate case id');
    ids.add(id);
    if (!c || !String(c.title || '').trim()) fail('title is required');
    const record = c && c.record;
    if (!record || !['RU', 'KZ', 'EN'].includes(record.language)) fail('language must be RU/KZ/EN');
    if (!record || !['agent chat', 'voice call'].includes(record.channel)) fail('channel must be agent chat or voice call');
    if (!record || typeof record.conversation_id !== 'string' || !record.conversation_id) fail('conversation_id is required');
    if (record && conversations.has(record.conversation_id)) fail('duplicate conversation_id');
    if (record) conversations.add(record.conversation_id);
    const transcript = record && record.transcript;
    if (!Array.isArray(transcript) || !transcript.length) fail('transcript is required');
    for (const [i, turn] of (Array.isArray(transcript) ? transcript : []).entries()) {
      if (!turn || !['client', 'operator', 'bot', 'system'].includes(turn.speaker) || typeof turn.text !== 'string' || !turn.text.trim() || typeof turn.timestamp !== 'string') fail(`invalid turn ${i + 1}`);
    }
    const expected = c && c.expected;
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) { fail('expected is required'); continue; }
    for (const key of Object.keys(expected)) if (!checklist.criteria.some((criterion) => criterion.id === key)) fail(`unknown expected criterion ${key}`);
    for (const criterion of checklist.criteria) {
      const e = expected[criterion.id];
      if (!e || !own(e, 'value')) { fail(`missing ${criterion.id}`); continue; }
      const validType = e.value === null ? criterion.na_allowed : criterion.type === 'scale' ? finite(e.value) : typeof e.value === 'boolean';
      if (!validType) fail(`${criterion.id}: invalid reference value type or prohibited NA`);
      else { try { validateAnswer(criterion, referenceAnswer(criterion, e.value)); } catch { fail(`${criterion.id}: invalid reference value`); } }
      if (typeof e.grounding !== 'string' || !e.grounding.trim()) fail(`${criterion.id}: grounding is required`);
      if (!Array.isArray(e.evidence_turns) || !e.evidence_turns.length || e.evidence_turns.some((n) => !Number.isInteger(n) || n < 1 || n > (transcript || []).length)) fail(`${criterion.id}: invalid reference evidence_turns`);
    }
  }
  return errors.concat(coverageErrors(fixture));
}

function evidenceErrors(raw, criterion, record) {
  if (!raw) return ['missing criterion'];
  const errors = [], tr = record.transcript;
  const validIndex = (index) => Number.isInteger(index) && index >= 0 && index < tr.length;
  if (typeof raw.explanation !== 'string' || !raw.explanation.trim()) errors.push('missing explanation');
  const evidence = Array.isArray(raw.evidence) ? raw.evidence : [];
  for (const e of evidence) {
    if (!e || !validIndex(e.msg)) errors.push('evidence turn out of bounds');
    else if (e.fragment != null && (typeof e.fragment !== 'string' || !norm(tr[e.msg].text).includes(norm(e.fragment)))) errors.push('evidence quote is not in source turn');
  }
  const validRanges = {};
  for (const key of ['missing_range', 'checked_range']) {
    const range = raw[key];
    if (range == null) continue;
    validRanges[key] = validIndex(range.from) && validIndex(range.to) && range.from <= range.to;
    if (!validRanges[key]) errors.push(`${key} out of bounds`);
  }
  const hasEvidence = evidence.some((e) => e && validIndex(e.msg));
  if (raw.answer === 'NA' && (typeof raw.na_reason !== 'string' || !raw.na_reason.trim())) errors.push('NA has no reason');
  const rangeKey = raw.answer === 'NO' && criterion.type !== 'flag' ? 'missing_range' : 'checked_range';
  if (!hasEvidence && !validRanges[rangeKey]) errors.push('no evidence or applicable source range');
  return errors;
}

/** Compare original model answers, never appealed final_criteria. Failures keep all expected rows. */
function compareEvaluation(reference, evaluation, checklist = defaultChecklist, failure = null) {
  const expectedAnswers = {}, actualAnswers = {}, rows = [];
  const failed = !evaluation || evaluation.status === 'error';
  for (const criterion of checklist.criteria) {
    const expected = reference.expected[criterion.id].value;
    expectedAnswers[criterion.id] = referenceAnswer(criterion, expected);
    const raw = !failed && evaluation.criteria && evaluation.criteria[criterion.id];
    let actual = null, valid = false, invalidReason = null;
    try {
      if (!raw || raw.answer === 'INVALID') throw new Error('missing or INVALID answer');
      const answer = validateAnswer(criterion, raw);
      actual = answer.answer === 'NA' ? null : answer.answer === 'SCORE' ? answer.value : answer.answer === 'YES';
      actualAnswers[criterion.id] = answer;
      valid = true;
    } catch { invalidReason = failed ? 'evaluation failed' : 'missing or invalid answer'; actualAnswers[criterion.id] = { answer: 'INVALID', value: null }; }
    const evidence = failed ? ['evaluation failed'] : evidenceErrors(raw, criterion, reference.record);
    const validTurn = (n) => Number.isInteger(n) && n >= 0 && n < reference.record.transcript.length;
    const observedEvidence = (raw && Array.isArray(raw.evidence) ? raw.evidence : []).filter((e) => e && validTurn(e.msg));
    const observedRange = (range) => range && validTurn(range.from) && validTurn(range.to) && range.from <= range.to ? { from: range.from + 1, to: range.to + 1 } : null;
    rows.push({
      criterion_id: criterion.id, expected, actual, valid, match: valid && actual === expected, invalid_reason: invalidReason,
      grounding: reference.expected[criterion.id].grounding, reference_evidence_turns: reference.expected[criterion.id].evidence_turns,
      observed_rationale: raw && typeof raw.explanation === 'string' ? raw.explanation : null,
      observed_evidence_turns: [...new Set(observedEvidence.map((e) => e.msg + 1))],
      observed_evidence: observedEvidence.map((e) => ({ turn: e.msg + 1, fragment: typeof e.fragment === 'string' ? e.fragment : null })),
      observed_na_reason: raw && typeof raw.na_reason === 'string' ? raw.na_reason : null,
      observed_unverified_claims: raw && Array.isArray(raw.unverified_claims) ? raw.unverified_claims.filter((s) => typeof s === 'string') : [],
      observed_ranges: { missing: observedRange(raw && raw.missing_range), checked: observedRange(raw && raw.checked_range) },
      evidence_valid: !evidence.length, evidence_errors: evidence,
      review_required: !!raw?.review_required || (Array.isArray(raw?.issues) && raw.issues.length > 0),
      observed_issues: Array.isArray(raw?.issues) ? raw.issues.filter((issue) => typeof issue === 'string') : [],
    });
  }
  const expectedScore = computeScore(checklist, expectedAnswers).total;
  const calculatedScore = computeScore(checklist, actualAnswers).total;
  const reportedScore = evaluation && evaluation.original_result && evaluation.original_result.total;
  const scoreConsistent = finite(reportedScore) && finite(calculatedScore) && Math.abs(reportedScore - calculatedScore) < 0.000001;
  const source = evaluation || failure || {};
  const billing = own(source, 'billing_complete') ? {
    billing_complete: source.billing_complete === true && finite(source.cost_usd) && !(source.unknown_call_count > 0),
    unknown_call_count: Number.isSafeInteger(source.unknown_call_count) && source.unknown_call_count >= 0 ? source.unknown_call_count : source.billing_complete === true ? 0 : 1,
    ...(source.unknown_call_count_is_upper_bound ? { unknown_call_count_is_upper_bound: true } : {}),
    known_usage: source.known_usage || null,
    known_cost_usd: finite(source.known_cost_usd) && source.known_cost_usd >= 0 ? source.known_cost_usd : finite(source.cost_usd) && source.cost_usd >= 0 ? source.cost_usd : 0,
  } : null;
  const failureStatus = source.error?.status ?? source.provider_status;
  const safeStatus = (typeof failureStatus === 'number' && Number.isInteger(failureStatus) && failureStatus >= 100 && failureStatus <= 599) || ['timeout', 'network', 'invalid_json', 'empty'].includes(failureStatus);
  const issues = Array.isArray(evaluation && evaluation.validation_errors) ? evaluation.validation_errors.length : 0;
  return {
    case_id: reference.id, title: reference.title, conversation_id: reference.record.conversation_id, language: reference.record.language,
    transcript: reference.record.transcript.map((turn, i) => ({ turn: i + 1, ...turn })),
    status: failed ? 'failed' : rows.some((row) => !row.valid || !row.evidence_valid || row.review_required) || issues || evaluation.status !== 'ok' || !scoreConsistent ? 'invalid' : 'completed',
    source_status: evaluation ? evaluation.status : null,
    // Raw provider error bodies are deliberately not copied into a public report.
    error: failed ? { code: String(source.code || source.error && source.error.code || 'EVALUATION_FAILED').replace(/[^A-Z0-9_-]/gi, '').slice(0, 80), ...(safeStatus ? { status: failureStatus } : {}) } : null,
    provider: evaluation && evaluation.provider || null, model: evaluation && evaluation.model || null, prompt_version: evaluation && evaluation.prompt_version || null,
    exact_match: rows.every((row) => row.match), mismatches: rows.filter((row) => !row.match).map((row) => row.criterion_id), criteria: rows,
    validation_error_count: issues,
    score: { expected: expectedScore, actual: finite(calculatedScore) ? calculatedScore : null, reported: finite(reportedScore) ? reportedScore : null, report_consistent: scoreConsistent, absolute_error: finite(calculatedScore) ? Math.abs(calculatedScore - expectedScore) : null },
    duration_ms: finite(source.duration_ms) && source.duration_ms >= 0 ? source.duration_ms : source.timing && finite(source.timing.total_ms) ? source.timing.total_ms : null,
    cost_usd: billing?.billing_complete === false ? null : finite(source.cost_usd) && source.cost_usd >= 0 ? source.cost_usd : null,
    ...(billing || {}),
    usage: source.usage ? { input: finite(source.usage.input) ? source.usage.input : null, output: finite(source.usage.output) ? source.usage.output : null, thoughts: finite(source.usage.thoughts) ? source.usage.thoughts : null } : null,
    http_attempts: source.timing && finite(source.timing.http_attempts) ? source.timing.http_attempts : null,
  };
}

function matchMetrics(rows) {
  const matched = rows.filter((row) => row.match).length;
  const valid = rows.filter((row) => row.valid).length;
  return { matched, total: rows.length, valid, invalid: rows.length - valid, rate: ratio(matched, rows.length), valid_only_rate: ratio(matched, valid) };
}

function confusion(rows, positive, requireValidatedEvidence = false) {
  const result = { tp: 0, tn: 0, fp: 0, fn: 0, unknown: 0, unknown_positive: 0, unknown_negative: 0, expected_positive: 0, expected_negative: 0 };
  for (const row of rows) {
    const expectedPositive = positive(row.expected);
    result[expectedPositive ? 'expected_positive' : 'expected_negative']++;
    if (!row.valid || (requireValidatedEvidence && (!row.evidence_valid || row.review_required))) { result.unknown++; result[expectedPositive ? 'unknown_positive' : 'unknown_negative']++; }
    else result[positive(row.actual) ? expectedPositive ? 'tp' : 'fp' : expectedPositive ? 'fn' : 'tn']++;
  }
  // Unknown positive references stay in recall denominator; failure cannot improve recall.
  result.precision_denominator = result.tp + result.fp;
  result.recall_denominator = result.expected_positive;
  result.precision = ratio(result.tp, result.precision_denominator);
  result.recall = ratio(result.tp, result.recall_denominator);
  result.total = rows.length;
  return result;
}

function aggregateBenchmark(comparisons) {
  const rows = comparisons.flatMap((c) => c.criteria);
  const byLanguage = {}, byCriterion = {};
  for (const language of ['RU', 'KZ', 'EN']) {
    const cases = comparisons.filter((c) => c.language === language);
    byLanguage[language] = { cases: cases.length, failed_cases: cases.filter((c) => c.status === 'failed').length, ...matchMetrics(cases.flatMap((c) => c.criteria)) };
  }
  for (const id of [...new Set(rows.map((row) => row.criterion_id))]) byCriterion[id] = matchMetrics(rows.filter((row) => row.criterion_id === id));
  const durations = comparisons.map((c) => c.duration_ms).filter(finite).sort((a, b) => a - b);
  const errors = comparisons.map((c) => c.score.absolute_error).filter(finite);
  const costs = comparisons.map((c) => c.cost_usd).filter(finite);
  const sum = (values) => values.reduce((a, b) => a + b, 0);
  const mean = (values) => values.length ? sum(values) / values.length : null;
  const percentile = (values, p) => values.length ? values[Math.max(0, Math.ceil(values.length * p) - 1)] : null;
  const evidenceValid = rows.filter((row) => row.evidence_valid).length;
  const naRows = rows.filter((row) => ['c02', 'c03', 'c04', 'c07'].includes(row.criterion_id));
  const explicitBilling = comparisons.some(comparison => own(comparison, 'billing_complete'));
  const unknownCalls = comparisons.reduce((count, comparison) => count + (Number.isSafeInteger(comparison.unknown_call_count) && comparison.unknown_call_count >= 0 ? comparison.unknown_call_count : comparison.cost_usd == null ? 1 : 0), 0);
  const billingComplete = costs.length === comparisons.length && unknownCalls === 0 && comparisons.every(comparison => comparison.billing_complete !== false);
  const knownCost = sum(comparisons.map(comparison => finite(comparison.known_cost_usd) ? comparison.known_cost_usd : finite(comparison.cost_usd) ? comparison.cost_usd : 0));
  return {
    cases: { total: comparisons.length, completed: comparisons.filter((c) => c.status === 'completed').length, invalid: comparisons.filter((c) => c.status === 'invalid').length, failed: comparisons.filter((c) => c.status === 'failed').length, exact: comparisons.filter((c) => c.exact_match).length, fully_valid_exact: comparisons.filter((c) => c.exact_match && c.status === 'completed').length },
    criterion_match: matchMetrics(rows), by_language: byLanguage, by_criterion: byCriterion,
    critical: confusion(rows.filter((row) => row.criterion_id === 'c08'), (value) => value === true, true),
    na: confusion(naRows, (value) => value === null),
    final_score: { compared: errors.length, missing: comparisons.length - errors.length, mean_absolute_error: mean(errors), max_absolute_error: errors.length ? Math.max(...errors) : null, inconsistent_reported: comparisons.filter((c) => c.status !== 'failed' && !c.score.report_consistent).length },
    evidence: { valid: evidenceValid, invalid: rows.length - evidenceValid, total: rows.length, rate: ratio(evidenceValid, rows.length) },
    timing: { observed_count: durations.length, missing_count: comparisons.length - durations.length, total_ms: sum(durations), mean_ms: mean(durations), p50_ms: percentile(durations, 0.5), p95_ms: percentile(durations, 0.95) },
    cost: explicitBilling ? { observed_count: costs.length, missing_count: comparisons.length - costs.length, total_usd: billingComplete ? sum(costs) : null, known_total_usd: knownCost, mean_per_observed_case_usd: mean(costs), complete: billingComplete, unknown_call_count: unknownCalls, ...(comparisons.some(c => c.unknown_call_count_is_upper_bound) ? { unknown_call_count_is_upper_bound: true } : {}), accounting_version: 'provider_usage_presence_v1' } : { observed_count: costs.length, missing_count: comparisons.length - costs.length, total_usd: sum(costs), mean_per_observed_case_usd: mean(costs), complete: costs.length === comparisons.length },
  };
}

function buildBenchmarkReport(fixture, outcomes, metadata = {}, checklist = defaultChecklist) {
  const errors = validateBenchmarkCases(fixture, checklist);
  if (errors.length) throw new Error(`Invalid benchmark fixture: ${errors.join('; ')}`);
  if (!Array.isArray(outcomes)) throw new Error('outcomes must be an array');
  const ids = new Set(fixture.cases.map((c) => c.id)), byId = new Map();
  for (const outcome of outcomes) {
    if (!outcome || !ids.has(outcome.case_id)) throw new Error('Unknown benchmark outcome case_id');
    if (byId.has(outcome.case_id)) throw new Error(`Duplicate benchmark outcome: ${outcome.case_id}`);
    byId.set(outcome.case_id, outcome);
  }
  const cases = fixture.cases.map((c) => { const outcome = byId.get(c.id); return compareEvaluation(c, outcome && outcome.evaluation, checklist, outcome); });
  const distribution = {};
  for (const criterion of checklist.criteria) {
    distribution[criterion.id] = {};
    for (const c of fixture.cases) {
      const value = c.expected[criterion.id].value, key = value === null ? 'NA' : String(value);
      distribution[criterion.id][key] = (distribution[criterion.id][key] || 0) + 1;
    }
  }
  return {
    schema_version: '1.0', kind: 'engineering_reference_benchmark', provenance: 'engineering_reference', generated_at: new Date().toISOString(),
    dataset: { name: fixture.name, version: fixture.version, suite: fixture.suite || 'regression', case_count: fixture.cases.length, languages: Object.fromEntries(['RU', 'KZ', 'EN'].map((language) => [language, fixture.cases.filter((c) => c.record.language === language).length])), digest: digest(fixture), independent_expert_validation: false, limitations: fixture.limitations || null, label_distribution: distribution },
    coverage: referenceCoverage(fixture, checklist),
    checklist: { id: checklist.id, version: checklist.version, digest: digest(checklist) },
    run: metadata, metrics: aggregateBenchmark(cases), cases,
  };
}

module.exports = { validateBenchmarkCases, compareEvaluation, aggregateBenchmark, buildBenchmarkReport, referenceCoverage, evidenceErrors, digest };

'use strict';
// Failed model attempts are submission evidence too; keep them apart from scored
// evaluations so an unavailable provider cannot produce an invented QA score.
const crypto = require('node:crypto');
const cfg = require('./config');
const checklistHash = (checklist) =>
  crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        name: checklist.name,
        notes: checklist.notes || '',
        rounding: checklist.rounding,
        sections: checklist.sections || [],
        criteria: checklist.criteria,
      }),
    )
    .digest('hex')
    .slice(0, 16);

function safeFailureMessage(error) {
  let message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Оценка завершилась ошибкой';
  message = message || 'Оценка завершилась ошибкой';
  for (const key of Object.values(cfg.keys))
    if (key) message = message.split(key).join('[REDACTED]');
  message = message
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[REDACTED]@')
    .replace(
      /((?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)["']?)\s*[:=]\s*["']?)[^\s"',;}]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /([?&](?:key|api_key|apikey|token|access_token|signature|sig|code)=)[^&\s"'<>]+/gi,
      '$1[REDACTED]',
    );
  return message.slice(0, 800);
}

/** Persist metadata of a real failed attempt using the provider/model actually configured. */
function saveEvaluationFailure(record, checklist, groupId, error, metadata = {}) {
  const store = require('./store');
  const failure = {
    id: metadata.id || `failure-${crypto.randomUUID()}`,
    group_id: groupId,
    conversation_id: record.conversation_id,
    channel: record.channel ?? null,
    language: record.language ?? null,
    transcript_hash: crypto
      .createHash('sha256')
      .update(JSON.stringify(record.transcript))
      .digest('hex')
      .slice(0, 16),
    checklist: { id: checklist.id, version: checklist.version },
    checklist_hash: checklistHash(checklist),
    provider: cfg.provider,
    model: cfg.model,
    status: 'error',
    validation_errors: [safeFailureMessage(error)],
    created_at: metadata.created_at || new Date().toISOString(),
  };
  if (typeof error?.status === 'string')
    failure.error_status = safeFailureMessage(error.status).slice(0, 80);
  else if (typeof error?.status === 'number' && Number.isFinite(error.status))
    failure.error_status = error.status;
  if (/^PROVIDER_(?:HTTP_[45][0-9]{2}|TIMEOUT|NETWORK|INVALID_JSON|EMPTY|ERROR)$/.test(error?.code || '')) failure.error_code = error.code;
  // A failed repair may follow a billed response. Retain the measured work even
  // when no scored evaluation can be produced; never invent unknown token usage.
  const metrics = error?.evaluation_metrics;
  if (metrics) {
    for (const field of [
      'usage',
      'cost_usd',
      'duration_ms',
      'timing',
      'samples',
      'successful_samples',
      'known_usage',
      'known_cost_usd',
      'billing_complete',
      'unknown_call_count',
    ]) {
      if (Object.prototype.hasOwnProperty.call(metrics, field))
        failure[field] =
          metrics[field] === null ? null : JSON.parse(JSON.stringify(metrics[field]));
    }
    for (const call of failure.timing?.calls || [])
      if (call.error) call.error = safeFailureMessage(call.error);
  }
  return store.write('failures', failure.id, failure);
}

/** Show only the latest failed attempt for a verifiably current source/rules.
 * A newer successful or reviewable analysis supersedes the failure indicator.
 */
function currentFailureSummaries(record, failures, evaluations, checklists) {
  const currentHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(record.transcript))
    .digest('hex')
    .slice(0, 16);
  const latest = new Map();
  for (const failure of failures) {
    const checklist = checklists.find((item) => item.id === failure.checklist?.id);
    if (
      !checklist ||
      failure.conversation_id !== record.conversation_id ||
      failure.transcript_hash !== currentHash ||
      failure.channel !== record.channel ||
      failure.language !== record.language ||
      failure.checklist.version !== checklist.version ||
      failure.checklist_hash !== checklistHash(checklist)
    )
      continue;
    const existing = latest.get(checklist.id);
    if (!existing || String(failure.created_at) > String(existing.created_at))
      latest.set(checklist.id, failure);
  }
  return [...latest.values()]
    .filter(
      (failure) =>
        !evaluations.some(
          (evaluation) =>
            evaluation.conversation_id === record.conversation_id &&
            evaluation.transcript_hash === currentHash &&
            evaluation.channel === record.channel &&
            evaluation.language === record.language &&
            evaluation.checklist?.id === failure.checklist.id &&
            evaluation.checklist.version === failure.checklist.version &&
            (evaluation.checklist.content_hash ||
              (evaluation.checklist_snapshot && checklistHash(evaluation.checklist_snapshot))) ===
              failure.checklist_hash &&
            ['ok', 'needs_review'].includes(evaluation.status) &&
            String(evaluation.created_at) >= String(failure.created_at),
        ),
    )
    .map((failure) => ({
      id: failure.id,
      group_id: failure.group_id,
      conversation_id: failure.conversation_id,
      status: 'error',
      created_at: failure.created_at,
      checklist: failure.checklist,
      reason: safeFailureMessage(failure.validation_errors?.[0] || 'Оценка завершилась ошибкой'),
      ...(failure.error_status != null ? { error_status: failure.error_status } : {}),
    }));
}

module.exports = { saveEvaluationFailure, safeFailureMessage, currentFailureSummaries };

'use strict';
// Failed model attempts are submission evidence too; keep them apart from scored
// evaluations so an unavailable provider cannot produce an invented QA score.
const crypto = require('node:crypto');
const cfg = require('./config');

function safeFailureMessage(error) {
  let message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Оценка завершилась ошибкой';
  message = message || 'Оценка завершилась ошибкой';
  for (const key of Object.values(cfg.keys)) if (key) message = message.split(key).join('[REDACTED]');
  message = message
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[REDACTED]@')
    .replace(/((?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)["']?)\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:key|api_key|apikey|token|access_token|signature|sig|code)=)[^&\s"'<>]+/gi, '$1[REDACTED]');
  return message.slice(0, 800);
}

/** Persist metadata of a real failed attempt using the provider/model actually configured. */
function saveEvaluationFailure(record, checklist, groupId, error) {
  const store = require('./store');
  const failure = {
    id: `failure-${crypto.randomUUID()}`,
    group_id: groupId,
    conversation_id: record.conversation_id,
    channel: record.channel ?? null,
    language: record.language ?? null,
    transcript_hash: crypto.createHash('sha256').update(JSON.stringify(record.transcript)).digest('hex').slice(0, 16),
    checklist: { id: checklist.id, version: checklist.version },
    provider: cfg.provider,
    model: cfg.model,
    status: 'error',
    validation_errors: [safeFailureMessage(error)],
    created_at: new Date().toISOString(),
  };
  if (typeof error?.status === 'string') failure.error_status = safeFailureMessage(error.status).slice(0, 80);
  else if (typeof error?.status === 'number' && Number.isFinite(error.status)) failure.error_status = error.status;
  // A failed repair may follow a billed response. Retain the measured work even
  // when no scored evaluation can be produced; never invent unknown token usage.
  const metrics = error?.evaluation_metrics;
  if (metrics) {
    for (const field of ['usage', 'cost_usd', 'duration_ms', 'timing', 'samples', 'successful_samples']) {
      if (metrics[field] != null) failure[field] = JSON.parse(JSON.stringify(metrics[field]));
    }
    for (const call of failure.timing?.calls || []) if (call.error) call.error = safeFailureMessage(call.error);
  }
  return store.write('failures', failure.id, failure);
}

module.exports = { saveEvaluationFailure, safeFailureMessage };

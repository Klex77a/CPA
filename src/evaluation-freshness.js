'use strict';
const crypto = require('node:crypto');

/** Whether a saved evaluation still describes the current source and checklist.
 * record_changed also covers an unverifiable/missing source: its evidence must
 * use the saved snapshot, never bind old message indices to a new transcript.
 * This check does not invalidate historical results or depend on model settings.
 */
function evaluationFreshness(evaluation, record, checklist) {
  const reasons = new Set();
  if (!evaluation || typeof evaluation !== 'object') reasons.add('unverifiable');

  if (!record) {
    reasons.add('source_missing');
  } else {
    if (!Array.isArray(record.transcript) || typeof evaluation?.transcript_hash !== 'string' || !/^[a-f0-9]{16}$/i.test(evaluation.transcript_hash)) {
      reasons.add('unverifiable');
    } else {
      const currentHash = crypto.createHash('sha256').update(JSON.stringify(record.transcript)).digest('hex').slice(0, 16);
      if (evaluation.transcript_hash.toLowerCase() !== currentHash) reasons.add('transcript');
    }
    if (evaluation && (evaluation.conversation_id !== record.conversation_id || evaluation.channel !== record.channel || evaluation.language !== record.language)) reasons.add('metadata');
  }

  if (!checklist || !evaluation?.checklist || evaluation.checklist.id !== checklist.id || evaluation.checklist.version !== checklist.version) reasons.add('checklist');
  const staleReasons = [...reasons];
  return {
    stale: staleReasons.length > 0,
    stale_reasons: staleReasons,
    record_changed: staleReasons.some((reason) => reason !== 'checklist'),
  };
}

module.exports = { evaluationFreshness };

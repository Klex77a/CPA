'use strict';
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-failures-'));
Object.assign(process.env, { CQA_DATA_DIR: dataDir, LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'test-key-never-use-123', LLM_MODEL: 'actual-test-model' });
const store = require('../src/store');
const { saveEvaluationFailure, safeFailureMessage, currentFailureSummaries } = require('../src/evaluation-failure');
const record = { conversation_id: 'same', transcript: [{ timestamp: '2026-11-07T10:00:00Z', speaker: 'client', text: 'Вопрос' }] };
const checklist = { id: 'default', version: 3 };
let providerCalls = 0;
global.fetch = async () => { providerCalls++; throw new Error('No provider calls are allowed'); };

try {
  const error = Object.assign(new Error('LLM HTTP 429: quota exceeded'), { status: 429 });
  const failure = saveEvaluationFailure(record, checklist, 'DEV', error);
  assert.deepStrictEqual(store.read('failures', failure.id), failure);
  assert.strictEqual(failure.status, 'error');
  assert.strictEqual(failure.group_id, 'DEV');
  assert.strictEqual(failure.conversation_id, record.conversation_id);
  assert.deepStrictEqual(failure.checklist, { id: 'default', version: 3 });
  assert.strictEqual(failure.provider, 'deepseek');
  assert.strictEqual(failure.model, 'actual-test-model');
  assert.strictEqual(failure.transcript_hash, crypto.createHash('sha256').update(JSON.stringify(record.transcript)).digest('hex').slice(0, 16));
  assert.strictEqual(failure.error_status, 429);
  assert.deepStrictEqual(failure.validation_errors, ['LLM HTTP 429: quota exceeded']);
  assert.ok(Number.isFinite(Date.parse(failure.created_at)));
  assert.ok(!('final_criteria' in failure));
  assert.strictEqual(store.list('evaluations').length, 0);
  console.log('✔ реальная ошибка сохраняет модель, версию, hash и причину без выдуманной оценки');

  const other = saveEvaluationFailure(record, checklist, 'OTHER', new Error('timeout'));
  assert.notStrictEqual(failure.id, other.id);
  assert.strictEqual(store.list('failures').length, 2);
  assert.strictEqual(store.read('failures', failure.id).group_id, 'DEV');
  console.log('✔ повторные ошибки и разные группы сохраняются отдельно');

  const secretMessage = 'Authorization: Bearer auth-secret; api test-key-never-use-123; https://example.com/a?sig=signed-value&token=token-value&key=key-value; sk-project-example';
  const safe = safeFailureMessage(new Error(secretMessage));
  for (const secret of ['auth-secret', 'test-key-never-use-123', 'signed-value', 'token-value', 'key-value', 'sk-project-example']) assert.ok(!safe.includes(secret));
  assert.ok(safe.includes('[REDACTED]'));
  assert.strictEqual(safeFailureMessage(null), 'Оценка завершилась ошибкой');
  assert.strictEqual(safeFailureMessage(new Error('x'.repeat(2000))).length, 800);
  console.log('✔ ошибки очищаются от ключей и подписей URL и ограничены по длине');

  assert.strictEqual(providerCalls, 0);
  const typed = { ...record, channel: 'agent chat', language: 'RU' };
  const rules = { ...checklist, name: 'Current rules', criteria: [{ id: 'one', type: 'binary', description: 'Current description' }] };
  const first = saveEvaluationFailure(typed, rules, 'DEV', new Error(secretMessage), { created_at: '2026-11-08T00:00:01Z' });
  const current = (failures, evaluations = [], source = typed, selected = rules) => currentFailureSummaries(source, failures, evaluations, [selected]);
  const summary = current([first]);
  assert.strictEqual(summary.length, 1); assert.strictEqual(summary[0].status, 'error');
  assert.strictEqual(summary[0].created_at, first.created_at); assert.deepStrictEqual(summary[0].checklist, checklist);
  assert.ok(!JSON.stringify(summary).includes('auth-secret')); assert.ok(!JSON.stringify(summary).includes('signed-value'));
  assert.ok(!('timing' in summary[0]) && !('transcript_hash' in summary[0]));
  const good = { ...first, id: 'good', status: 'ok', checklist: { ...first.checklist, content_hash: first.checklist_hash }, created_at: '2026-11-08T00:00:02Z' };
  assert.deepStrictEqual(current([first], [good]), []);
  const retry = saveEvaluationFailure(typed, rules, 'DEV', new Error('Latest timeout'), { created_at: '2026-11-08T00:00:03Z' });
  assert.strictEqual(current([first, retry], [good])[0].id, retry.id, 'a failed retry remains visible alongside the earlier good score');
  for (const source of [{ ...typed, language: 'KZ' }, { ...typed, channel: 'voice call' }, { ...typed, transcript: [{ ...typed.transcript[0], text: 'New source' }] }]) assert.deepStrictEqual(current([retry], [], source), []);
  for (const selected of [{ ...rules, version: 4 }, { ...rules, criteria: [{ ...rules.criteria[0], description: 'Changed without a version bump' }] }]) assert.deepStrictEqual(current([retry], [], typed, selected), []);
  assert.deepStrictEqual(current([{ ...retry, checklist_hash: undefined }]), [], 'unverifiable legacy failures must not be rebound to current rules');
  console.log('✔ сводка показывает только последнюю текущую ошибку, очищает секреты и скрывает её после более нового анализа');
  console.log('evaluation-failure: пройдено 4');
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

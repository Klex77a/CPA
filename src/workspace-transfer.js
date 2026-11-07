'use strict';
const { validateChecklist, validateAnswer } = require('./scoring');

const COLLECTIONS = ['datasets', 'checklists', 'evaluations', 'failures', 'appeals'];
const MAX_BYTES = 1024 * 1024;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && !!value.trim();
const date = (value) => text(value) && Number.isFinite(Date.parse(value));
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const canonical = (value) => JSON.stringify(value, (_key, item) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

function assertJSON(value, depth = 0, seen = new Set()) {
  if (depth > 80) fail('Слишком глубокая структура переноса.');
  if (value === null || ['string', 'boolean'].includes(typeof value) || finite(value)) return;
  if (typeof value !== 'object' || seen.has(value)) fail('Перенос допускает только конечные JSON-значения.');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Перенос допускает только JSON-объекты.');
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('Недопустимое свойство в данных переноса.');
    assertJSON(child, depth + 1, seen);
  }
  seen.delete(value);
}

function assertRecord(record) {
  if (!object(record) || !text(record.conversation_id) || !['agent chat', 'voice call'].includes(record.channel) || !['RU', 'KZ', 'EN'].includes(record.language) || !Array.isArray(record.transcript) || !record.transcript.length) fail('Некорректный исходный диалог при переносе.');
  if (record.transcript.some((turn) => !object(turn) || !['operator', 'client', 'bot', 'system'].includes(turn.speaker) || typeof turn.text !== 'string' || typeof turn.timestamp !== 'string')) fail('Некорректная реплика при переносе.');
  if (record.audio_url != null && typeof record.audio_url !== 'string') fail('Некорректная ссылка записи при переносе.');
}

function assertChecklist(checklist) {
  if (!object(checklist) || !text(checklist.id) || !Number.isSafeInteger(checklist.version) || checklist.version < 1 || validateChecklist(checklist).length) fail('Некорректный чек-лист при переносе.');
}

function assertAppeal(appeal) {
  if (!object(appeal) || !text(appeal.id) || !text(appeal.criterion_id) || !text(appeal.comment) || !date(appeal.created_at) || !['open', 'resolved'].includes(appeal.status) || !object(appeal.disputed)) fail('Некорректная апелляция при переносе.');
  if (appeal.status === 'resolved' && (!object(appeal.decision) || !['confirm', 'change'].includes(appeal.decision.action) || !text(appeal.decision.reason))) fail('Некорректное решение по апелляции при переносе.');
}

function assertAnswerMap(answers, checklist) {
  if (!object(answers)) fail('В оценке отсутствуют ответы критериев.');
  for (const criterion of checklist.criteria) {
    const answer = answers[criterion.id];
    if (!object(answer) || typeof answer.explanation !== 'string' || !Array.isArray(answer.evidence) || (answer.issues != null && (!Array.isArray(answer.issues) || answer.issues.some((item) => typeof item !== 'string')))) fail('Повреждён ответ критерия при переносе.');
    if (answer.evidence.some((item) => !object(item) || !Number.isInteger(item.msg) || item.msg < 0)) fail('Повреждены доказательства критерия при переносе.');
    if (answer.answer !== 'INVALID') {
      try { validateAnswer(criterion, answer); }
      catch (_) { fail('Недопустимый ответ критерия при переносе.'); }
    }
  }
}

function assertResult(result, checklist) {
  if (!object(result) || !(result.total === null || finite(result.total) && result.total >= 0 && result.total <= 100) || typeof result.gross_error !== 'boolean' || !Array.isArray(result.gross_error_criteria) || !Array.isArray(result.criteria) || result.criteria.length !== checklist.criteria.length || !Array.isArray(result.sections)) fail('Повреждён рассчитанный результат при переносе.');
  const seen = new Set();
  for (const row of result.criteria) {
    if (!object(row) || !checklist.criteria.some((criterion) => criterion.id === row.id) || seen.has(row.id) || typeof row.answer !== 'string' || typeof row.scored !== 'boolean' || !finite(row.weight) || !finite(row.raw)) fail('Повреждена строка расчёта при переносе.');
    seen.add(row.id);
  }
}

function assertEntry(entry) {
  if (!object(entry) || Object.keys(entry).some((key) => !['collection', 'id', 'value'].includes(key)) || !COLLECTIONS.includes(entry.collection) || !text(entry.id) || entry.id.length > 1000 || !object(entry.value)) fail('Некорректная запись переноса.');
  const value = entry.value;
  if (entry.id !== (entry.collection === 'datasets' ? value.group_id : value.id)) fail('ID записи не совпадает с содержимым.');
  if (entry.collection === 'datasets') {
    if (!Array.isArray(value.records) || value.total_records !== value.records.length || value.records.length > 10000) fail('Некорректный набор при переносе.');
    const ids = new Set();
    for (const record of value.records) {
      assertRecord(record);
      if (ids.has(record.conversation_id)) fail('Повторяющийся ID исходного диалога при переносе.');
      ids.add(record.conversation_id);
    }
  } else if (entry.collection === 'checklists') assertChecklist(value);
  else if (entry.collection === 'appeals') assertAppeal(value);
  else {
    if (!text(value.group_id) || !text(value.conversation_id) || !text(value.provider) || !text(value.model) || !date(value.created_at) || !object(value.checklist) || !text(value.checklist.id) || !Number.isSafeInteger(value.checklist.version) || value.checklist.version < 1 || !Array.isArray(value.validation_errors) || value.validation_errors.some((item) => typeof item !== 'string')) fail('Некорректные метаданные оценки при переносе.');
    if (value.cost_usd != null && (!finite(value.cost_usd) || value.cost_usd < 0)) fail('Некорректная стоимость при переносе.');
    if (entry.collection === 'failures') {
      if (value.status !== 'error') fail('Неудачная попытка должна иметь status:error.');
    } else {
      if (!['ok', 'needs_review'].includes(value.status) || !Array.isArray(value.appeals) || (value.coaching != null && (!Array.isArray(value.coaching) || value.coaching.some((item) => !object(item) || typeof item.text !== 'string')))) fail('Повреждена оценка при переносе.');
      assertChecklist(value.checklist_snapshot);
      if (value.checklist_snapshot.id !== value.checklist.id || value.checklist_snapshot.version !== value.checklist.version) fail('Версия снимка чек-листа не совпадает с оценкой.');
      if (value.global_validation_errors != null && (!Array.isArray(value.global_validation_errors) || value.global_validation_errors.some((item) => typeof item !== 'string'))) fail('Повреждён список ошибок проверки.');
      for (const list of [value.coaching, value.original_coaching].filter((item) => item != null)) {
        if (!Array.isArray(list) || list.some((item) => !object(item) || !['required', 'optional'].includes(item.type) || typeof item.text !== 'string' || !value.checklist_snapshot.criteria.some((criterion) => criterion.id === item.criterion_id))) fail('Повреждены рекомендации при переносе.');
      }
      assertAnswerMap(value.criteria, value.checklist_snapshot);
      assertAnswerMap(value.final_criteria, value.checklist_snapshot);
      assertResult(value.original_result, value.checklist_snapshot);
      assertResult(value.final_result, value.checklist_snapshot);
      for (const appeal of value.appeals) assertAppeal(appeal);
      if (value.record_snapshot != null) {
        assertRecord(value.record_snapshot);
        if (value.record_snapshot.conversation_id !== value.conversation_id) fail('Снимок исходного диалога имеет другой ID.');
      }
    }
  }
}

/** Validate the complete chunk before writes. The cloud transaction boundary
 * provides atomic persistence if the database fails during the write phase.
 */
function importEntries(input, dependencies = {}) {
  if (!object(input) || Object.keys(input).some((key) => !['entries', 'replace'].includes(key)) || !Array.isArray(input.entries) || !input.entries.length || input.entries.length > 1000 || (input.replace !== undefined && typeof input.replace !== 'boolean')) fail('Ожидается пакет от 1 до 1000 записей и булев replace.');
  assertJSON(input);
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_BYTES) fail('Пакет переноса превышает 1 МиБ.', 413);
  const store = dependencies.store || require('./store');
  const seen = new Set(), pending = [];
  const summary = { total: input.entries.length, imported: 0, replaced: 0, skipped: 0, counts: Object.fromEntries(COLLECTIONS.map((name) => [name, 0])) };
  for (const entry of input.entries) {
    assertEntry(entry);
    const key = JSON.stringify([entry.collection, entry.id]);
    if (seen.has(key)) fail('Пакет содержит повторяющийся ID записи.');
    seen.add(key);
    const existing = store.read(entry.collection, entry.id);
    if (existing != null && canonical(existing) === canonical(entry.value)) summary.skipped++;
    else {
      if (existing != null && !input.replace) fail('Запись уже существует с другим содержимым. Требуется явный replace.', 409);
      pending.push(entry);
      summary[existing == null ? 'imported' : 'replaced']++;
    }
    summary.counts[entry.collection]++;
  }
  for (const entry of pending) store.write(entry.collection, entry.id, JSON.parse(JSON.stringify(entry.value)));
  return summary;
}

function exportEntries(store = require('./store')) {
  return COLLECTIONS.flatMap((collection) => store.list(collection).map((value) => ({ collection, id: collection === 'datasets' ? value.group_id : value.id, value })));
}

/** Split at UTF-8 byte boundaries without changing individual stored documents. */
function chunkEntries(entries, { replace = false, maxBytes = MAX_BYTES - 1024 } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 100 || maxBytes > MAX_BYTES) fail('Некорректный размер пакета переноса.');
  const chunks = [];
  let current = [];
  for (const entry of entries) {
    const candidate = [...current, entry];
    if (candidate.length > 1000 || Buffer.byteLength(JSON.stringify({ entries: candidate, replace }), 'utf8') > maxBytes) {
      if (!current.length) fail('Одна запись превышает размер пакета; перенесите её отдельно другим способом.', 413);
      chunks.push(current); current = [entry];
      if (Buffer.byteLength(JSON.stringify({ entries: current, replace }), 'utf8') > maxBytes) fail('Одна запись превышает размер пакета; перенесите её отдельно другим способом.', 413);
    } else current = candidate;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

module.exports = { COLLECTIONS, MAX_BYTES, importEntries, exportEntries, chunkEntries };

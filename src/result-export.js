'use strict';
/** Official submission contract, independent of the editable checklist/UI format. */
const crypto = require('crypto');
const { computeScore, validateAnswer } = require('./scoring');
const officialChecklist = require('./default-checklist.json');

const CRITERION_IDS = ['contact', 'discovery', 'identification', 'consultation', 'empathy', 'dialogue', 'closure', 'critical'];
const SPLIT_COUNTS = { dev: 65, prod: 10 };
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const problem = (message, status = 422) => Object.assign(new Error(message), { status });
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function sourceProblems(records) {
  if (!Array.isArray(records)) return ['Исходные records должны быть массивом диалогов.'];
  const errors = [], seen = new Set();
  records.forEach((record, index) => {
    if (!isObject(record)) { errors.push(`Исходный диалог ${index + 1} должен быть объектом.`); return; }
    const id = record.conversation_id;
    if (typeof id !== 'string' || !id.trim()) errors.push(`Исходный диалог ${index + 1}: нужен непустой conversation_id.`);
    else if (seen.has(id)) errors.push(`Исходный набор содержит повторяющийся conversation_id: ${id}.`);
    else seen.add(id);
    if (!Array.isArray(record.transcript) || !record.transcript.length || record.transcript.some((turn) => !isObject(turn))) errors.push(`Исходный диалог ${index + 1}: transcript должен быть непустым массивом реплик.`);
  });
  return errors;
}

function assertOfficialChecklist(checklist) {
  if (!isObject(checklist) || !Array.isArray(checklist.criteria) || checklist.criteria.length !== 8 || checklist.criteria.some((criterion) => !isObject(criterion)) || checklist.rounding !== 2) throw problem('Для сдачи нужен исходный чек-лист из 8 критериев с округлением до двух знаков.');
  for (const expected of officialChecklist.criteria) {
    const actual = checklist.criteria.find((c) => c.id === expected.id);
    const scale = (c) => (c.scale || []).map((s) => s.value).sort((a, b) => a - b);
    const validScale = actual && (actual.scale == null || (Array.isArray(actual.scale) && actual.scale.every((step) => isObject(step) && typeof step.value === 'number' && Number.isFinite(step.value) && typeof step.description === 'string')));
    if (!actual || !validScale || actual.type !== expected.type || actual.weight !== expected.weight || !!actual.na_allowed !== !!expected.na_allowed || JSON.stringify(scale(actual)) !== JSON.stringify(scale(expected)) || ['title', 'description', 'na_condition'].some((field) => (actual[field] || '') !== (expected[field] || '')) || (actual.scale || []).some((step) => step.description !== (expected.scale || []).find((item) => item.value === step.value)?.description)) {
      throw problem(`Критерий ${expected.id} изменён: официальный JSON требует определение, тип, вес, N/A и шкалу из выданного чек-листа. Для изменённого чек-листа используйте CSV.`);
    }
  }
}

function evidenceTurns(answer, count) {
  if (!Number.isInteger(count) || count < 1) throw problem('Нет корректного исходного транскрипта для доказательств.');
  if (!isObject(answer) || (answer.evidence != null && !Array.isArray(answer.evidence))) throw problem('Доказательства критерия должны быть массивом реплик.');
  const turns = new Set();
  const add = (index) => {
    if (!Number.isInteger(index) || index < 0 || index >= count) throw problem('Доказательство ссылается на отсутствующую реплику.');
    turns.add(index + 1);
  };
  for (const item of answer.evidence || []) add(item?.msg);
  for (const range of [answer.missing_range, answer.checked_range]) {
    if (!range) continue;
    if (!Number.isInteger(range.from) || !Number.isInteger(range.to) || range.from > range.to || range.to >= count || range.from < 0) throw problem('Некорректный проверенный участок разговора.');
    for (let index = range.from; index <= range.to; index++) add(index);
  }
  if (!turns.size) throw problem('Нет подтверждающих реплик или проверенного участка.');
  return [...turns].sort((a, b) => a - b);
}

function exportEvaluation(record, evaluation) {
  const errorResult = (error) => ({ conversation_id: record.conversation_id, status: 'error', criteria: [], score: null, error });
  if (!evaluation) return errorResult('Для текущего транскрипта и версии чек-листа нет результата. Запустите оценку.');
  if (evaluation.status !== 'ok') return errorResult((Array.isArray(evaluation.validation_errors) ? evaluation.validation_errors.filter((error) => typeof error === 'string') : []).join('; ') || 'Результат требует проверки человеком.');
  try {
    if (evaluation.checklist_snapshot != null) assertOfficialChecklist(evaluation.checklist_snapshot);
    if (evaluation.global_validation_errors != null && (!Array.isArray(evaluation.global_validation_errors) || evaluation.global_validation_errors.length)) throw problem('Структура ответа модели требует проверки человеком.');
    if (!isObject(evaluation.final_criteria)) throw problem('Нет объекта final_criteria.');
    const criteria = officialChecklist.criteria.map((criterion, index) => {
      const answer = evaluation.final_criteria[criterion.id];
      if (!isObject(answer)) throw problem(`Нет корректного ответа ${criterion.id}.`);
      if (answer.review_required || (answer.issues != null && (!Array.isArray(answer.issues) || answer.issues.length))) throw problem(`Ответ ${criterion.id} требует проверки человеком.`);
      const valid = validateAnswer(criterion, answer);
      const text = answer.reviewer_reason || answer.explanation;
      const rationale = typeof text === 'string' ? text.trim() : '';
      if (!rationale) throw problem(`Нет обоснования ${criterion.id}.`);
      return {
        criterion_id: CRITERION_IDS[index],
        value: valid.answer === 'NA' ? null : valid.answer === 'SCORE' ? valid.value : valid.answer === 'YES',
        rationale,
        evidence_turns: evidenceTurns(answer, record.transcript.length),
      };
    });
    const result = computeScore(officialChecklist, evaluation.final_criteria);
    if (result.total == null) throw problem('Итоговая оценка не рассчитана.');
    return { conversation_id: record.conversation_id, status: 'ok', criteria, score: { final_score: result.total, critical_flag: result.gross_error } };
  } catch (error) {
    return errorResult(`Некорректный результат: ${error.message}`);
  }
}

/** Every source ID is exported once, including unprocessed or failed conversations. */
function buildSubmission(input) {
  if (!isObject(input)) throw problem('Ожидаются параметры подготовки JSON.', 400);
  const { dataset, checklist, evaluations, teamName, split } = input;
  const name = typeof teamName === 'string' ? teamName.trim() : '';
  if (!name || name.length > 120) throw problem('Укажите название команды (до 120 символов).', 400);
  const count = typeof split === 'string' && Object.hasOwn(SPLIT_COUNTS, split) ? SPLIT_COUNTS[split] : null;
  if (!count) throw problem('Выберите набор dev или prod.', 400);
  if (!isObject(dataset) || !Array.isArray(dataset.records) || dataset.records.length !== count) throw problem(`Для ${split.toUpperCase()} нужно ровно ${count} диалогов; в наборе ${Array.isArray(dataset?.records) ? dataset.records.length : 0}.`);
  const invalidSource = sourceProblems(dataset.records);
  if (invalidSource.length) throw problem(invalidSource.join('; '));
  if (!Array.isArray(evaluations)) throw problem('Оценки должны быть массивом результатов модели.');
  assertOfficialChecklist(checklist);
  const selected = dataset.records.map((record) => {
    const candidates = evaluations.filter((ev) => isObject(ev) && ev.group_id === dataset.group_id && ev.conversation_id === record.conversation_id && ev.checklist?.id === checklist.id && ev.checklist?.version === checklist.version && ev.transcript_hash === hash(record.transcript) && (ev.status === 'error' || (ev.channel === record.channel && ev.language === record.language)));
    if (candidates.some((ev) => typeof ev.created_at !== 'string' || !Number.isFinite(Date.parse(ev.created_at)) || typeof ev.provider !== 'string' || !ev.provider.trim() || typeof ev.model !== 'string' || !ev.model.trim())) throw problem(`Некорректные метаданные оценки ${record.conversation_id}: нужны created_at, provider и model.`);
    return candidates.sort((a, b) => Number(a.provider === 'mock') - Number(b.provider === 'mock') || Number(a.status === 'error') - Number(b.status === 'error') || b.created_at.localeCompare(a.created_at))[0] || null;
  });
  if (selected.some((ev) => ev?.provider === 'mock')) throw problem('Демо-оценки по ключевым словам нельзя сдавать как результат ИИ. Запустите оценку с настоящей моделью.', 409);
  const models = [...new Set(selected.filter(Boolean).map((ev) => `${ev.provider} / ${ev.model}`))];
  if (!models.length) throw problem('Нет результатов настоящей модели. Демо-режим предназначен для проверки интерфейса.', 409);
  const output = {
    schema_version: '1.0', team_name: name,
    model: { mode: 'external_api', name: models.join(', ') },
    results: dataset.records.map((record, index) => exportEvaluation(record, selected[index])),
  };
  const errors = validateSubmission(output, { split, records: dataset.records });
  if (errors.length) throw problem(errors.join('; '));
  return output;
}

/** Validate a saved file before Git submission, including independent score recomputation. */
function validateSubmission(output, options = {}) {
  const errors = [];
  if (!isObject(output)) return ['Ожидается JSON-объект.'];
  if (!isObject(options)) return ['Параметры проверки должны быть объектом.'];
  const { split, records } = options;
  if (output.schema_version !== '1.0') errors.push('schema_version должен быть "1.0".');
  if (typeof output.team_name !== 'string' || !output.team_name.trim()) errors.push('Нет team_name.');
  if (!['local', 'external_api', 'hybrid'].includes(output.model?.mode) || typeof output.model?.name !== 'string' || !output.model.name.trim()) errors.push('Некорректные model.mode/model.name.');
  if (!Array.isArray(output.results)) return [...errors, 'Нет массива results.'];
  if (!output.results.length) errors.push('Массив results не должен быть пустым.');
  if (split !== undefined && !['dev', 'prod'].includes(split)) errors.push('split должен быть dev или prod.');
  const expected = typeof split === 'string' && Object.hasOwn(SPLIT_COUNTS, split) ? SPLIT_COUNTS[split] : null;
  if (expected && output.results.length !== expected) errors.push(`Нужно ${expected} записей, получено ${output.results.length}.`);
  const seen = new Set();
  const invalidSource = records === undefined ? [] : sourceProblems(records);
  errors.push(...invalidSource);
  const source = records !== undefined && !invalidSource.length ? new Map(records.map((record) => [record.conversation_id, record])) : null;
  for (const result of output.results) {
    if (!isObject(result)) { errors.push('Запись результата должна быть объектом.'); continue; }
    const prefix = typeof result.conversation_id === 'string' && result.conversation_id.trim() ? result.conversation_id : '(без ID)';
    const add = (text) => errors.push(`${prefix}: ${text}`);
    if (typeof result.conversation_id !== 'string' || !result.conversation_id.trim()) add('нужен исходный conversation_id.');
    if (seen.has(result.conversation_id)) add('повторяющийся ID.');
    seen.add(result.conversation_id);
    if (source && !source.has(result.conversation_id)) add('ID отсутствует в исходном наборе.');
    if (result.status === 'error') {
      if (!Array.isArray(result.criteria) || result.criteria.length || result.score !== null || typeof result.error !== 'string' || !result.error.trim()) add('ошибка должна содержать criteria:[], score:null и причину error.');
      continue;
    }
    if (result.status !== 'ok') { add('status должен быть ok или error.'); continue; }
    if (!Array.isArray(result.criteria) || result.criteria.length !== 8) { add('нужно ровно 8 критериев.'); continue; }
    const answers = {};
    const criterionIds = new Set();
    for (const row of result.criteria) {
      const index = CRITERION_IDS.indexOf(row?.criterion_id);
      if (index < 0 || criterionIds.has(row?.criterion_id)) { add('неизвестный или повторяющийся criterion_id.'); continue; }
      criterionIds.add(row.criterion_id);
      const criterion = officialChecklist.criteria[index];
      const value = row.value;
      const validType = value === null ? criterion.na_allowed : criterion.type === 'scale' ? typeof value === 'number' && criterion.scale.some((s) => s.value === value) : typeof value === 'boolean';
      if (!validType) { add(`${row.criterion_id}: недопустимый value.`); continue; }
      answers[criterion.id] = { answer: value === null ? 'NA' : criterion.type === 'scale' ? 'SCORE' : value ? 'YES' : 'NO', value: typeof value === 'number' ? value : null };
      if (typeof row.rationale !== 'string' || !row.rationale.trim()) add(`${row.criterion_id}: нет rationale.`);
      const limit = source?.get(result.conversation_id)?.transcript?.length;
      if (!Array.isArray(row.evidence_turns) || !row.evidence_turns.length || row.evidence_turns.some((turn) => !Number.isInteger(turn) || turn < 1 || (limit !== undefined && turn > limit)) || new Set(row.evidence_turns).size !== row.evidence_turns.length) add(`${row.criterion_id}: некорректные evidence_turns (нумерация с 1).`);
    }
    if (Object.keys(answers).length === 8) {
      const score = computeScore(officialChecklist, answers);
      if (!result.score || result.score.final_score !== score.total || result.score.critical_flag !== score.gross_error) add('score не соответствует ответам, весам, N/A или critical.');
    }
  }
  if (source) for (const id of source.keys()) if (!seen.has(id)) errors.push(`${id}: нет результата исходного диалога.`);
  return errors;
}

module.exports = { buildSubmission, validateSubmission, CRITERION_IDS, evidenceTurns };

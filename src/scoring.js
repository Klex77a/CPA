'use strict';
/**
 * Расчёт баллов строго по конфигурации чек-листа.
 *
 *  - «Да» = полный вес, «Нет» = 0.
 *  - Шкала: вес × ступень / максимальная ступень шкалы (максимум шкалы обязан быть > 0,
 *    все ступени — конечные неотрицательные уникальные числа; проверяется в validateChecklist).
 *  - N/A исключает критерий из числителя и знаменателя.
 *  - Флаг (грубая ошибка) в расчёте не участвует и итог не обнуляет.
 *  - Итог = 100 × Σ набранных / Σ весов применимых критериев. Нет применимых весов → итог не считается (null).
 *  - Промежуточные значения НЕ округляются. Округляется только то, что показывается.
 *
 * ИИ баллы не считает — он только выбирает допустимый ответ. Эта же функция используется
 * для первичного результата и для пересчёта после апелляции.
 */

const round = (x, d = 2) => {
  if (x == null || !Number.isFinite(x)) return null;
  const m = Math.pow(10, d);
  return Math.round((x + Number.EPSILON) * m) / m;
};

const scaleValues = (c) => (c.scale || []).map((s) => Number(s.value));
const scaleMax = (c) => Math.max(...scaleValues(c));

class AnswerError extends Error {}

/** Допустимые ответы критерия (для подсказок, схемы и валидации). */
function allowedAnswers(c) {
  if (c.type === 'flag') return ['YES', 'NO'];
  if (c.type === 'scale') return c.na_allowed ? ['SCORE', 'NA'] : ['SCORE'];
  return c.na_allowed ? ['YES', 'NO', 'NA'] : ['YES', 'NO'];
}

function canonAnswer(a) {
  const s = String(a ?? '').trim().toUpperCase();
  if (['N/A', 'NA', 'Н/П'].includes(s)) return 'NA';
  if (['ДА', 'YES', 'TRUE'].includes(s)) return 'YES';
  if (['НЕТ', 'NO', 'FALSE'].includes(s)) return 'NO';
  if (s === 'SCORE') return 'SCORE';
  return s;
}

/**
 * Строгая проверка ответа (без «подгонки»). Бросает AnswerError, если ответ недопустим.
 * Используется и для ответа модели, и для решения проверяющего.
 */
function validateAnswer(c, raw) {
  const answer = canonAnswer(raw && raw.answer);
  const allowed = allowedAnswers(c);
  if (answer === 'NA' && !c.na_allowed) throw new AnswerError(`«${c.title}»: N/A для этого критерия не разрешён`);
  if (!allowed.includes(answer)) throw new AnswerError(`«${c.title}»: недопустимый ответ «${raw && raw.answer}». Допустимо: ${allowed.join(', ')}`);
  if (answer === 'SCORE') {
    const v = Number(raw.value ?? raw.score);
    if (raw.value == null && raw.score == null) throw new AnswerError(`«${c.title}»: не указана ступень шкалы`);
    if (!scaleValues(c).includes(v)) throw new AnswerError(`«${c.title}»: ${raw.value ?? raw.score} не является ступенью шкалы (${scaleValues(c).join(', ')})`);
    return { answer, value: v };
  }
  return { answer, value: null };
}

/**
 * @param checklist {criteria:[{id,type,weight,na_allowed,scale,section}], sections, rounding}
 * @param answers   {[criterionId]: {answer:'YES'|'NO'|'NA'|'SCORE'|'INVALID', value}}
 *  'INVALID' — модель не дала допустимого ответа даже после повторного запроса: итог не считается.
 */
function computeScore(checklist, answers) {
  const digits = checklist.rounding != null ? checklist.rounding : 2;
  const rows = [];
  let applicableWeight = 0;
  let earned = 0;
  const grossErrors = [];
  const invalid = [];

  for (const c of checklist.criteria) {
    const a = answers[c.id] || { answer: 'INVALID' };
    const weight = Number(c.weight) || 0;
    const row = { id: c.id, type: c.type, weight, answer: a.answer, value: a.value ?? null, section: c.section || null, scored: false, raw: 0 };

    if (a.answer === 'INVALID') {
      invalid.push(c.id);
    } else if (c.type === 'flag') {
      if (a.answer === 'YES') grossErrors.push(c.id);
    } else if (a.answer !== 'NA' && weight > 0) {
      row.scored = true;
      row.raw = c.type === 'scale' ? (weight * Number(a.value)) / scaleMax(c) : a.answer === 'YES' ? weight : 0;
      applicableWeight += weight;
      earned += row.raw;
    }
    rows.push(row);
  }

  const factor = applicableWeight > 0 ? 100 / applicableWeight : 0;
  for (const r of rows) {
    // точные значения (для расчётов) и округлённые (только для показа)
    r.contribution = r.scored ? r.raw * factor : r.type === 'flag' ? null : 0;
    r.max_contribution = r.scored ? r.weight * factor : 0;
    r.points = r.contribution == null ? null : round(r.contribution, digits);
    r.effective_weight = round(r.max_contribution, digits);
  }

  const totalExact = invalid.length || applicableWeight === 0 ? null : (100 * earned) / applicableWeight;

  const sections = (checklist.sections || []).map((s) => {
    const rs = rows.filter((r) => r.section === s.id && r.scored);
    const got = rs.reduce((sum, r) => sum + r.contribution, 0);
    const maxP = rs.reduce((sum, r) => sum + r.max_contribution, 0);
    return { id: s.id, name: s.name, points: rs.length ? round(got, digits) : null, max: rs.length ? round(maxP, digits) : null, percent: rs.length && maxP > 0 ? round((got / maxP) * 100, digits) : null };
  });

  let note = null;
  if (invalid.length) note = 'Не все критерии получили допустимый ответ — итог не рассчитан, требуется проверка человеком.';
  else if (applicableWeight === 0) note = 'Нет применимых критериев с весом — итог не рассчитывается.';

  return {
    total: round(totalExact, digits),
    total_exact: totalExact,
    max: totalExact == null ? null : 100,
    applicable_weight: applicableWeight,
    earned_weight: earned,
    redistribution_factor: factor,
    gross_error: grossErrors.length > 0,
    gross_error_criteria: grossErrors,
    invalid_criteria: invalid,
    criteria: rows,
    sections,
    note,
  };
}

/** Проверка конфигурации чек-листа (вызывается при сохранении). Возвращает список ошибок. */
function validateChecklist(cl) {
  const errors = [];
  if (!cl || !String(cl.name || '').trim()) errors.push('Нет названия чек-листа');
  if (!Array.isArray(cl && cl.criteria) || !cl.criteria.length) { errors.push('Нет критериев'); return errors; }
  const ids = new Set();
  const sectionIds = new Set((cl.sections || []).map((s) => s.id));
  for (const c of cl.criteria) {
    const name = c.title || c.id || '?';
    if (!c.id || !/^[A-Za-z0-9_-]{1,40}$/.test(String(c.id))) errors.push(`${name}: некорректный id`);
    if (ids.has(c.id)) errors.push(`Повторяется id ${c.id}`);
    ids.add(c.id);
    if (!String(c.title || '').trim()) errors.push(`${c.id}: нет названия`);
    if (!['binary', 'scale', 'flag'].includes(c.type)) errors.push(`${c.id}: неизвестный тип ${c.type}`);
    const w = Number(c.weight);
    if (c.type !== 'flag' && (!Number.isFinite(w) || w < 0)) errors.push(`${c.id}: вес должен быть неотрицательным числом`);
    if (c.section && !sectionIds.has(c.section)) errors.push(`${c.id}: секция «${c.section}» не существует`);
    if (c.na_allowed && c.type !== 'flag' && !String(c.na_condition || '').trim()) errors.push(`${c.id}: N/A разрешён, но не задано условие N/A`);
    if (c.type === 'scale') {
      const vals = (c.scale || []).map((s) => Number(s.value));
      if (vals.length < 2) errors.push(`${c.id}: у шкалы должно быть минимум 2 ступени`);
      if (vals.some((v) => !Number.isFinite(v))) errors.push(`${c.id}: ступени шкалы должны быть числами`);
      if (vals.some((v) => v < 0)) errors.push(`${c.id}: ступени шкалы не могут быть отрицательными`);
      if (new Set(vals).size !== vals.length) errors.push(`${c.id}: ступени шкалы повторяются`);
      if (vals.length && !(Math.max(...vals) > 0)) errors.push(`${c.id}: максимальная ступень шкалы должна быть больше 0 (баллы = вес × ступень / максимум)`);
    }
  }
  return errors;
}

module.exports = { computeScore, validateAnswer, validateChecklist, allowedAnswers, canonAnswer, AnswerError, round, scaleMax, scaleValues };

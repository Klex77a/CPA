'use strict';
// Запуск: node test/scoring.test.js  (или npm test — все тесты)
const assert = require('assert');
const path = require('path');
const { computeScore, validateAnswer, validateChecklist, AnswerError } = require('../src/scoring');
const cl = require(path.join(__dirname, '../src/default-checklist.json'));

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('✔', name); };
const crit = (id) => cl.criteria.find((c) => c.id === id);

const all = (o) => Object.assign({
  c01: { answer: 'YES' }, c02: { answer: 'YES' }, c03: { answer: 'YES' }, c04: { answer: 'SCORE', value: 20 },
  c05: { answer: 'YES' }, c06: { answer: 'SCORE', value: 10 }, c07: { answer: 'YES' }, c08: { answer: 'NO' },
}, o);

t('всё выполнено = 100', () => {
  const r = computeScore(cl, all());
  assert.strictEqual(r.total, 100);
  assert.strictEqual(r.gross_error, false);
});

t('7/10 при весе 15 даёт 10,5 до перераспределения', () => {
  const r = computeScore(cl, all({ c06: { answer: 'SCORE', value: 7 } }));
  const row = r.criteria.find((x) => x.id === 'c06');
  assert.strictEqual(row.raw, 10.5);
  assert.strictEqual(r.total, 95.5);
});

t('регрессия p1-ru-007: применимый вес 65, набрано 10 + 10 + 10,5 = 30,5 → 46,92 (не 46,91)', () => {
  const r = computeScore(cl, {
    c01: { answer: 'YES' }, c02: { answer: 'NA' }, c03: { answer: 'NA' }, c04: { answer: 'SCORE', value: 10 },
    c05: { answer: 'NO' }, c06: { answer: 'SCORE', value: 7 }, c07: { answer: 'NO' }, c08: { answer: 'NO' },
  });
  assert.strictEqual(r.applicable_weight, 65);
  assert.strictEqual(r.earned_weight, 30.5);
  assert.ok(Math.abs(r.total_exact - 46.923076923) < 1e-6);
  assert.strictEqual(r.total, 46.92);
  // показанные доли 15,38 + 15,38 + 16,15 = 46,91 — это эффект округления отображения, итог не меняется
  const shown = r.criteria.filter((x) => x.scored).reduce((s, x) => s + x.points, 0);
  assert.strictEqual(Math.round(shown * 100) / 100, 46.91);
  // точные доли в сумме дают точный итог
  const exact = r.criteria.filter((x) => x.scored).reduce((s, x) => s + x.contribution, 0);
  assert.ok(Math.abs(exact - r.total_exact) < 1e-9);
});

t('N/A исключается из числителя и знаменателя', () => {
  const r = computeScore(cl, all({ c03: { answer: 'NA' }, c04: { answer: 'NA' }, c01: { answer: 'NO' } }));
  assert.strictEqual(r.applicable_weight, 60);
  assert.strictEqual(r.total, 83.33);
  const sumMax = r.criteria.filter((x) => x.scored).reduce((s, x) => s + x.max_contribution, 0);
  assert.ok(Math.abs(sumMax - 100) < 1e-9);
});

t('нулевой применимый вес → итог не рассчитывается (null, не 0 и не 100)', () => {
  const only = { ...cl, criteria: cl.criteria.filter((c) => ['c02', 'c08'].includes(c.id)) };
  const r = computeScore(only, { c02: { answer: 'NA' }, c08: { answer: 'NO' } });
  assert.strictEqual(r.total, null);
  assert.ok(r.note);
});

t('флаг грубой ошибки не обнуляет итог', () => {
  const r = computeScore(cl, all({ c08: { answer: 'YES' } }));
  assert.strictEqual(r.total, 100);
  assert.strictEqual(r.gross_error, true);
});

t('недопустимый ответ (INVALID) → итог не рассчитывается', () => {
  const r = computeScore(cl, all({ c04: { answer: 'INVALID' } }));
  assert.strictEqual(r.total, null);
  assert.deepStrictEqual(r.invalid_criteria, ['c04']);
});

t('запрещённый N/A отклоняется', () => {
  assert.throws(() => validateAnswer(crit('c01'), { answer: 'NA' }), AnswerError);
  assert.throws(() => validateAnswer(crit('c06'), { answer: 'NA' }), AnswerError);
});

t('недопустимая ступень шкалы отклоняется (без подгонки к ближайшей)', () => {
  assert.throws(() => validateAnswer(crit('c04'), { answer: 'SCORE', value: 12 }), AnswerError);
  assert.throws(() => validateAnswer(crit('c06'), { answer: 'SCORE', value: 5 }), AnswerError);
  assert.throws(() => validateAnswer(crit('c04'), { answer: 'SCORE' }), AnswerError);
  assert.deepStrictEqual(validateAnswer(crit('c06'), { answer: 'SCORE', value: 7 }), { answer: 'SCORE', value: 7 });
});

t('ответ не того типа отклоняется', () => {
  assert.throws(() => validateAnswer(crit('c04'), { answer: 'YES' }), AnswerError);
  assert.throws(() => validateAnswer(crit('c01'), { answer: 'SCORE', value: 10 }), AnswerError);
  assert.throws(() => validateAnswer(crit('c08'), { answer: 'NA' }), AnswerError);
});

t('секции считаются из точных долей и согласованы с итогом', () => {
  const r = computeScore(cl, all({ c01: { answer: 'NO' }, c06: { answer: 'SCORE', value: 7 } }));
  const start = r.sections.find((x) => x.id === 'start');
  assert.strictEqual(start.points, 15);
  assert.strictEqual(start.max, 25);
  const sumSections = r.sections.filter((x) => x.points != null).reduce((s, x) => s + x.points, 0);
  assert.ok(Math.abs(sumSections - r.total) <= 0.02);
});

t('пользовательская шкала 1–5: баллы = вес × ступень / максимум', () => {
  const custom = { ...cl, criteria: [{ id: 'x1', title: 'X', type: 'scale', weight: 10, na_allowed: false, scale: [5, 4, 3, 2, 1].map((v) => ({ value: v, description: '' })) }] };
  assert.deepStrictEqual(validateChecklist(custom), []);
  const r = computeScore(custom, { x1: { answer: 'SCORE', value: 3 } });
  assert.strictEqual(r.criteria[0].raw, 6);
  assert.strictEqual(r.total, 60);
});

t('конфигурация: шкала с максимумом 0, повторами или отрицательными ступенями отклоняется', () => {
  const mk = (vals) => ({ name: 'T', criteria: [{ id: 'x', title: 'X', type: 'scale', weight: 5, scale: vals.map((v) => ({ value: v })) }] });
  assert.ok(validateChecklist(mk([0, 0])).length);
  assert.ok(validateChecklist(mk([0])).length);
  assert.ok(validateChecklist(mk([-5, 5])).length);
  assert.ok(validateChecklist(mk([5, 5, 0])).length);
  assert.ok(validateChecklist({ name: 'T', criteria: [{ id: 'y', title: 'Y', type: 'binary', weight: 5, na_allowed: true, na_condition: '' }] }).length, 'N/A без условия');
  assert.deepStrictEqual(validateChecklist(cl), []);
});

console.log(`\nscoring: пройдено ${passed}`);

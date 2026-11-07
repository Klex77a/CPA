'use strict';
/**
 * Живая смысловая проверка на небольших примерах RU/KZ/EN (test/fixtures/semantic-cases.json).
 * Делает по одному запросу к настроенной модели на пример (7 запросов) — запускайте осознанно:
 *   node scripts/semantic-check.js
 * Проверяются только ответы, которые однозначно следуют из правил чек-листа; спорные оценки не закрепляются.
 */
const path = require('path');
const cfg = require('../src/config');
const { evaluate } = require('../src/evaluator');
const cases = require('../test/fixtures/semantic-cases.json');
const cl = require(path.join(__dirname, '../src/default-checklist.json'));

if (cfg.provider === 'mock') {
  console.error('Нужен ключ ИИ в .env: в демо-режиме смысловая проверка не имеет смысла.');
  process.exit(1);
}

(async () => {
  let ok = 0, fail = 0;
  for (const c of cases) {
    try {
      const ev = await evaluate(c.record, cl, 'SEMANTIC', { force: true });
      const problems = [];
      for (const [id, exp] of Object.entries(c.expect)) {
        const a = ev.criteria[id];
        if (exp.answer && a.answer !== exp.answer) problems.push(`${id}: ожидалось ${exp.answer}, получено ${a.answer}`);
        if (exp.score_in && !(a.answer === 'SCORE' && exp.score_in.includes(a.value))) problems.push(`${id}: ожидалась ступень из [${exp.score_in}], получено ${a.answer} ${a.value ?? ''}`);
      }
      if (ev.status !== 'ok') problems.push(`статус ${ev.status}: ${ev.validation_errors.join('; ')}`);
      if (problems.length) { fail++; console.log(`✘ ${c.name}\n   ${problems.join('\n   ')}\n   (${c.why})`); }
      else { ok++; console.log(`✔ ${c.name}  ·  ${(ev.duration_ms / 1000).toFixed(1)} с, ≈ $${ev.cost_usd}`); }
    } catch (e) {
      fail++;
      console.log(`✘ ${c.name}: ошибка запроса — ${e.message}`);
    }
  }
  console.log(`\nИтого: ${ok} из ${cases.length} совпали с правилами.`);
  process.exit(fail ? 1 : 0);
})();

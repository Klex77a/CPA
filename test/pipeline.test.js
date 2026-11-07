'use strict';
// Сквозной сценарий через HTTP API сервера с имитацией Gemini (без сети и без платных вызовов).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-test-'));
Object.assign(process.env, { CQA_DATA_DIR: DATA, LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-key-123', LLM_MODEL: 'gemini-3.8-flash', REPAIR_ATTEMPTS: '1', LLM_MAX_ATTEMPTS: '3', SAMPLES: '1', CONCURRENCY: '2', PRICE_IN_PER_M: '0.3', PRICE_OUT_PER_M: '2.5' });

const realFetch = global.fetch;
const calls = [];
let queue = [];
global.fetch = async (url, opt) => {
  if (!String(url).includes('generativelanguage.googleapis.com')) return realFetch(url, opt);
  const body = JSON.parse(opt.body);
  calls.push({ url: String(url), headers: opt.headers, body });
  const next = queue.shift();
  if (!next) throw new Error('В тесте не задан ответ модели');
  if (next.abort) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  if (next.delay) await new Promise((r) => setTimeout(r, next.delay));
  if (next.status) return { ok: false, status: next.status, headers: { get: () => null }, text: async () => next.text || '' };
  const payload = { candidates: [{ content: { parts: [{ text: JSON.stringify(next.json) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 700, thoughtsTokenCount: 900 } };
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload) };
};

const { server } = require('../server');
const rec = require('./fixtures/p1-ru-007.json');

const good = () => ({
  operator_name: 'Дамир',
  criteria: [
    { id: 'c01', answer: 'YES', explanation: 'Поздоровался по-русски и назвал имя в первой реплике.', evidence: [{ msg: 'm10', fragment: 'Здравствуйте, я Дамир' }] },
    { id: 'c02', answer: 'NA', explanation: 'Клиент описал проблему и вопросы до подключения оператора.', na_reason: 'Данных хватало с начала.', evidence: [{ msg: 'm0' }, { msg: 'm4' }] },
    { id: 'c03', answer: 'NA', explanation: 'Данные счёта не раскрывались, защищённых действий не было.', na_reason: 'Запрос не требовал идентификации.', evidence: [{ msg: 'm4' }, { msg: 'm10' }] },
    { id: 'c04', answer: 'SCORE', score: 10, explanation: 'Путь указан, вопрос о повторном выводе остался открытым.', evidence: [{ msg: 'm11' }, { msg: 'm12' }], unverified_claims: ['путь в приложении'] },
    { id: 'c05', answer: 'NO', explanation: 'Формулировка «Путь к обновлению я указал» отклоняет уточнение клиента вместо реакции на его затруднение.', evidence: [{ msg: 'm12' }] },
    { id: 'c06', answer: 'SCORE', score: 7, explanation: 'Ответ в m12 построен как отказ от продолжения: клиенту неясно, к кому обратиться дальше.', evidence: [{ msg: 'm12' }] },
    { id: 'c07', answer: 'NO', explanation: 'Есть прощание, но нет итога решения и предложения помощи.', evidence: [{ msg: 'm12' }] },
    { id: 'c08', answer: 'NO', explanation: 'Нарушений из перечня не найдено.', evidence: [], checked_range: { from: 'm0', to: 'm12' } },
  ],
  coaching: [
    { criterion_id: 'c04', type: 'required', text: 'Ответить на вопрос из m11.' },
    { criterion_id: 'c01', type: 'required', text: 'Это не должно стать обязательным: критерий выполнен.' },
  ],
});

let base;
const api = async (method, p, body) => {
  const r = await realFetch(base + '/api' + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('✔', name); };

(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  await api('POST', '/datasets/upload', { group_id: 'DEV', payload: [rec] });

  let ev1;
  await t('ошибка доказательства → один повторный запрос с перечнем ошибок → валидный результат', async () => {
    const bad = good();
    bad.criteria[0].evidence = [{ msg: 'm99' }];
    queue = [{ json: bad }, { json: good() }];
    const r = await api('POST', '/evaluate', { group_id: 'DEV', conversation_id: 'p1-ru-007', checklist_id: 'default' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    ev1 = r.json;
    assert.strictEqual(calls.length, 2);
    assert.ok(calls[1].body.contents[0].parts[0].text.includes('НЕ ПРОШЁЛ ПРОВЕРКУ'));
    assert.ok(calls[1].body.contents[0].parts[0].text.includes('m99'));
    assert.strictEqual(ev1.status, 'ok');
    assert.strictEqual(ev1.timing.calls.length, 2);
    assert.strictEqual(ev1.final_result.total, 46.92);
    assert.deepStrictEqual(ev1.usage, { input: 6000, output: 1400, thoughts: 1800 });
  });

  await t('запрос к Gemini: схема ответа, ключ в заголовке (не в URL), температура не занижается для Gemini 3', async () => {
    const c = calls[0];
    assert.ok(c.body.generationConfig.responseJsonSchema, 'нет responseJsonSchema');
    assert.deepStrictEqual(c.body.generationConfig.responseJsonSchema.properties.criteria.items.properties.id.enum, ['c01', 'c02', 'c03', 'c04', 'c05', 'c06', 'c07', 'c08']);
    assert.strictEqual(c.headers['x-goog-api-key'], 'test-key-123');
    assert.ok(!c.url.includes('test-key-123'));
    assert.ok(!('temperature' in c.body.generationConfig));
    assert.ok(c.body.contents[0].parts[0].text.includes('NA для этого критерия ЗАПРЕЩЁН'));
  });

  await t('доказательства хранятся как ID исходных реплик; рекомендация «обязательно» для выполненного критерия понижается до совета', async () => {
    assert.deepStrictEqual(ev1.criteria.c01.evidence, [{ msg: 10, fragment: 'Здравствуйте, я Дамир' }]);
    assert.deepStrictEqual(ev1.criteria.c08.checked_range, { from: 0, to: 12 });
    assert.strictEqual(ev1.coaching.find((x) => x.criterion_id === 'c04').type, 'required');
    assert.strictEqual(ev1.coaching.find((x) => x.criterion_id === 'c01').type, 'optional');
    assert.strictEqual(ev1.criteria.c04.fact_check, 'needs_human');
    assert.ok(!/закрыл чат|оперативн/i.test(ev1.summary));
  });

  await t('повторный запрос без force возвращает сохранённый результат (без вызова модели)', async () => {
    const before = calls.length;
    const r = await api('POST', '/evaluate', { group_id: 'DEV', conversation_id: 'p1-ru-007', checklist_id: 'default' });
    assert.strictEqual(r.json.cached, true);
    assert.strictEqual(r.json.id, ev1.id);
    assert.strictEqual(calls.length, before);
  });

  await t('изменение критерия исключает использование старого результата; старая оценка сохраняется', async () => {
    const cl = (await api('GET', '/checklists/default')).json;
    cl.criteria.find((c) => c.id === 'c07').description += ' (изменено)';
    const saved = await api('PUT', '/checklists/default', cl);
    assert.strictEqual(saved.json.version, 2);
    const before = calls.length;
    queue = [{ json: good() }];
    const r = await api('POST', '/evaluate', { group_id: 'DEV', conversation_id: 'p1-ru-007', checklist_id: 'default' });
    assert.notStrictEqual(r.json.cached, true);
    assert.strictEqual(calls.length, before + 1);
    assert.ok(calls[calls.length - 1].body.contents[0].parts[0].text.includes('(изменено)'), 'в запрос ушла актуальная конфигурация');
    assert.strictEqual(r.json.checklist.version, 2);
    assert.notStrictEqual(r.json.cache_key, ev1.cache_key);
    const old = await api('GET', '/evaluations/' + encodeURIComponent(ev1.id));
    assert.strictEqual(old.status, 200);
    assert.strictEqual(old.json.checklist_snapshot.version, 1);
  });

  await t('явная переоценка (force) запускает новый запрос и не затирает прежний результат', async () => {
    queue = [{ json: good() }];
    const before = calls.length;
    const r = await api('POST', '/evaluate', { group_id: 'DEV', conversation_id: 'p1-ru-007', checklist_id: 'default', force: true });
    assert.strictEqual(calls.length, before + 1);
    assert.notStrictEqual(r.json.id, ev1.id);
  });

  await t('апелляция: исходный результат сохраняется, финальный пересчитывается; N/A ↔ применимый меняет знаменатель', async () => {
    const id = encodeURIComponent(ev1.id);
    let r = await api('POST', `/evaluations/${id}/appeals`, { criterion_id: 'c02', comment: 'Нужно было уточнить, с телефона ли клиент' });
    assert.strictEqual(r.status, 201);
    const apId = r.json.appeals[0].id;
    // недопустимые решения отклоняются
    assert.strictEqual((await api('POST', `/evaluations/${id}/appeals/${apId}/decision`, { action: 'change', answer: 'SCORE', value: 5, reason: 'x' })).status, 400);
    assert.strictEqual((await api('POST', `/evaluations/${id}/appeals/${apId}/decision`, { action: 'change', answer: 'NO' })).status, 400, 'без причины');
    // N/A → «Нет»: применимый вес 65 → 80, итог 30,5/80 = 38,125 → 38,13
    r = await api('POST', `/evaluations/${id}/appeals/${apId}/decision`, { action: 'change', answer: 'NO', reason: 'Уточнение требовалось' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.original_result.total, 46.92);
    assert.strictEqual(r.json.final_result.applicable_weight, 80);
    assert.strictEqual(r.json.final_result.total, 38.13);
    // применимый → N/A по другому критерию: c07 «Нет» → N/A, вес 80 → 75, итог 30,5/75 = 40,67
    r = await api('POST', `/evaluations/${id}/appeals`, { criterion_id: 'c07', comment: 'чат оборвался' });
    const ap2 = r.json.appeals[1].id;
    r = await api('POST', `/evaluations/${id}/appeals/${ap2}/decision`, { action: 'change', answer: 'NA', reason: 'Клиент ушёл' });
    assert.strictEqual(r.json.final_result.applicable_weight, 75);
    assert.strictEqual(r.json.final_result.total, 40.67);
    // запрещённый N/A в решении отклоняется
    r = await api('POST', `/evaluations/${id}/appeals`, { criterion_id: 'c01', comment: 'x' });
    const ap3 = r.json.appeals[2].id;
    assert.strictEqual((await api('POST', `/evaluations/${id}/appeals/${ap3}/decision`, { action: 'change', answer: 'NA', reason: 'x' })).status, 400);
    // после «перезагрузки» (чтение с диска) всё на месте
    const reread = JSON.parse(fs.readFileSync(path.join(DATA, 'evaluations', ev1.id.replace(/[^A-Za-z0-9_.-]/g, '_') + '.json'), 'utf8'));
    assert.strictEqual(reread.original_result.total, 46.92);
    assert.strictEqual(reread.final_result.total, 40.67);
    assert.strictEqual(reread.appeals[0].decision.answer, 'NO');
    assert.strictEqual(reread.appeals[0].decision.total_before, 46.92);
  });

  await t('ответ, не прошедший проверку и после повтора, помечается «требует проверки», итог не выдаётся за подтверждённый', async () => {
    const bad = good();
    bad.criteria[3].score = 12; // нет такой ступени
    queue = [{ json: bad }, { json: bad }];
    const r = await api('POST', '/evaluate', { group_id: 'DEV', conversation_id: 'p1-ru-007', checklist_id: 'default', force: true });
    assert.strictEqual(r.json.status, 'needs_review');
    assert.strictEqual(r.json.criteria.c04.answer, 'INVALID');
    assert.strictEqual(r.json.final_result.total, null);
    assert.strictEqual(r.json.timing.calls.length, 2, 'повторов не больше заданного');
  });

  await t('временная ошибка 429 повторяется ограниченно, ожидание и попытки измеряются', async () => {
    queue = [{ status: 429, text: '{"error":{"details":[{"retryDelay":"0s"}]}}' }, { json: good() }];
    const r = await api('POST', '/evaluate', { group_id: 'DEV', conversation_id: 'p1-ru-007', checklist_id: 'default', force: true });
    assert.strictEqual(r.json.status, 'ok');
    assert.strictEqual(r.json.timing.http_attempts, 2);
    queue = [{ status: 429 }, { status: 429 }, { status: 429 }];
    const r2 = await api('POST', '/evaluate', { group_id: 'DEV', conversation_id: 'p1-ru-007', checklist_id: 'default', force: true });
    assert.strictEqual(r2.status, 429, 'код временной ошибки провайдера передаётся клиенту');
    assert.ok(/429/.test(r2.json.error));
    assert.strictEqual(queue.length, 0, 'ровно LLM_MAX_ATTEMPTS попыток');
    // тайм-аут не роняет сервер: нечисловой код ошибки → 502
    queue = [{ abort: true }, { abort: true }, { abort: true }];
    const r3 = await api('POST', '/evaluate', { group_id: 'DEV', conversation_id: 'p1-ru-007', checklist_id: 'default', force: true });
    assert.strictEqual(r3.status, 502);
    assert.ok(/тайм-аут/.test(r3.json.error));
  });

  await t('одновременные одинаковые запросы объединяются в один вызов модели', async () => {
    const cl = (await api('GET', '/checklists/default')).json;
    cl.notes += ' ';
    await api('PUT', '/checklists/default', cl); // новая версия → кэша нет
    queue = [{ json: good(), delay: 150 }];
    const before = calls.length;
    const [a, b] = await Promise.all([1, 2].map(() => api('POST', '/evaluate', { group_id: 'DEV', conversation_id: 'p1-ru-007', checklist_id: 'default' })));
    assert.strictEqual(calls.length, before + 1);
    assert.strictEqual(a.json.id, b.json.id);
  });

  await t('пакетная оценка: статусы элементов, пропуск готовых результатов', async () => {
    const r = await api('POST', '/batch', { group_id: 'DEV', checklist_id: 'default' });
    let job = r.json;
    for (let i = 0; i < 50 && job.status === 'running'; i++) { await new Promise((x) => setTimeout(x, 20)); job = (await api('GET', '/batch/' + job.id)).json; }
    assert.strictEqual(job.status, 'finished');
    assert.deepStrictEqual(job.counts, { skipped: 1 });
  });

  server.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\npipeline: пройдено ${passed}`);
})().catch((e) => { console.error('✘', e); server.close(); process.exit(1); });

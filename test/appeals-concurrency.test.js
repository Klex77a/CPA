'use strict';
// Real HTTP chunked bodies hold both handlers before mutation. No model or live data is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
Object.assign(process.env, { CQA_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-appeal-races-')), LLM_PROVIDER: 'mock' });
const { server } = require('../server');
const store = require('../src/store');
const sample = require('../data/sample/SAMPLE.json').data.records[0];
let base, seed;
let passed = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(method, route, body) {
  const response = await fetch(base + '/api' + route, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
function chunked(method, route, body) {
  const raw = JSON.stringify(body);
  let request;
  const result = new Promise((resolve, reject) => {
    request = http.request(base + '/api' + route, { method, headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
    });
    request.on('error', reject);
    request.write(raw.slice(0, 1));
  });
  return { finish: () => request.end(raw.slice(1)), result };
}
async function overlap(requests) {
  await sleep(100);
  for (const request of requests) request.finish();
  return Promise.all(requests.map((request) => request.result));
}
const evaluationRoute = () => `/evaluations/${encodeURIComponent(seed.id)}`;
const reset = () => store.write('evaluations', seed.id, JSON.parse(JSON.stringify(seed)));
async function test(name, fn) { await fn(); passed++; console.log('✔', name); }

(async () => {
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await api('POST', '/datasets/upload', { group_id: 'QA', payload: [sample] })).status, 200);
    const evaluated = await api('POST', '/evaluate', { group_id: 'QA', conversation_id: sample.conversation_id });
    assert.equal(evaluated.status, 200);
    seed = evaluated.body;

    await test('две одновременные апелляции разных критериев сохраняются обе', async () => {
      reset();
      const responses = await overlap(['c01', 'c02'].map((criterion) => chunked('POST', evaluationRoute() + '/appeals', { criterion_id: criterion, comment: 'Проверьте критерий ' + criterion })));
      assert.deepEqual(responses.map((response) => response.status), [201, 201]);
      const evaluation = (await api('GET', evaluationRoute())).body;
      assert.deepEqual(evaluation.appeals.map((appeal) => appeal.criterion_id).sort(), ['c01', 'c02']);
    });

    await test('одновременный дубль одного критерия отклонён без потери первой апелляции', async () => {
      reset();
      const responses = await overlap([1, 2].map((number) => chunked('POST', evaluationRoute() + '/appeals', { criterion_id: 'c01', comment: 'Комментарий ' + number })));
      assert.deepEqual(responses.map((response) => response.status).sort(), [201, 400]);
      assert.equal((await api('GET', evaluationRoute())).body.appeals.length, 1);
    });

    await test('решения по разным апелляциям не перезаписывают историю друг друга', async () => {
      reset();
      for (const criterion of ['c01', 'c02']) await api('POST', evaluationRoute() + '/appeals', { criterion_id: criterion, comment: 'Обоснование ' + criterion });
      const before = (await api('GET', evaluationRoute())).body;
      const responses = await overlap(before.appeals.map((appeal) => chunked('POST', evaluationRoute() + `/appeals/${appeal.id}/decision`, { action: 'confirm', reason: 'Оценка подтверждена' })));
      assert.deepEqual(responses.map((response) => response.status), [200, 200]);
      assert.equal((await api('GET', evaluationRoute())).body.appeals.filter((appeal) => appeal.status === 'resolved').length, 2);
    });

    await test('повторное одновременное решение не меняет уже рассмотренную апелляцию', async () => {
      reset();
      await api('POST', evaluationRoute() + '/appeals', { criterion_id: 'c01', comment: 'Проверьте контакт' });
      const appeal = (await api('GET', evaluationRoute())).body.appeals[0];
      const responses = await overlap([1, 2].map((number) => chunked('POST', evaluationRoute() + `/appeals/${appeal.id}/decision`, { action: 'confirm', reason: 'Решение ' + number })));
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400]);
      assert.equal((await api('GET', evaluationRoute())).body.appeals[0].status, 'resolved');
    });

    await test('одновременные сохранения чек-листа получают разные последовательные версии', async () => {
      const checklist = (await api('GET', '/checklists/default')).body;
      const responses = await overlap([1, 2].map((number) => chunked('PUT', '/checklists/default', { ...checklist, name: 'Редакция ' + number })));
      assert.deepEqual(responses.map((response) => response.status), [200, 200]);
      assert.deepEqual(responses.map((response) => response.body.version).sort(), [2, 3]);
      const after = (await api('GET', '/checklists/default')).body;
      assert.equal(after.version, 3);
      assert.deepEqual(after.history.map((entry) => entry.version), [1, 2]);
    });

    await test('непроверенный флаг нарушения не выдаётся в списке и аналитике за проверенное отсутствие', async () => {
      reset();
      store.write('checklists', 'default', seed.checklist_snapshot);
      const evaluation = store.read('evaluations', seed.id);
      evaluation.final_criteria.c08 = { ...evaluation.final_criteria.c08, answer: 'INVALID', review_required: true };
      evaluation.status = 'needs_review';
      store.write('evaluations', seed.id, evaluation);
      const dataset = (await api('GET', '/datasets/QA')).body;
      assert.equal(dataset.records[0].evaluations[0].gross_error_unknown, true);
      const analytics = (await api('GET', '/analytics?group_id=QA&checklist_id=default')).body;
      assert.equal(analytics.gross_unknown_count, 1);
    });

    await test('пустой group_id и отмена отсутствующей задачи возвращают понятные ошибки', async () => {
      assert.equal((await api('POST', '/datasets/upload', { group_id: '   ', payload: [sample] })).status, 400);
      assert.equal((await api('POST', '/datasets/fetch', { group_id: '   ' })).status, 400);
      assert.equal((await api('POST', '/batch/no-such-job/cancel', {})).status, 404);
    });
    await test('повторный импорт не связывает старые доказательства с новым текстом, история остаётся доступна', async () => {
      reset();
      store.write('checklists', 'default', seed.checklist_snapshot);
      const changed = JSON.parse(JSON.stringify(sample));
      changed.transcript[0].text = 'Обновлённый текст, которого не было при оценке';
      assert.equal((await api('POST', '/datasets/upload', { group_id: 'QA', payload: [changed] })).status, 200);
      const historical = (await api('GET', evaluationRoute())).body;
      assert.equal(historical.stale, true);
      assert.equal(historical.record_changed, true);
      assert.deepEqual(historical.record_snapshot.transcript, sample.transcript);
      assert.equal((await api('GET', '/datasets/QA')).body.records[0].evaluations[0].stale, true);
      assert.equal((await api('GET', '/analytics?group_id=QA&checklist_id=default')).body.evaluated, 0);
      const csv = await (await fetch(base + '/api/export.csv?group_id=QA&checklist_id=default')).text();
      assert.equal(csv.trim().split('\n').length, 1, 'устаревшая оценка не выгружается как текущая');
      const appealed = await api('POST', evaluationRoute() + '/appeals', { criterion_id: 'c01', comment: 'Проверка архивного диалога' });
      assert.equal(appealed.status, 201);
      assert.equal(appealed.body.stale, true);
      assert.deepEqual(appealed.body.record_snapshot.transcript, sample.transcript);
      const decided = await api('POST', evaluationRoute() + `/appeals/${appealed.body.appeals[0].id}/decision`, { action: 'confirm', reason: 'Проверен исходный текст' });
      assert.equal(decided.body.record_changed, true);
      assert.deepEqual(decided.body.record_snapshot.transcript, sample.transcript);
      await api('POST', '/datasets/upload', { group_id: 'QA', payload: [sample] });
      store.write('checklists', 'default', { ...seed.checklist_snapshot, version: seed.checklist.version + 1 });
      const oldChecklist = (await api('GET', evaluationRoute())).body;
      assert.deepEqual(oldChecklist.stale_reasons, ['checklist']);
      assert.equal(oldChecklist.record_changed, false, 'старая версия чек-листа не означает другой транскрипт');
    });
    console.log(`appeals-concurrency: пройдено ${passed}`);
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { if (server.listening) server.close(); }
})();

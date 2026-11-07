'use strict';
// Регрессии из аудита: изоляция групп, входные данные, апелляции и экспорт.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('node:http');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-hardening-'));
Object.assign(process.env, { CQA_DATA_DIR: dataDir, LLM_PROVIDER: 'mock' });
const { server, normalizeRecords } = require('../server');
const store = require('../src/store');
const { validateChecklist, validateAnswer, AnswerError } = require('../src/scoring');
const { evaluate, recompute } = require('../src/evaluator');
const checklist = require('../src/default-checklist.json');
const sample = require('../data/sample/SAMPLE.json').data.records[0];

let count = 0;
async function test(name, fn) { await fn(); count++; console.log('✔', name); }

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (method, route, body) => {
    const response = await fetch(base + '/api' + route, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    await test('невалидные JSON-формы и реплики возвращают 400, а не внутреннюю ошибку', async () => {
      for (const body of [null, [], 1, 'text']) assert.strictEqual((await request('POST', '/datasets/upload', body)).status, 400);
      for (const record of [null, { transcript: {} }, { transcript: [null] }, { transcript: [{ speaker: 'operator', text: {} }] }]) {
        assert.strictEqual((await request('POST', '/datasets/upload', { payload: [record] })).status, 400);
      }
      assert.throws(() => normalizeRecords([sample, sample]), /Повторяется conversation_id/);
      assert.throws(() => normalizeRecords([{ ...sample, conversation_id: undefined }]), /conversation_id/);
      assert.throws(() => normalizeRecords([{ ...sample, audio_url: 'javascript:alert(1)' }]), /HTTPS/);
      assert.strictEqual(normalizeRecords({ data: { records: [sample] } })[0].transcript.length, sample.transcript.length);
    });

    await test('сторонний сайт не может читать локальные данные через открытый CORS', async () => {
      const blocked = await fetch(base + '/api/datasets', { headers: { Origin: 'https://untrusted.example' } });
      assert.strictEqual(blocked.status, 403);
      assert.strictEqual(blocked.headers.get('access-control-allow-origin'), null);
      const local = await fetch(base + '/api/datasets', { headers: { Origin: base } });
      assert.strictEqual(local.status, 200);
      assert.strictEqual(local.headers.get('access-control-allow-origin'), base);
      const reboundStatus = await new Promise((resolve, reject) => {
        http.get(base + '/api/config', { headers: { Host: 'untrusted-rebinding.example', Origin: 'http://untrusted-rebinding.example' } }, (response) => { response.resume(); resolve(response.statusCode); }).on('error', reject);
      });
      assert.strictEqual(reboundStatus, 421, 'чужой DNS hostname не открывает локальный API даже при совпадающем Origin');
    });

    await test('структурная валидация чек-листа не падает на null и запрещает ошибочное округление', async () => {
      for (const invalid of [null, [], { name: 'T', criteria: [null] }, { name: 'T', criteria: checklist.criteria, sections: {} }, { ...checklist, rounding: 400 }, { ...checklist, rounding: -1 }]) {
        assert.ok(validateChecklist(invalid).length);
        assert.strictEqual((await request('POST', '/checklists', invalid)).status, 400);
      }
      const c = checklist.criteria.find((x) => x.type === 'scale');
      for (const value of ['', false, [], {}]) assert.throws(() => validateAnswer(c, { answer: 'SCORE', value }), AnswerError);
      assert.deepStrictEqual(validateChecklist(checklist), []);
    });

    await test('разные ID с одинаковой старой нормализацией не перезаписывают наборы', async () => {
      const hashLikeId = 'key-' + crypto.createHash('sha256').update('G/A').digest('hex');
      const ids = ['G/A', 'G_A', 'Группа А', 'CON', hashLikeId];
      for (const id of ids) store.write('datasets', id, { group_id: id, records: [] });
      for (const id of ids) assert.strictEqual(store.read('datasets', id).group_id, id);
      store.remove('datasets', 'G/A');
      assert.strictEqual(store.read('datasets', 'G/A'), null);
      assert.ok(store.read('datasets', 'G_A'));
      assert.throws(() => store.write('../outside', 'x', {}), /Неизвестная коллекция/);
    });

    await test('кэш и одновременная оценка изолированы по группе', async () => {
      for (const group of ['A', 'B']) assert.strictEqual((await request('POST', '/datasets/upload', { group_id: group, payload: [sample] })).status, 200);
      const a = await request('POST', '/evaluate', { group_id: 'A', conversation_id: sample.conversation_id });
      const b = await request('POST', '/evaluate', { group_id: 'B', conversation_id: sample.conversation_id });
      assert.strictEqual(a.body.group_id, 'A');
      assert.strictEqual(b.body.group_id, 'B');
      assert.notStrictEqual(a.body.id, b.body.id);
      assert.ok(!b.body.cached);
      const cached = await request('POST', '/evaluate', { group_id: 'B', conversation_id: sample.conversation_id });
      assert.strictEqual(cached.body.cached, true);
      const [x, y] = await Promise.all([evaluate(sample, checklist, 'X'), evaluate(sample, checklist, 'Y')]);
      assert.strictEqual(x.group_id, 'X');
      assert.strictEqual(y.group_id, 'Y');
      const batch = await request('POST', '/batch', { group_id: 'A' });
      assert.strictEqual(batch.status, 202);
      assert.strictEqual(batch.body.skipped, 1);
    });

    await test('апелляция синхронизирует итог, вывод, статус и рекомендации, сохраняя исходную оценку', async () => {
      const cl = { id: 'appeal', name: 'Тест', version: 1, criteria: [{ id: 'a', title: 'Приветствие', type: 'binary', weight: 10 }] };
      const criteria = { a: { answer: 'NO', value: null, explanation: 'Не поздоровался.', evidence: [], issues: ['нужна проверка'], review_required: true } };
      const evaluation = {
        checklist_snapshot: cl, criteria, final_criteria: criteria, summary: 'Снижено: «Приветствие».', status: 'needs_review',
        coaching: [{ criterion_id: 'a', type: 'required', text: 'Поздороваться.' }],
        appeals: [{ id: 'ap', criterion_id: 'a', status: 'resolved', decision: { action: 'change', answer: 'YES', value: null, reason: 'Приветствие есть в первой реплике.' } }],
      };
      recompute(evaluation);
      assert.strictEqual(evaluation.final_result.total, 100);
      assert.strictEqual(evaluation.criteria.a.answer, 'NO');
      assert.strictEqual(evaluation.final_criteria.a.explanation, 'Приветствие есть в первой реплике.');
      assert.strictEqual(evaluation.status, 'ok');
      assert.ok(evaluation.summary.includes('Выполнено: «Приветствие»'));
      assert.ok(!evaluation.summary.includes('Снижено:'));
      assert.strictEqual(evaluation.coaching[0].type, 'optional');
      assert.strictEqual(evaluation.original_coaching[0].type, 'required');
    });

    await test('CSV нейтрализует формулы в импортированных названиях', async () => {
      const record = { ...sample, conversation_id: '=HYPERLINK("https://example.com")' };
      store.write('datasets', 'CSV', { group_id: 'CSV', records: [record] });
      const evaluation = await evaluate(record, checklist, 'CSV');
      store.write('evaluations', evaluation.id, evaluation);
      const csv = await (await fetch(base + '/api/export.csv?group_id=CSV')).text();
      assert.ok(csv.includes('"\'=HYPERLINK('));
    });

    await test('статические файлы соседних каталогов и некорректные URL закрыты', async () => {
      // URL-парсер не убирает .. с закодированным разделителем Windows.
      const response = await fetch(base + '/..%5cpublic-other%5csecret.txt');
      assert.strictEqual(response.status, 403);
      assert.strictEqual((await fetch(base + '/%ZZ')).status, 400);
      assert.strictEqual((await fetch(base + '/')).status, 200);
    });
    console.log(`hardening: пройдено ${count}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

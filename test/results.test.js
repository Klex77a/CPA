'use strict';
// Выбор действующей оценки и очистка результата строки (на временных данных, без ИИ).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-results-'));
Object.assign(process.env, { CQA_DATA_DIR: DATA, LLM_PROVIDER: 'mock' });

const store = require('../src/store');
const { server } = require('../server');
const { audioSegments } = require('../src/audio-offsets');
const audioOffsets = (r) => audioSegments(r).map((s) => (s ? s.start : null));

const ev = (id, cid, provider, total, created, over = {}) => ({
  id, conversation_id: cid, group_id: 'G', channel: 'agent chat', language: 'RU', provider, model: provider + '-m', created_at: created,
  checklist: { id: 'default', name: 'Чек-лист', version: 2 }, checklist_snapshot: { criteria: [] },
  original_result: { total, criteria: [] }, final_result: { total, criteria: [], gross_error: false, gross_error_criteria: [] },
  final_criteria: {}, appeals: [], coaching: [], operator_name: null, cost_usd: 0, ...over,
});

store.write('datasets', 'G', { group_id: 'G', records: ['a', 'b', 'c'].map((c) => ({ conversation_id: c, channel: 'agent chat', language: 'RU', transcript: [], audio_url: { a: 'https://rec.example/page?sig=1', b: 'https://rec.example/file.mp3' }[c] || null })) });
// имена подобраны так, чтобы при чтении папки первой шла старая оценка
store.write('evaluations', 'a1', ev('a1', 'a', 'mock', 10, '2026-01-01T00:00:00Z'));
store.write('evaluations', 'a2', ev('a2', 'a', 'deepseek', 90, '2026-01-02T00:00:00Z'));
store.write('evaluations', 'b1', ev('b1', 'b', 'deepseek', 70, '2026-01-01T00:00:00Z'));
store.write('evaluations', 'b2', ev('b2', 'b', 'mock', 20, '2026-01-03T00:00:00Z'));
store.write('evaluations', 'c1', ev('c1', 'c', 'deepseek', 50, '2026-01-01T00:00:00Z'));
store.write('evaluations', 'c2', ev('c2', 'c', 'deepseek', 60, '2026-01-02T00:00:00Z', { appeals: [{ id: 'ap', status: 'open' }] }));
store.write('evaluations', 'c3', ev('c3', 'c', 'deepseek', 55, '2026-01-02T00:00:00Z', { checklist: { id: 'other', name: 'Другой', version: 1 } }));

const realFetch = global.fetch;
let pageCalls = 0;
global.fetch = async (url, opt) => {
  const u = String(url);
  if (!u.startsWith('https://rec.example/')) return realFetch(url, opt);
  if (u.includes('page')) {
    pageCalls++;
    return new Response('<audio id="a" controls><source src="https://cdn.example/a.mp3?x=1&amp;se=2099-01-01T00:00:00Z&amp;sig=s" type="audio/mpeg"></audio>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  return new Response('mp3', { headers: { 'Content-Type': 'audio/mpeg' } });
};

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('✔', name); };

server.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const get = async (p) => (await fetch(base + p)).json();
  try {
    await t('момент записи: до начала записи и во время паузы места нет, пауза вычитается со сдвигом 4,5 с', async () => {
      const at = (s) => new Date(Date.UTC(2026, 0, 1, 10, 0, s)).toISOString();
      const m = (s, speaker, text) => ({ timestamp: at(s), speaker, text });
      const rec = { channel: 'voice call', audio_url: 'https://x', transcript: [
        m(0, 'bot', 'до записи'), m(10, 'system', 'Запись и транскрибирование запущены.'), m(20, 'client', 'а'.repeat(70)),
        m(30, 'system', 'Запись и транскрибирование приостановлены.'), m(35, 'operator', 'в паузе'), m(44, 'system', 'Запись и транскрибирование возобновлены.'), m(50, 'operator', 'б'.repeat(14)),
      ] };
      // 10 с от старта минус 5 с речи и запас; из паузы 14 с вычитается 9,5 с: конец последней реплики 40 - 9,5 = 30,5 с
      assert.deepStrictEqual(audioOffsets(rec), [null, 0, 4.7, 19.7, null, 24.2, 29.2]);
      assert.deepStrictEqual(audioOffsets({ ...rec, channel: 'agent chat' }), Array(7).fill(null));
      assert.deepStrictEqual(audioSegments(rec)[6], { start: 29.2, end: 30.5 });
      const noStart = { ...rec, transcript: rec.transcript.filter((x) => !/запущены/.test(x.text)) };
      assert.ok(audioOffsets(noStart).every((x) => x == null), 'без начала записи перемотка выключена');
    });
    await t('плеер получает прямую ссылку со страницы записи и не запрашивает её повторно', async () => {
      const open = () => fetch(base + '/audio/G/a', { redirect: 'manual' });
      const r = await open();
      assert.strictEqual(r.status, 302);
      assert.strictEqual(r.headers.get('location'), 'https://cdn.example/a.mp3?x=1&se=2099-01-01T00:00:00Z&sig=s');
      await open();
      assert.strictEqual(pageCalls, 1);
    });
    await t('прямая ссылка на аудио используется как есть; диалог без записи — 404', async () => {
      const r = await fetch(base + '/audio/G/b', { redirect: 'manual' });
      assert.strictEqual(r.headers.get('location'), 'https://rec.example/file.mp3');
      assert.strictEqual((await fetch(base + '/audio/G/c', { redirect: 'manual' })).status, 404);
    });
    await t('аналитика берёт самую новую настоящую оценку, а не демо и не первый файл', async () => {
      const A = await get('/analytics?group_id=G&checklist_id=default');
      assert.strictEqual(A.evaluated, 3);
      assert.strictEqual(A.avg, 73.33); // 90, 70, 60
      assert.strictEqual(A.demo_count, 0);
      assert.deepStrictEqual(A.models, ['deepseek / deepseek-m']);
    });
    await t('список и аналитика показывают одну и ту же оценку', async () => {
      const ds = await get('/datasets/G');
      const first = Object.fromEntries(ds.records.map((r) => [r.conversation_id, r.evaluations.filter((e) => e.checklist.id === 'default')[0].id]));
      assert.deepStrictEqual(first, { a: 'a2', b: 'b1', c: 'c2' });
    });
    await t('CSV содержит одну строку на диалог', async () => {
      const csv = await (await fetch(base + '/export.csv?group_id=G&checklist_id=default')).text();
      assert.strictEqual(csv.trim().split('\n').length, 4);
    });
    await t('очистка требует все параметры', async () => {
      const r = await fetch(base + '/evaluations?group_id=G', { method: 'DELETE' });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(store.list('evaluations').length, 7);
    });
    await t('очистка удаляет только оценки этой строки и этого чек-листа', async () => {
      const r = await (await fetch(base + '/evaluations?group_id=G&conversation_id=c&checklist_id=default', { method: 'DELETE' })).json();
      assert.deepStrictEqual(r, { removed: 2, appeals: 1 });
      assert.deepStrictEqual(store.list('evaluations').map((e) => e.id).sort(), ['a1', 'a2', 'b1', 'b2', 'c3']);
      const ds = await get('/datasets/G');
      assert.strictEqual(ds.records.length, 3, 'диалог должен остаться в наборе');
      assert.deepStrictEqual(await get('/appeals'), []);
    });
    console.log(`results: пройдено ${passed}`);
    server.close();
  } catch (e) { console.error(e); process.exit(1); }
});

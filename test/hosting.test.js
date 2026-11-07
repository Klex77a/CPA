'use strict';
// Cloud HTTP boundary tests: no database, external network, or model requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const isolated = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-hosting-')), 'no-file-store');
Object.assign(process.env, { CQA_STORAGE_DRIVER: 'postgres', CQA_DATA_DIR: isolated, LLM_PROVIDER: 'mock', CQA_ACCESS_PASSWORD: 'hosting-test-private-password', CQA_ACCESS_USERNAME: 'midnight' });
const cfg = require('../src/config');
const store = require('../src/store');
const cloud = require('../src/cloud-store');
const { isSameOrigin, credentialsMatch } = require('../src/access');
const { HttpBuffer } = require('../src/http-buffer');
let snapshot = { datasets: {}, evaluations: {}, checklists: { default: require('../src/default-checklist.json') }, appeals: {}, failures: {}, jobs: {} };
let failCommit = false, requests = 0;
cloud.withCloudStore = async ({ readOnly }, callback) => {
  requests++;
  const working = structuredClone(snapshot);
  const result = await store.withSnapshot(working, { readOnly }, callback);
  if (failCommit) throw new Error('private://database-connection-string');
  snapshot = working;
  return result;
};
const { server, handler, readBody } = require('../server');
const auth = 'Basic ' + Buffer.from('midnight:' + process.env.CQA_ACCESS_PASSWORD).toString('base64');
const headers = { authorization: auth, host: 'cqa-test.vercel.app' };
let passed = 0;
async function test(name, callback) { await callback(); passed++; console.log('✔', name); }
(async () => {
  try {
    await test('cloud import and authorization do not create an ephemeral file datastore', async () => {
      assert.equal(fs.existsSync(isolated), false);
      assert.throws(() => store.read('datasets', 'x'), /внутри запроса/);
      assert.equal(credentialsMatch(auth, 'midnight', cfg.ACCESS_PASSWORD), true);
      for (const invalid of [null, 'Bearer x', 'Basic invalid!', auth + 'x']) assert.equal(credentialsMatch(invalid, 'midnight', cfg.ACCESS_PASSWORD), false);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      for (const uri of ['/', '/assets/index-example.mjs', '/api/config', '/api/datasets']) {
        const response = await fetch(base + uri, { headers: { host: headers.host } });
        assert.equal(response.status, 401);
        assert.match(response.headers.get('www-authenticate'), /Midnight Commit/);
      }
      assert.equal(requests, 0);
      const password = cfg.ACCESS_PASSWORD; cfg.ACCESS_PASSWORD = '';
      assert.equal((await fetch(base + '/', { headers })).status, 503);
      cfg.ACCESS_PASSWORD = password;
    });
    await test('authenticated static assets and HTTPS origin work; foreign origins remain blocked', async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      const page = await fetch(base + '/', { headers });
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.equal(cfg.PUBLIC_DIR, path.join(cfg.ROOT, 'dist'), 'run npm run build before the hosting checks');
      const entry = html.match(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/);
      assert.ok(entry, 'the server must serve the compiled React entry');
      assert.match(entry[1], /^\/assets\/.+\.mjs$/);
      const bundle = await fetch(base + entry[1], { headers });
      assert.equal(bundle.status, 200);
      assert.match(bundle.headers.get('content-type'), /javascript/);
      const bytes = Buffer.from(await bundle.arrayBuffer());
      assert.equal(Buffer.compare(bytes, fs.readFileSync(path.join(cfg.PUBLIC_DIR, entry[1]))), 0, 'the served module must match the built asset byte for byte');
      const source = bytes.toString('utf8');
      assert.ok(source.length > 100, 'the client bundle must contain compiled code');
      assert.match(source, /\bexport\s*\{/, 'the client must retain native module exports');
      assert.doesNotMatch(source, /^\s*["']use strict["'];\s*Object\.defineProperty\(exports/, 'the browser bundle must not be transformed into CommonJS');
      assert.equal((await fetch(base + entry[1], { headers: { host: headers.host } })).status, 401, 'compiled assets retain the same authentication boundary');
      assert.equal(requests, 0, 'static rendering uses no workspace connection');
      const response = await fetch(base + '/api/config', { headers: { ...headers, origin: 'https://' + new URL(base).host } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).provider, 'mock');
      assert.equal((await fetch(base + '/api/config', { headers: { ...headers, origin: 'https://other.example' } })).status, 403);
      assert.equal(isSameOrigin({ headers: { host: headers.host } }, 'https://' + headers.host, true), true);
      assert.equal(isSameOrigin({ headers: { host: 'localhost', 'x-forwarded-proto': 'https' }, socket: {} }, 'https://localhost', false), false);
    });
    await test('failed commit discards the buffered success and never reveals database diagnostics', async () => {
      failCommit = true;
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/datasets/upload`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ group_id: 'not-committed', payload: [{ conversation_id: 'test', transcript: [] }] }) });
      assert.equal(response.status, 503);
      const body = await response.text();
      assert.ok(!body.includes('private://'));
      assert.ok(!body.includes('"total_records"'));
      assert.equal(JSON.parse(body).code, undefined, 'database/driver codes stay private');
      assert.equal(snapshot.datasets['not-committed'], undefined);
      failCommit = false;
      const buffer = new HttpBuffer(), events = [];
      buffer.writeHead(201, { 'Content-Type': 'application/json' }); buffer.end('{"ok":true}');
      assert.deepEqual(events, []);
      buffer.flush({ writeHead: (status) => events.push(status), end: (body) => events.push(body.toString()) });
      assert.deepEqual(events, [201, '{"ok":true}']);
    });
    await test('Vercel parsed bodies accept objects, JSON text and buffers without waiting on a consumed stream', async () => {
      for (const body of [{ x: 1 }, '{"x":1}', Buffer.from('{"x":1}')]) assert.deepEqual(await readBody({ body }), { x: 1 });
      for (const body of [null, [], 7, '{broken']) await assert.rejects(readBody({ body }), (error) => error.status === 400);
      await assert.rejects(readBody({ body: { text: 'long' } }, 2), (error) => error.status === 413);
      const request = { method: 'POST', url: '/api/datasets/upload', headers: { ...headers, origin: 'https://' + headers.host }, body: { group_id: 'CLOUD', payload: [{ conversation_id: 'test', transcript: [{ speaker: 'operator', text: 'Synthetic' }] }] } };
      let status, content;
      await handler(request, { setHeader() {}, writeHead: (value) => { status = value; }, end: (value) => { content = value.toString(); } });
      assert.equal(status, 200, content);
      assert.equal(snapshot.datasets.CLOUD.records[0].conversation_id, 'test');
      assert.equal(fs.existsSync(isolated), false);
    });
    await test('cloud batch routes retain progress across requests and GET does no model work', async () => {
      const call = async (method, url, body) => {
        let status, result;
        await handler({ method, url, headers, body }, { setHeader() {}, writeHead: (value) => { status = value; }, end: (value) => { result = JSON.parse(value.toString()); } });
        return { status, result };
      };
      const created = await call('POST', '/api/batch', { group_id: 'CLOUD' });
      assert.equal(created.status, 202); assert.equal(created.result.execution_mode, 'stepped');
      const id = created.result.id;
      const before = await call('GET', '/api/batch/' + id);
      assert.equal(before.result.done, 0); assert.equal(Object.keys(snapshot.evaluations).length, 0);
      const step = await call('POST', '/api/batch/' + id + '/step', {});
      assert.equal(step.status, 200); assert.equal(step.result.done, 1);
      const finished = await call('GET', '/api/batch/' + id);
      assert.equal(finished.result.status, 'finished');
      assert.equal(Object.keys(snapshot.evaluations).length, 1);
      const repeated = await call('POST', '/api/batch/' + id + '/step', {});
      assert.equal(repeated.result.done, 1);
      assert.equal(Object.keys(snapshot.evaluations).length, 1, 'committed work is not evaluated again');
    });
    await test('dataset summaries expose only a safe current failed retry and clear it after newer success', async () => {
      const record = snapshot.datasets.CLOUD.records[0];
      const checklist = snapshot.checklists.default;
      const future = Date.now() + 1000;
      const saved = await cloud.withCloudStore({}, () => require('../src/evaluation-failure').saveEvaluationFailure(record, checklist, 'CLOUD', new Error('Provider timeout Bearer private-key-value https://example.com?sig=private-signature'), { created_at: new Date(future).toISOString() }));
      const base = `http://127.0.0.1:${server.address().port}`;
      const first = await (await fetch(base + '/api/datasets/CLOUD', { headers })).json();
      assert.equal(first.records[0].failures.length, 1);
      const failure = first.records[0].failures[0];
      assert.equal(failure.id, saved.id); assert.equal(failure.status, 'error'); assert.equal(failure.checklist.id, 'default');
      assert.ok(!JSON.stringify(failure).includes('private-key-value')); assert.ok(!JSON.stringify(failure).includes('private-signature'));
      assert.ok(first.records[0].evaluations.length > 0, 'the earlier good/reviewable analysis remains available');
      await cloud.withCloudStore({}, () => {
        const latest = store.list('evaluations')[0]; latest.id = 'newer-success'; latest.created_at = new Date(future + 1000).toISOString(); store.write('evaluations', latest.id, latest);
      });
      const second = await (await fetch(base + '/api/datasets/CLOUD', { headers })).json();
      assert.deepEqual(second.records[0].failures, []);
      const taskCount = Object.keys(snapshot.jobs).length;
      const rejected = await fetch(base + '/api/%65valuate', { method: 'POST', headers: { ...headers, origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ group_id: 'CLOUD', conversation_id: 'test', force: true, request_id: 'untrusted' }) });
      assert.equal(rejected.status, 403); assert.equal(Object.keys(snapshot.jobs).length, taskCount, 'paid routes retain same-origin checks before claiming work');
      const evaluateBody = { group_id: 'CLOUD', conversation_id: 'test', request_id: 'bind-public-error', force: false };
      const reused = { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(evaluateBody) };
      assert.equal((await fetch(base + '/api/evaluate', reused)).status, 200);
      const changed = await fetch(base + '/api/evaluate', { ...reused, body: JSON.stringify({ ...evaluateBody, force: true }) });
      assert.equal(changed.status, 409); assert.equal((await changed.json()).code, 'EVALUATION_INPUT_CHANGED');
    });
    console.log(`hosting: ${passed} checks passed`);
  } finally { if (server.listening) server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });

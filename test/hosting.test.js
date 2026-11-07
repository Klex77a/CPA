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
  await store.withSnapshot(working, { readOnly }, callback);
  if (failCommit) throw new Error('private://database-connection-string');
  snapshot = working;
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
      for (const uri of ['/', '/cqa.js', '/api/config', '/api/datasets']) {
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
      assert.equal((await fetch(base + '/', { headers })).status, 200);
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
    console.log(`hosting: ${passed} checks passed`);
  } finally { if (server.listening) server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });

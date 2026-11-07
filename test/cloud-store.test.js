'use strict';
// Transaction tests use an in-memory PostgreSQL protocol double; no network/keys.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.CQA_STORAGE_DRIVER = 'postgres';
process.env.LLM_PROVIDER = 'mock';
process.env.CQA_DATA_DIR = path.join(os.tmpdir(), `cqa-cloud-no-files-${process.pid}-${Date.now()}`);
const store = require('../src/store');
const { createCloudStore, withCloudStore } = require('../src/cloud-store');
const clone = (value) => JSON.parse(JSON.stringify(value));
const defer = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

class FakePool {
  constructor() { this.rows = new Map(); this.events = []; this.locks = new Map(); this.waiters = new Map(); this.nextClient = 0; this.failCommit = false; }
  async acquire(id, client) {
    while (this.locks.has(id)) await new Promise((resolve) => { const list = this.waiters.get(id) || []; list.push(resolve); this.waiters.set(id, list); });
    this.locks.set(id, client.id); client.locked = id;
  }
  unlock(client) {
    if (client.locked === undefined) return;
    const id = client.locked; client.locked = undefined; this.locks.delete(id);
    this.waiters.get(id)?.shift()?.();
  }
  async connect() {
    const pool = this;
    const client = { id: ++this.nextClient, transaction: false, pending: new Map(), locked: undefined };
    client.query = async (raw, params = []) => {
      const sql = raw.replace(/\s+/g, ' ').trim();
      pool.events.push({ client: client.id, sql, params });
      if (sql.startsWith('CREATE TABLE')) return { rows: [] };
      if (sql.startsWith('INSERT INTO')) {
        if (!pool.rows.has(params[0])) pool.rows.set(params[0], { payload: JSON.parse(params[1]), revision: 0 });
        return { rows: [] };
      }
      if (sql === 'BEGIN') { client.transaction = true; return { rows: [] }; }
      if (sql.includes("set_config('lock_timeout'")) return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.startsWith('SELECT payload')) {
        if (sql.endsWith('FOR UPDATE')) { assert.equal(client.transaction, true); await pool.acquire(params[0], client); }
        const row = pool.rows.get(params[0]); return { rows: row ? [clone(row)] : [] };
      }
      if (sql.startsWith('UPDATE cqa_workspaces')) {
        assert.equal(client.transaction, true); assert.equal(client.locked, params[0]);
        client.pending.set(params[0], { payload: JSON.parse(params[1]), revision: pool.rows.get(params[0]).revision + 1 });
        return { rows: [], rowCount: 1 };
      }
      if (sql === 'COMMIT') {
        if (pool.beforeCommit) { const hook = pool.beforeCommit; pool.beforeCommit = null; await hook(); }
        if (pool.failCommit) { pool.failCommit = false; throw new Error('postgres://user:secret@private-host/database failed'); }
        for (const [id, row] of client.pending) pool.rows.set(id, clone(row));
        client.pending.clear(); client.transaction = false; pool.unlock(client); return { rows: [] };
      }
      if (sql === 'ROLLBACK') { client.pending.clear(); client.transaction = false; pool.unlock(client); return { rows: [] }; }
      throw new Error('Unexpected SQL in software test: ' + sql);
    };
    client.release = (discard) => { pool.events.push({ client: client.id, sql: 'RELEASE', discard }); pool.unlock(client); };
    return client;
  }
}
let passed = 0;
const test = async (name, run) => { await run(); passed++; console.log('✔', name); };

(async () => {
  await test('cloud mode never creates local directories or falls back outside a request', () => {
    assert.equal(store.cloudMode, true);
    assert.equal(fs.existsSync(process.env.CQA_DATA_DIR), false);
    for (const action of [() => store.read('datasets', 'DEV'), () => store.list('evaluations'), () => store.write('jobs', 'one', {}), () => store.remove('jobs', 'one')]) assert.throws(action, (error) => error.status === 503 && error.code === 'CLOUD_STORE_CONTEXT_REQUIRED');
    for (const name of ['CQA_DATABASE_URL', 'DATABASE_URL', 'POSTGRES_URL']) delete process.env[name];
    assert.throws(() => withCloudStore({}, () => {}), (error) => error.status === 503 && /DATABASE_URL/.test(error.message));
  });
  await test('first read seeds the official checklist, and read-only copies cannot mutate data', async () => {
    const pool = new FakePool(), run = createCloudStore({ pool });
    await run({ readOnly: true }, async () => {
      const checklist = store.read('checklists', 'default'); assert.equal(checklist.criteria.length, 8);
      checklist.name = 'changed without write';
      assert.notEqual(store.read('checklists', 'default').name, checklist.name);
      assert.throws(() => store.write('datasets', 'one', {}), (error) => error.code === 'CLOUD_STORE_READ_ONLY');
      assert.throws(() => store.remove('checklists', 'default'), (error) => error.code === 'CLOUD_STORE_READ_ONLY');
    });
    assert.equal(pool.events.filter((event) => event.sql.startsWith('INSERT')).length, 1);
    assert.equal(pool.events.some((event) => event.sql.startsWith('UPDATE')), false);
    const initializationEnd = pool.events.findIndex((event) => event.sql === 'COMMIT');
    assert.equal(pool.events.slice(initializationEnd + 1).some((event) => event.sql === 'BEGIN'), false, 'reads do not open mutation transactions after initialization');
    assert.equal(fs.existsSync(process.env.CQA_DATA_DIR), false);
  });
  await test('mutations commit before resolving, support safe imported IDs, and preserve copy semantics', async () => {
    const pool = new FakePool(), run = createCloudStore({ pool });
    await run({ readOnly: true }, () => {});
    const commitEntered = defer(), allowCommit = defer(); let resolved = false;
    pool.beforeCommit = async () => { commitEntered.resolve(); await allowCommit.promise; };
    const pending = run({}, async () => {
      const record = { id: '__proto__', value: 1 };
      store.write('jobs', record.id, record); record.value = 99;
      assert.equal(store.read('jobs', record.id).value, 1);
      assert.equal(Object.getPrototypeOf(store.list('jobs')[0]), Object.prototype);
      store.write('datasets', 'a/b', { id: 'a/b' });
      store.write('datasets', 'a?b', { id: 'a?b' });
      assert.equal(store.list('datasets').length, 2);
      return { status: 201 };
    }).then((result) => { resolved = true; return result; });
    await commitEntered.promise;
    assert.equal(resolved, false); assert.equal(Object.keys(pool.rows.get('midnight-commit').payload.jobs).length, 0);
    allowCommit.resolve(); assert.deepEqual(await pending, { status: 201 });
    await run({ readOnly: true }, () => assert.equal(store.read('jobs', '__proto__').value, 1));
    assert.equal(pool.rows.get('midnight-commit').revision, 1);
    assert.ok(pool.events.find((event) => event.sql.includes("set_config('lock_timeout'")));
  });
  await test('a callback failure rolls back, releases its client, and preserves the domain status', async () => {
    const pool = new FakePool(), run = createCloudStore({ pool });
    const failure = Object.assign(new Error('Некорректный исходный диалог'), { status: 400 });
    await assert.rejects(run({}, async () => { store.write('datasets', 'bad', { id: 'bad' }); throw failure; }), (error) => error === failure);
    await run({ readOnly: true }, () => assert.equal(store.read('datasets', 'bad'), null));
    assert.equal(pool.rows.get('midnight-commit').revision, 0);
    assert.ok(pool.events.some((event) => event.sql === 'ROLLBACK'));
    assert.equal(pool.events.filter((event) => event.sql === 'RELEASE').length, 2);
  });
  await test('database failures are safe, roll back, and never repeat a paid callback', async () => {
    const pool = new FakePool(), run = createCloudStore({ pool }); let calls = 0;
    await run({ readOnly: true }, () => {});
    pool.failCommit = true;
    await assert.rejects(run({}, () => { calls++; store.write('evaluations', 'paid', { id: 'paid' }); return { ok: true }; }), (error) => error.status === 503 && !/secret|private-host|postgres:/.test(error.message));
    assert.equal(calls, 1);
    assert.equal(pool.rows.get('midnight-commit').payload.evaluations.paid, undefined);
    assert.equal(pool.events.filter((event) => event.sql === 'COMMIT').length, 2);
    assert.ok(pool.events.some((event) => event.sql === 'ROLLBACK'));
    const disconnected = createCloudStore({ pool: { connect: async () => { throw new Error('postgres://password@host'); } } });
    await assert.rejects(disconnected({}, () => {}), (error) => error.status === 503 && !error.message.includes('password'));
  });
  await test('concurrent requests keep contexts isolated and serialize workspace updates without lost writes', async () => {
    const pool = new FakePool(), run = createCloudStore({ pool });
    const firstEntered = defer(), finishFirst = defer(); let secondEntered = false;
    const first = run({}, async () => {
      store.write('jobs', 'first', { id: 'first' }); firstEntered.resolve();
      await finishFirst.promise; assert.equal(store.read('jobs', 'second'), null);
    });
    await firstEntered.promise;
    const second = run({}, async () => {
      secondEntered = true; assert.equal(store.read('jobs', 'first').id, 'first');
      await Promise.resolve(); store.write('jobs', 'second', { id: 'second' });
    });
    await run({ readOnly: true }, () => assert.deepEqual(store.list('jobs'), []));
    assert.equal(secondEntered, false);
    finishFirst.resolve(); await Promise.all([first, second]);
    await run({ readOnly: true }, () => assert.deepEqual(store.list('jobs').map((job) => job.id), ['first', 'second']));
    assert.equal(pool.rows.get('midnight-commit').revision, 2);
    assert.throws(() => store.list('jobs'), (error) => error.code === 'CLOUD_STORE_CONTEXT_REQUIRED');
  });
  await test('workspace IDs remain parameterized and separate teams cannot see one another', async () => {
    const pool = new FakePool();
    const first = createCloudStore({ pool, workspaceId: "team'; DROP TABLE cqa_workspaces; --" });
    const second = createCloudStore({ pool, workspaceId: 'another-team' });
    await first({}, () => store.write('jobs', 'private', { team: 1 }));
    await second({ readOnly: true }, () => assert.equal(store.read('jobs', 'private'), null));
    assert.equal(pool.rows.size, 2);
    assert.equal(pool.events.some((event) => event.sql.includes('DROP TABLE')), false);
    assert.throws(() => createCloudStore({ pool, workspaceId: '' }), (error) => error.status === 503);
  });
  await test('unawaited work cannot mutate a snapshot after its transaction scope finishes', async () => {
    const pool = new FakePool(), run = createCloudStore({ pool }), proceed = defer(); let late;
    await run({}, () => {
      late = proceed.promise.then(() => store.write('jobs', 'too-late', { id: 'too-late' }));
    });
    proceed.resolve();
    await assert.rejects(late, (error) => error.code === 'CLOUD_STORE_CONTEXT_EXPIRED');
    assert.equal(pool.rows.get('midnight-commit').payload.jobs['too-late'], undefined);
  });
  await test('invalid durable snapshots fail closed instead of creating local fallback data', async () => {
    const pool = new FakePool(), run = createCloudStore({ pool });
    await run({ readOnly: true }, () => {});
    pool.rows.get('midnight-commit').payload = { jobs: [] };
    await assert.rejects(run({ readOnly: true }, () => store.list('jobs')), (error) => error.status === 503);
    assert.equal(fs.existsSync(process.env.CQA_DATA_DIR), false);
  });
  console.log(`cloud-store: пройдено ${passed}`);
})().catch((error) => { console.error(error); process.exitCode = 1; });

'use strict';
// Transaction tests use an in-memory PostgreSQL protocol double; no network/keys.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.CQA_STORAGE_DRIVER = 'postgres';
process.env.LLM_PROVIDER = 'mock';
process.env.CQA_DATA_DIR = path.join(os.tmpdir(), `cqa-cloud-no-files-${process.pid}-${Date.now()}`);
const store = require('../src/store');
const { createCloudStore, withCloudStore } = require('../src/cloud-store');
const { cacheKey } = require('../src/evaluator');
const { evaluationFreshness } = require('../src/evaluation-freshness');
const defaultChecklist = require('../src/default-checklist.json');
const clone = (value) => JSON.parse(JSON.stringify(value));
// PostgreSQL JSONB normalizes object keys recursively. Simulate that property
// so changing the production column/casts back to JSONB breaks identity tests.
const normalizeJsonb = (value) => Array.isArray(value) ? value.map(normalizeJsonb) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeJsonb(value[key])])) : value;
const transcriptHash = (transcript) => crypto.createHash('sha256').update(JSON.stringify(transcript)).digest('hex').slice(0, 16);
const defer = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

class FakePool {
  constructor({ payloadType = null } = {}) { this.payloadType = payloadType; this.rows = new Map(); this.events = []; this.locks = new Map(); this.waiters = new Map(); this.nextClient = 0; this.failCommit = false; }
  decodePayload(sql, value) {
    assert.equal(/\$2::(jsonb?)(?:\W|$)/.exec(sql)?.[1], this.payloadType, 'writes use an explicit cast matching the durable column');
    const parsed = JSON.parse(value);
    return this.payloadType === 'jsonb' ? normalizeJsonb(parsed) : parsed;
  }
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
      if (sql.startsWith('CREATE TABLE')) {
        if (!pool.payloadType) pool.payloadType = /payload (jsonb?) NOT NULL/.exec(sql)?.[1];
        return { rows: [] };
      }
      if (sql.startsWith('SELECT format_type')) return { rows: pool.payloadType ? [{ payload_type: pool.payloadType }] : [] };
      if (sql.startsWith('ALTER TABLE')) {
        assert.equal(sql, 'ALTER TABLE cqa_workspaces ALTER COLUMN payload TYPE json USING payload::json');
        assert.equal(client.transaction, true);
        assert.equal(pool.payloadType, 'jsonb', 'only an existing JSONB payload needs migration');
        pool.payloadType = 'json';
        return { rows: [] };
      }
      if (sql.startsWith('INSERT INTO')) {
        const payload = pool.decodePayload(sql, params[1]);
        if (!pool.rows.has(params[0])) pool.rows.set(params[0], { payload, revision: 0 });
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
        client.pending.set(params[0], { payload: pool.decodePayload(sql, params[1]), revision: pool.rows.get(params[0]).revision + 1 });
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
    assert.equal(pool.payloadType, 'json');
    assert.equal(pool.events.some((event) => event.sql.startsWith('ALTER TABLE')), false);
    assert.equal(pool.events.some((event) => event.sql.startsWith('UPDATE')), false);
    const initializationEnd = pool.events.findIndex((event) => event.sql === 'COMMIT');
    assert.equal(pool.events.slice(initializationEnd + 1).some((event) => event.sql === 'BEGIN'), false, 'reads do not open mutation transactions after initialization');
    assert.equal(fs.existsSync(process.env.CQA_DATA_DIR), false);
  });
  await test('JSON round trips preserve original serialization, transcript freshness and legacy cache identity', async () => {
    const pool = new FakePool(), run = createCloudStore({ pool });
    const record = {
      conversation_id: 'ordered-transcript', channel: 'chat', language: 'ru',
      transcript: [{ timestamp: 0, speaker: 'operator', text: 'Synthetic greeting' }, { timestamp: 1000, speaker: 'client', text: 'Synthetic question' }],
    };
    const checklist = clone(defaultChecklist);
    const dataset = { group_id: 'SYNTHETIC', records: [record] };
    const evaluation = {
      id: 'saved-result', conversation_id: record.conversation_id, channel: record.channel, language: record.language,
      checklist: { id: checklist.id, version: checklist.version }, transcript_hash: transcriptHash(record.transcript),
      cache_key: cacheKey(record, checklist),
    };
    assert.notEqual(transcriptHash(normalizeJsonb(record.transcript)), evaluation.transcript_hash, 'the fixture detects JSONB object-key normalization');
    assert.notEqual(cacheKey(normalizeJsonb(record), normalizeJsonb(checklist)), evaluation.cache_key);
    await run({}, () => {
      store.write('datasets', dataset.group_id, dataset);
      store.write('checklists', checklist.id, checklist);
      store.write('evaluations', evaluation.id, evaluation);
    });
    // An unrelated update rewrites the complete workspace. A fresh adapter then
    // follows the same bootstrap/read path as a separate serverless instance.
    await run({}, () => store.write('jobs', 'unrelated', { id: 'unrelated' }));
    const readAgain = createCloudStore({ pool });
    await readAgain({ readOnly: true }, () => {
      const savedDataset = store.read('datasets', dataset.group_id);
      const savedChecklist = store.read('checklists', checklist.id);
      const savedEvaluation = store.read('evaluations', evaluation.id);
      assert.equal(JSON.stringify(savedDataset), JSON.stringify(dataset));
      assert.equal(JSON.stringify(savedChecklist), JSON.stringify(checklist));
      assert.equal(JSON.stringify(savedEvaluation), JSON.stringify(evaluation));
      assert.equal(cacheKey(savedDataset.records[0], savedChecklist), savedEvaluation.cache_key);
      assert.deepEqual(evaluationFreshness(savedEvaluation, savedDataset.records[0], savedChecklist), { stale: false, stale_reasons: [], record_changed: false });
    });
    assert.equal(pool.events.some((event) => event.sql.startsWith('ALTER TABLE')), false);
  });
  await test('an existing JSONB workspace is converted once under the bootstrap lock without losing records', async () => {
    const pool = new FakePool({ payloadType: 'jsonb' });
    const payload = normalizeJsonb({ datasets: { DEV: { group_id: 'DEV', records: [{ conversation_id: 'existing' }] } }, checklists: { default: clone(defaultChecklist) }, evaluations: { prior: { id: 'prior', history: [{ action: 'confirmed' }] } }, appeals: {}, failures: {}, jobs: {} });
    pool.rows.set('midnight-commit', { payload: clone(payload), revision: 7 });
    const run = createCloudStore({ pool });
    await run({ readOnly: true }, () => assert.deepEqual(store.read('datasets', 'DEV'), payload.datasets.DEV));
    await run({ readOnly: true }, () => assert.deepEqual(store.read('evaluations', 'prior'), payload.evaluations.prior));
    await createCloudStore({ pool })({ readOnly: true }, () => {});
    assert.equal(pool.payloadType, 'json');
    assert.deepEqual(pool.rows.get('midnight-commit'), { payload, revision: 7 });
    const alters = pool.events.filter((event) => event.sql.startsWith('ALTER TABLE'));
    assert.equal(alters.length, 1, 'already migrated JSON columns are never altered on later cold starts');
    const alterIndex = pool.events.indexOf(alters[0]);
    const bootstrap = pool.events.slice(0, alterIndex + 1);
    assert.ok(bootstrap.findIndex((event) => event.sql === 'BEGIN') < bootstrap.findIndex((event) => event.sql.includes('pg_advisory_xact_lock')));
    assert.ok(bootstrap.findIndex((event) => event.sql.includes('pg_advisory_xact_lock')) < bootstrap.findIndex((event) => event.sql.startsWith('SELECT format_type')));
    assert.equal(bootstrap.some((event) => event.sql === 'COMMIT'), false, 'migration stays inside the bootstrap transaction');
    assert.equal(pool.events.some((event) => /DELETE|DROP TABLE|TRUNCATE/.test(event.sql)), false);
  });
  await test('an unexpected existing payload type fails closed without altering the table or running callbacks', async () => {
    const pool = new FakePool({ payloadType: 'text' }), run = createCloudStore({ pool });
    let calls = 0;
    await assert.rejects(run({}, () => { calls++; }), (error) => error.status === 503);
    assert.equal(calls, 0);
    assert.equal(pool.events.some((event) => event.sql.startsWith('ALTER TABLE')), false);
    assert.equal(pool.events.some((event) => event.sql === 'ROLLBACK'), true);
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

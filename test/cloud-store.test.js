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

async function operationHarness() {
  const pool = new FakePool();
  const run = createCloudStore({ pool });
  const transact = (callback) => run({}, callback);
  const records = [0, 1].map((index) => ({ conversation_id: `slow-${index}`, channel: 'agent chat', language: 'RU', transcript: [{ timestamp: '00:00', speaker: 'client', text: `Synthetic ${index}` }] }));
  const checklist = clone(defaultChecklist);
  await transact(() => store.write('datasets', 'OPERATIONS', { group_id: 'OPERATIONS', records }));
  let clock = Date.parse('2026-11-08T00:00:00Z'), calls = 0;
  const pendingResults = new Map();
  const started = defer(), release = defer();
  const evaluate = async (record, selected, group, options) => {
    calls++; assert.equal(pool.locks.size, 0, 'model work must not hold any workspace row lock');
    started.resolve(); await release.promise;
    return { id: `paid-result-${calls}`, group_id: group, conversation_id: record.conversation_id, cache_key: cacheKey(record, selected), transcript_hash: transcriptHash(record.transcript), channel: record.channel, language: record.language, record_snapshot: clone(record), checklist_snapshot: clone(selected), checklist: { id: selected.id, version: selected.version }, status: 'ok', created_at: new Date(clock).toISOString(), cost_usd: 0.003, duration_ms: 123, appeals: [], operation_id: options.operation_id };
  };
  const dependencies = { store, transact, evaluate, cacheKey, now: () => clock, leaseMs: 1000, pendingResults };
  const create = (overrides = {}) => require('../src/cloud-evaluation').createCloudEvaluation({ ...dependencies, ...overrides });
  return { pool, run, transact, records, checklist, started, release, dependencies, create, pendingResults, calls: () => calls, advance: (ms) => { clock += ms; } };
}

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
  await test('external evaluation releases the row lock; edits and appeals survive finalization and duplicate requests do not pay twice', async () => {
    const h = await operationHarness();
    await h.transact(() => store.write('evaluations', 'existing', { id: 'existing', appeals: [] }));
    const body = { group_id: 'OPERATIONS', conversation_id: 'slow-0', request_id: 'same-request', force: true };
    const work = h.create().perform(body);
    await h.started.promise;
    await assert.rejects(h.create().perform(body), (error) => error.status === 409);
    assert.equal(h.calls(), 1);
    await h.transact(() => {
      const old = store.read('evaluations', 'existing'); old.appeals.push({ id: 'accepted-during-model', status: 'resolved' }); store.write('evaluations', old.id, old);
      const current = store.read('checklists', 'default'); current.version++; current.criteria[0].title = 'Edited during model'; store.write('checklists', current.id, current);
      const dataset = store.read('datasets', 'OPERATIONS'); dataset.records[0].transcript[0].text = 'Reimported during model'; store.write('datasets', dataset.group_id, dataset);
    });
    h.release.resolve(); const result = await work;
    assert.equal(result.checklist.version, h.checklist.version);
    assert.equal(result.record_snapshot.transcript[0].text, 'Synthetic 0');
    await assert.rejects(h.create().perform(body), (error) => error.code === 'EVALUATION_INPUT_CHANGED', 'a changed source/rules cannot be returned as the old operation outcome');
    assert.equal(h.calls(), 1);
    await h.run({ readOnly: true }, () => {
      assert.equal(store.read('evaluations', 'existing').appeals.length, 1);
      assert.equal(store.read('checklists', 'default').criteria[0].title, 'Edited during model');
      assert.equal(store.read('datasets', 'OPERATIONS').records[0].transcript[0].text, 'Reimported during model');
      assert.ok(store.read('evaluations', result.id));
    });
    assert.equal(h.pool.locks.size, 0);
  });

  await test('completed forced operations replay across worker instances without another paid call', async () => {
    const h = await operationHarness(); h.release.resolve();
    const body = { group_id: 'OPERATIONS', conversation_id: 'slow-0', request_id: 'durable-replay', force: true };
    const first = await h.create().perform(body);
    const second = await h.create({ pendingResults: new Map() }).perform(body);
    assert.equal(second.id, first.id); assert.equal(second.cached, true); assert.equal(h.calls(), 1);
    await assert.rejects(h.create().perform({ ...body, force: false }), (error) => error.code === 'EVALUATION_INPUT_CHANGED');
    await assert.rejects(h.create().perform({ ...body, conversation_id: 'slow-1' }), (error) => error.code === 'EVALUATION_INPUT_CHANGED');
    await h.transact(() => store.write('checklists', 'another', { ...h.checklist, id: 'another' }));
    await assert.rejects(h.create().perform({ ...body, checklist_id: 'another' }), (error) => error.code === 'EVALUATION_INPUT_CHANGED');
    assert.equal(h.calls(), 1);
    const cachedBody = { ...body, request_id: 'cached-read', force: false };
    await h.create().perform(cachedBody);
    await assert.rejects(h.create().perform({ ...cachedBody, force: true }), (error) => error.code === 'EVALUATION_INPUT_CHANGED', 'cached operations also bind their original intent');
  });

  await test('pending paid results are bounded and expire without automatic rebilling; durable replay clears acknowledged results', async () => {
    const h = await operationHarness(); h.release.resolve();
    const service = h.create({ pendingLimit: 1, pendingTtlMs: 20 });
    const claim = (index) => h.transact(() => service.claim({ record: h.records[index], checklist: h.checklist, groupId: 'OPERATIONS', force: true, requestId: `memory-${index}` }));
    const first = await claim(0); await service.execute(first.task);
    const second = await claim(1); await service.execute(second.task);
    assert.equal(h.pendingResults.size, 1); assert.equal(service.pending(first.task.id), undefined);
    h.advance(21); assert.equal(service.pending(second.task.id), undefined); assert.equal(h.pendingResults.size, 0);
    h.advance(1000);
    await assert.rejects(service.perform({ group_id: 'OPERATIONS', conversation_id: 'slow-0', request_id: 'memory-0', force: true }), (error) => error.code === 'EVALUATION_UNCERTAIN');
    assert.equal(h.calls(), 2);
    const next = await h.transact(() => service.claim({ record: h.records[0], checklist: h.checklist, groupId: 'OPERATIONS', force: true, requestId: 'acknowledged' }));
    const result = await service.execute(next.task);
    await h.transact(() => service.complete(next.task, result)); // Simulate a lost commit acknowledgement.
    assert.equal(h.pendingResults.size, 1);
    const replay = await service.perform({ group_id: 'OPERATIONS', conversation_id: 'slow-0', request_id: 'acknowledged', force: true });
    assert.equal(replay.cached, true); assert.equal(h.pendingResults.size, 0); assert.equal(h.calls(), 3);
  });

  await test('a failed claim commit makes no model call; a failed result commit retries only persistence', async () => {
    const h = await operationHarness();
    const body = { group_id: 'OPERATIONS', conversation_id: 'slow-0', request_id: 'commit-recovery', force: true };
    h.pool.failCommit = true;
    await assert.rejects(h.create().perform(body), (error) => error.status === 503);
    assert.equal(h.calls(), 0);
    const work = h.create().perform(body); await h.started.promise;
    h.pool.failCommit = true; h.release.resolve();
    await assert.rejects(work, (error) => error.status === 503 && !error.message.includes('secret'));
    assert.equal(h.calls(), 1); assert.equal(h.pendingResults.size, 1);
    const recovered = await h.create().perform(body);
    assert.equal(recovered.status, 'ok'); assert.equal(h.calls(), 1); assert.equal(h.pendingResults.size, 0);
    await h.run({ readOnly: true }, () => assert.ok(store.read('evaluations', recovered.id)));
  });

  await test('process loss leaves an uncertain durable lease and never automatically repeats a paid request', async () => {
    const h = await operationHarness();
    await h.transact(() => h.create().claim({ record: h.records[0], checklist: h.checklist, groupId: 'OPERATIONS', requestId: 'lost-worker' }));
    h.advance(1001);
    const fresh = h.create({ pendingResults: new Map() });
    await assert.rejects(fresh.perform({ group_id: 'OPERATIONS', conversation_id: 'slow-0', request_id: 'next-request' }), (error) => error.code === 'EVALUATION_UNCERTAIN');
    assert.equal(h.calls(), 0);
    await h.run({ readOnly: true }, () => { assert.equal(store.list('failures').length, 1); assert.match(store.list('failures')[0].validation_errors[0], /Списание/); });
    h.release.resolve();
    await fresh.perform({ group_id: 'OPERATIONS', conversation_id: 'slow-0', request_id: 'intentional-retry', force: true });
    assert.equal(h.calls(), 1);
    const cached = await fresh.perform({ group_id: 'OPERATIONS', conversation_id: 'slow-0', request_id: 'later-read' });
    assert.equal(cached.cached, true); assert.equal(h.calls(), 1, 'a successful explicit retry clears the uncertainty barrier for cache reads');
  });

  await test('cancellation commits while a slow batch step waits; its paid result survives and queued work never starts', async () => {
    const h = await operationHarness();
    const create = () => require('../src/cloud-batch').createCloudBatch(h.dependencies);
    const batch = create();
    const job = await h.transact(() => batch.createBatch({ group_id: 'OPERATIONS' }));
    const step = batch.stepBatch(job.id); await h.started.promise;
    const duplicate = await create().stepBatch(job.id);
    assert.equal(duplicate.counts.running, 1); assert.equal(h.calls(), 1);
    const stopped = await h.transact(() => create().cancelBatch(job.id));
    assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.counts.cancelled, 1);
    h.release.resolve(); const saved = await step;
    assert.equal(saved.status, 'cancelled'); assert.equal(saved.done, 1); assert.equal(saved.counts.done, 1); assert.equal(saved.counts.cancelled, 1);
    await create().stepBatch(job.id); assert.equal(h.calls(), 1);
    await h.run({ readOnly: true }, () => assert.equal(store.list('evaluations').length, 1));
  });

  await test('batch finalization failure preserves checkpoint and retries persistence without repeating the model', async () => {
    const h = await operationHarness();
    const batch = require('../src/cloud-batch').createCloudBatch(h.dependencies);
    const job = await h.transact(() => batch.createBatch({ group_id: 'OPERATIONS', conversation_ids: ['slow-0'] }));
    const step = batch.stepBatch(job.id); await h.started.promise;
    h.pool.failCommit = true; h.release.resolve();
    await assert.rejects(step, (error) => error.status === 503);
    const recovered = await batch.stepBatch(job.id);
    assert.equal(recovered.status, 'finished'); assert.equal(recovered.done, 1); assert.equal(recovered.cost_usd, 0.003); assert.equal(h.calls(), 1);
    await batch.stepBatch(job.id); assert.equal(h.calls(), 1);
  });
  console.log(`cloud-store: пройдено ${passed}`);
})().catch((error) => { console.error(error); process.exitCode = 1; });

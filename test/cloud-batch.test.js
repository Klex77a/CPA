'use strict';
// Durable batch regressions use an isolated in-memory store and a fake evaluator.
// They never send a model request or modify the local application datastore.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
process.env.LLM_PROVIDER = 'mock';
const { createCloudBatch } = require('../src/cloud-batch');
const defaultChecklist = require('../src/default-checklist.json');
const clone = (value) => JSON.parse(JSON.stringify(value));
const sha = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function setup(recordCount = 2) {
  const collections = new Map();
  let sequence = 0, ticks = 1000000;
  const calls = [], failures = [];
  const store = {
    read(dir, id) { const value = collections.get(dir)?.get(id); return value ? clone(value) : null; },
    write(dir, id, value) { if (!collections.has(dir)) collections.set(dir, new Map()); collections.get(dir).set(id, clone(value)); return value; },
    list(dir) { return [...(collections.get(dir)?.values() || [])].map(clone); },
    remove(dir, id) { collections.get(dir)?.delete(id); },
    newId(prefix) { return `${prefix}-${++sequence}`; },
  };
  const records = Array.from({ length: recordCount }, (_, index) => ({ conversation_id: `case-${index}`, channel: 'agent chat', language: 'RU', transcript: [{ timestamp: '00:00', speaker: 'operator', text: `Синтетическая реплика ${index}.` }] }));
  const checklist = clone(defaultChecklist);
  const cacheKey = (record, cl) => sha({ id: record.conversation_id, text: record.transcript, channel: record.channel, language: record.language, cl });
  store.write('datasets', 'SYNTHETIC', { group_id: 'SYNTHETIC', records });
  store.write('checklists', 'default', checklist);
  let implementation = async (record, cl, group, options) => ({ id: `evaluation-${record.conversation_id}-${calls.length}`, group_id: group, conversation_id: record.conversation_id, cache_key: cacheKey(record, cl), status: 'ok', cost_usd: 0.002, duration_ms: 25, created_at: new Date(ticks++).toISOString(), record_snapshot: record, checklist_snapshot: cl, force: options.force });
  const dependencies = {
    store, cacheKey, now: () => ticks++,
    evaluate: async (...args) => { calls.push(clone(args)); return implementation(...args); },
    saveEvaluationFailure: (record, cl, group, error) => { failures.push({ record: clone(record), checklist: clone(cl), group, metrics: error.evaluation_metrics }); },
  };
  return { store, records, checklist, calls, failures, cacheKey, api: createCloudBatch(dependencies), restart: () => createCloudBatch(dependencies), setEvaluator: (fn) => { implementation = fn; } };
}

let passed = 0;
async function test(name, run) { await run(); passed++; console.log('✔', name); }

(async () => {
  await test('creation validates source and explicit selection before any evaluation', () => {
    const h = setup();
    for (const body of [null, [], {}, { group_id: ' ' }, { group_id: 1 }, { group_id: 'SYNTHETIC', force: 'false' }]) assert.throws(() => h.api.createBatch(body), { status: 400 });
    assert.throws(() => h.api.createBatch({ group_id: 'missing' }), { status: 404 });
    assert.throws(() => h.api.createBatch({ group_id: 'SYNTHETIC', checklist_id: 'missing' }), { status: 404 });
    for (const selection of [[], null, '', 'all', [null], ['missing'], ['case-0', 'case-0']]) assert.throws(() => h.api.createBatch({ group_id: 'SYNTHETIC', conversation_ids: selection }), { status: 400 });
    assert.equal(h.store.list('jobs').length, 0);
    assert.equal(h.calls.length, 0);
    const selected = h.api.createBatch({ group_id: 'SYNTHETIC', conversation_ids: ['case-1'] });
    assert.equal(selected.total, 1);
    assert.deepEqual(h.store.read('jobs', selected.id).records.map((record) => record.conversation_id), ['case-1']);
  });

  await test('GET is pure; durable progress survives independent worker instances and hides snapshots', async () => {
    const h = setup();
    const job = h.api.createBatch({ group_id: 'SYNTHETIC' });
    assert.equal(job.execution_mode, 'stepped');
    assert.equal(job.status, 'running');
    for (const hidden of ['records', 'checklist_snapshot', 'force', 't0', 'items']) assert.ok(!(hidden in job));
    const before = h.store.read('jobs', job.id);
    const view = h.restart().getBatch(job.id); view.counts.queued = 100;
    assert.deepEqual(h.store.read('jobs', job.id), before);
    assert.equal(h.calls.length, 0);
    const first = await h.api.stepBatch(job.id);
    assert.equal(first.done, 1); assert.equal(first.status, 'running');
    assert.equal(h.calls.length, 1); assert.equal(h.store.list('evaluations').length, 1);
    const final = await h.restart().stepBatch(job.id);
    assert.equal(final.done, 2); assert.equal(final.status, 'finished');
    assert.equal(final.cost_usd, 0.004); assert.equal(h.calls.length, 2);
    assert.deepEqual(final.counts, { done: 2 });
    assert.deepEqual(await h.restart().stepBatch(job.id), final);
    assert.equal(h.calls.length, 2, 'retry after completion never re-evaluates a finished item');
  });

  await test('cache selection isolates groups and keeps a latest needs-review result without paid retry', async () => {
    const h = setup();
    const key = h.cacheKey(h.records[0], h.checklist);
    for (const saved of [
      { id: 'old-ok', group_id: 'SYNTHETIC', status: 'ok', created_at: '2026-01-01T00:00:00Z' },
      { id: 'new-review', group_id: 'SYNTHETIC', status: 'needs_review', created_at: '2026-01-02T00:00:00Z' },
      { id: 'foreign', group_id: 'OTHER', status: 'ok', created_at: '2026-01-03T00:00:00Z' },
    ]) h.store.write('evaluations', saved.id, { ...saved, conversation_id: 'case-0', cache_key: key });
    h.store.write('evaluations', 'foreign-second', { id: 'foreign-second', group_id: 'OTHER', status: 'ok', conversation_id: 'case-1', cache_key: h.cacheKey(h.records[1], h.checklist), created_at: '2026-01-03T00:00:00Z' });
    const job = h.api.createBatch({ group_id: 'SYNTHETIC' });
    const skipped = await h.api.stepBatch(job.id);
    assert.equal(skipped.skipped, 1); assert.deepEqual(skipped.counts, { needs_review: 1, queued: 1 });
    assert.equal(h.calls.length, 0);
    await h.api.stepBatch(job.id);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0][0].conversation_id, 'case-1');
    const forced = h.api.createBatch({ group_id: 'SYNTHETIC', conversation_ids: ['case-0'], force: true });
    await h.api.stepBatch(forced.id);
    assert.equal(h.calls.length, 2); assert.equal(h.calls[1][3].force, true);
    assert.ok(h.store.read('evaluations', 'old-ok')); assert.ok(h.store.read('evaluations', 'new-review'));
  });

  await test('failed paid responses retain measured cost and safe error text; later steps still finish', async () => {
    const h = setup(3);
    h.setEvaluator(async (record) => {
      if (record.conversation_id === 'case-0') throw Object.assign(new Error('Provider rejected Bearer hidden-credential'), { evaluation_metrics: { usage: { input: 10, output: 20, thoughts: 0 }, cost_usd: 0.003 } });
      if (record.conversation_id === 'case-1') throw new Error('No response');
      return { id: 'last-ok', status: 'ok', cost_usd: 0.002, duration_ms: 10 };
    });
    const job = h.api.createBatch({ group_id: 'SYNTHETIC' });
    await h.api.stepBatch(job.id); await h.api.stepBatch(job.id);
    const final = await h.api.stepBatch(job.id);
    assert.equal(final.status, 'finished'); assert.equal(final.done, 3);
    assert.deepEqual(final.counts, { error: 2, done: 1 });
    assert.equal(final.cost_usd, 0.005); assert.equal(final.unknown_cost_count, 1);
    assert.equal(h.failures.length, 2); assert.equal(h.failures[0].metrics.cost_usd, 0.003);
    assert.ok(!final.errors[0].error.includes('hidden-credential'));
    assert.match(final.errors[0].error, /REDACTED/);
  });

  await test('reimported or deleted source cannot reuse original proof; checkpoint freezes the chosen checklist', async () => {
    const h = setup(3);
    const job = h.api.createBatch({ group_id: 'SYNTHETIC' });
    const dataset = h.store.read('datasets', 'SYNTHETIC');
    dataset.records[0].transcript[0].text = 'NEW SOURCE';
    dataset.records.splice(1, 1);
    h.store.write('datasets', 'SYNTHETIC', dataset);
    const changed = h.store.read('checklists', 'default'); changed.version = 2; changed.criteria[0].title = 'New checklist';
    h.store.write('checklists', 'default', changed);
    await h.api.stepBatch(job.id); await h.api.stepBatch(job.id);
    const final = await h.api.stepBatch(job.id);
    assert.equal(final.errors.length, 2); assert.equal(h.failures.length, 0, 'source changes are not invented model attempts');
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0].conversation_id, 'case-2');
    assert.equal(h.calls[0][1].version, 1); assert.equal(h.calls[0][1].criteria[0].title, h.checklist.criteria[0].title);
    assert.equal(h.store.read('jobs', job.id).records[0].transcript[0].text, h.records[0].transcript[0].text);
  });

  await test('cancel is durable and idempotent; queued work never runs after cancellation', async () => {
    const h = setup();
    const job = h.api.createBatch({ group_id: 'SYNTHETIC' });
    await h.api.stepBatch(job.id);
    const stopped = h.restart().cancelBatch(job.id);
    assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.done, 1);
    assert.deepEqual(stopped.counts, { done: 1, cancelled: 1 });
    assert.deepEqual(await h.restart().stepBatch(job.id), stopped);
    assert.deepEqual(h.restart().cancelBatch(job.id), stopped);
    assert.equal(h.calls.length, 1); assert.equal(h.store.list('evaluations').length, 1);
    assert.throws(() => h.api.getBatch('missing'), { status: 404 });
    assert.throws(() => h.api.cancelBatch('missing'), { status: 404 });
    await assert.rejects(h.api.stepBatch('missing'), { status: 404 });
    const empty = setup(0); const done = empty.api.createBatch({ group_id: 'SYNTHETIC' });
    assert.equal(done.status, 'finished'); assert.equal(done.total, 0);
    await empty.api.stepBatch(done.id); assert.equal(empty.calls.length, 0);
  });
  console.log(`cloud-batch: пройдено ${passed}`);
})().catch((error) => { console.error(error); process.exitCode = 1; });

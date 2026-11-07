'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { COLLECTIONS, MAX_BYTES, importEntries, exportEntries, chunkEntries } = require('../src/workspace-transfer');
const { parseArgs, migrateWorkspace } = require('../scripts/migrate-workspace');
const { computeScore } = require('../src/scoring');
const checklist = require('../src/default-checklist.json');
const clone = (value) => JSON.parse(JSON.stringify(value));
const record = { conversation_id: 'fixture-chat', channel: 'agent chat', language: 'RU', transcript: [{ speaker: 'operator', timestamp: '00:00', text: 'PRIVATE_TRANSCRIPT' }] };
const dataset = { group_id: 'fixture-group', total_records: 1, records: [record] };
const criteria = Object.fromEntries(checklist.criteria.map((criterion) => [criterion.id, {
  answer: criterion.type === 'flag' ? 'NO' : criterion.type === 'scale' ? 'SCORE' : 'YES',
  value: criterion.type === 'scale' ? Math.max(...criterion.scale.map((step) => step.value)) : null,
  explanation: 'Fixture rationale', evidence: [{ msg: 0 }], issues: [],
}]));
const evaluation = {
  id: 'fixture-evaluation', group_id: dataset.group_id, conversation_id: record.conversation_id,
  channel: record.channel, language: record.language, provider: 'test-fixture', model: 'no-network',
  checklist: { id: checklist.id, version: checklist.version }, checklist_snapshot: checklist,
  status: 'ok', validation_errors: [], created_at: '2026-11-07T00:00:00Z',
  criteria, final_criteria: clone(criteria), original_result: computeScore(checklist, criteria), final_result: computeScore(checklist, criteria), appeals: [], coaching: [], cost_usd: 0,
};
const entries = [
  { collection: 'datasets', id: dataset.group_id, value: dataset },
  { collection: 'checklists', id: checklist.id, value: checklist },
  { collection: 'evaluations', id: evaluation.id, value: evaluation },
];
function memory(initial = []) {
  const collections = Object.fromEntries(COLLECTIONS.map((name) => [name, new Map()]));
  let writes = 0;
  for (const entry of initial) collections[entry.collection].set(entry.id, clone(entry.value));
  return {
    get writes() { return writes; },
    read: (collection, id) => collections[collection].has(id) ? clone(collections[collection].get(id)) : null,
    list: (collection) => [...collections[collection].values()].map(clone),
    write: (collection, id, value) => { writes++; collections[collection].set(id, clone(value)); return value; },
  };
}
let passed = 0;
async function test(name, run) { await run(); passed++; console.log('✔', name); }

(async () => {
  await test('import preserves source, original/final results and history; identical retry is idempotent', () => {
    const store = memory();
    assert.equal(importEntries({ entries }, { store }).imported, 3);
    assert.equal(importEntries({ entries: clone(entries) }, { store }).skipped, 3);
    assert.equal(store.writes, 3);
    assert.deepEqual(store.read('evaluations', evaluation.id), evaluation);
    assert.deepEqual(exportEntries(store), entries);
    const reordered = { ...entries[0], value: { records: dataset.records, total_records: 1, group_id: dataset.group_id } };
    assert.equal(importEntries({ entries: [reordered] }, { store }).skipped, 1);
  });
  await test('malformed input, duplicate IDs and conflicts reject the whole chunk before writes', () => {
    const invalids = [
      { collection: 'jobs', id: 'job', value: { id: 'job' } },
      { ...entries[0], id: 'different-source' },
      { ...entries[0], value: { ...dataset, records: [null] } },
      { ...entries[2], value: { ...evaluation, appeals: null } },
      { ...entries[2], value: { ...evaluation, final_result: { ...evaluation.final_result, criteria: {} } } },
      { ...entries[2], value: { ...evaluation, checklist_snapshot: { ...checklist, criteria: [null] } } },
      { ...entries[2], value: { ...evaluation, global_validation_errors: {} } },
      JSON.parse('{"collection":"datasets","id":"bad","value":{"group_id":"bad","__proto__":{"polluted":true}}}'),
    ];
    for (const invalid of invalids) {
      const store = memory();
      assert.throws(() => importEntries({ entries: [entries[1], invalid] }, { store }));
      assert.equal(store.writes, 0);
    }
    assert.throws(() => importEntries({ entries: [entries[0], entries[0]] }, { store: memory() }), /повторяющийся/);
    const store = memory([entries[0]]);
    const changed = { ...entries[0], value: { ...dataset, source: 'different' } };
    assert.throws(() => importEntries({ entries: [entries[1], changed] }, { store }), (error) => error.status === 409);
    assert.equal(store.writes, 0);
    assert.equal(importEntries({ entries: [changed], replace: true }, { store }).replaced, 1);
  });
  await test('UTF-8 chunking stays below one MiB and never splits a stored document', () => {
    const large = Array.from({ length: 5 }, (_, index) => ({ ...entries[0], id: 'large-' + index, value: { ...dataset, group_id: 'large-' + index, records: [{ ...record, transcript: [{ ...record.transcript[0], text: 'я'.repeat(240000) }] }] } }));
    const chunks = chunkEntries(large);
    assert.ok(chunks.length > 1);
    assert.deepEqual(chunks.flat(), large);
    for (const chunk of chunks) assert.ok(Buffer.byteLength(JSON.stringify({ entries: chunk, replace: false }), 'utf8') < MAX_BYTES);
    assert.throws(() => chunkEntries([{ ...large[0], value: { huge: 'x'.repeat(MAX_BYTES) } }]), (error) => error.status === 413);
    assert.throws(() => importEntries({ entries: large }), (error) => error.status === 413);
  });
  await test('CLI dry-run reads only whitelisted collections and never reads auth, calls network or prints transcripts', async () => {
    const logs = [], store = memory(entries);
    const summary = await migrateWorkspace(parseArgs([]), { store, log: (message) => logs.push(message), readFile: () => { throw new Error('auth must not be read'); }, fetch: () => { throw new Error('network must not be called'); } });
    assert.equal(summary.mode, 'dry-run'); assert.equal(summary.entries, 3);
    assert.ok(!logs.join('\n').includes('PRIVATE_TRANSCRIPT'));
    assert.ok(!logs.join('\n').includes('https://'));
    for (const args of [['--live'], ['--url=http://example.com'], ['--url=https://user:password@example.com'], ['--url=https://example.com/path'], ['--url=https://example.com?secret=value'], ['--password=plaintext'], ['--live=false']]) assert.throws(() => parseArgs(args));
  });
  await test('live migration sends sequential bounded chunks to one HTTPS origin without following redirects', async () => {
    const options = parseArgs(['--live', '--url=https://example.vercel.app/', '--auth-file=private.json']);
    const target = memory(), logs = [], calls = [];
    const large = Array.from({ length: 5 }, (_, index) => ({ ...entries[0], id: 'live-large-' + index, value: { ...dataset, group_id: 'live-large-' + index, records: [{ ...record, transcript: [{ ...record.transcript[0], text: 'я'.repeat(220000) }] }] } }));
    let active = false;
    const auth = { username: 'midnight', password: 'PRIVATE_PASSWORD_123456789' };
    const dependencies = {
      store: memory([...entries, ...large]), log: (message) => logs.push(message), readFile: () => JSON.stringify(auth),
      fetch: async (url, request) => {
        assert.equal(active, false, 'the previous chunk must be acknowledged before the next request'); active = true;
        await new Promise(setImmediate);
        calls.push(url); assert.equal(url, 'https://example.vercel.app/api/workspace/import');
        assert.equal(request.redirect, 'manual'); assert.equal(request.method, 'POST');
        assert.equal(request.headers.Authorization, 'Basic ' + Buffer.from(auth.username + ':' + auth.password).toString('base64'));
        assert.ok(Buffer.byteLength(request.body) < MAX_BYTES);
        return { ok: true, status: 200, json: async () => { const result = importEntries(JSON.parse(request.body), { store: target }); active = false; return result; } };
      },
    };
    assert.equal((await migrateWorkspace(options, dependencies)).imported, 8);
    assert.equal((await migrateWorkspace(options, dependencies)).skipped, 8);
    assert.ok(calls.length >= 6);
    assert.ok(!logs.join('\n').includes(auth.password));
    let readBody = false;
    await assert.rejects(migrateWorkspace(options, { ...dependencies, fetch: async () => ({ ok: false, status: 302, json: async () => { readBody = true; return auth; } }) }), /HTTP 302/);
    assert.equal(readBody, false);
  });
  const help = spawnSync(process.execPath, ['scripts/migrate-workspace.js', '--help'], { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  console.log(`workspace-transfer: пройдено ${passed}`);
})().catch((error) => { console.error(error); process.exitCode = 1; });

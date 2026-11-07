'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
Object.assign(process.env, { CQA_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-selection-')), LLM_PROVIDER: 'mock' });
const { server } = require('../server');
const store = require('../src/store');
const sample = require('../data/sample/SAMPLE.json').data.records.slice(0, 2);
store.write('datasets', 'SELECT', { group_id: 'SELECT', records: sample });
(async () => {
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    for (const selection of [[], null, '', 'all', [null], ['missing'], [sample[0].conversation_id, 'missing'], [sample[0].conversation_id, sample[0].conversation_id]]) {
      const response = await fetch(base + '/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group_id: 'SELECT', conversation_ids: selection }) });
      assert.equal(response.status, 400, 'invalid explicit selection must never trigger evaluation of the entire dataset');
      assert.equal(store.list('evaluations').length, 0);
    }
    const response = await fetch(base + '/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group_id: 'SELECT', conversation_ids: [sample[0].conversation_id] }) });
    assert.equal(response.status, 202);
    const job = await response.json();
    assert.equal(job.total, 1);
    const after = await (await fetch(base + '/batch/' + job.id)).json();
    assert.equal(after.done, 1);
    assert.deepEqual(store.list('evaluations').map((evaluation) => evaluation.conversation_id), [sample[0].conversation_id]);
    console.log('batch-selection: empty/invalid selection does not trigger all; exact subset evaluates once — PASS');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { if (server.listening) server.close(); }
})();

'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
Object.assign(process.env, { CQA_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-analytics-')), LLM_PROVIDER: 'mock' });
const { server } = require('../server');
const store = require('../src/store');
const { computeScore } = require('../src/scoring');
const checklist = {
  id: 'analytics', name: 'Analytics fixture', version: 1, rounding: 2, sections: [],
  criteria: [
    { id: 'c01', title: 'Required', type: 'binary', weight: 60, na_allowed: false },
    { id: 'c02', title: 'Conditional', type: 'binary', weight: 40, na_allowed: true, na_condition: 'Fixture condition' },
    { id: 'c03', title: 'Zero weight', type: 'binary', weight: 0, na_allowed: false },
    { id: 'c04', title: 'Critical', type: 'flag', weight: 0, na_allowed: false },
  ],
};
const transcript = [{ speaker: 'operator', timestamp: '00:00', text: 'Fixture' }];
store.write('checklists', checklist.id, checklist);
store.write('datasets', 'A', { group_id: 'A', records: ['a', 'b', 'c'].map((id) => ({ conversation_id: id, transcript, channel: 'agent chat', language: 'RU' })) });
for (const [index, id] of ['a', 'b', 'c'].entries()) {
  const criteria = {
    c01: { answer: index === 2 ? 'INVALID' : 'YES' },
    c02: { answer: ['NO', 'YES', 'NA'][index] },
    c03: { answer: 'YES' },
    c04: { answer: index === 2 ? 'INVALID' : 'NO', review_required: index === 2 },
  };
  const result = computeScore(checklist, criteria);
  store.write('evaluations', id, {
    id, group_id: 'A', conversation_id: id, channel: 'agent chat', language: 'RU',
    transcript_hash: crypto.createHash('sha256').update(JSON.stringify(transcript)).digest('hex').slice(0, 16),
    checklist: { id: checklist.id, name: checklist.name, version: 1 }, checklist_snapshot: checklist,
    provider: 'mock', model: 'fixture', created_at: '2026-11-07T00:00:00Z',
    final_criteria: criteria, original_result: result, final_result: result, appeals: [], coaching: [], cost_usd: 0,
  });
}
(async () => {
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const report = await (await fetch(base + '/analytics?group_id=A&checklist_id=analytics')).json();
    assert.strictEqual(report.median, 80, 'median of 60 and 100 is 80');
    assert.strictEqual(report.avg, 80);
    const required = report.criteria.find((criterion) => criterion.id === 'c01');
    assert.strictEqual(required.na, 0, 'INVALID is not N/A');
    assert.strictEqual(required.invalid, 1);
    assert.strictEqual(report.criteria.find((criterion) => criterion.id === 'c02').na, 1);
    assert.strictEqual(report.criteria.find((criterion) => criterion.id === 'c03').na, 0, 'zero weight is not N/A');
    assert.strictEqual(report.gross_count, 0);
    assert.strictEqual(report.gross_unknown_count, 1, 'unverified critical flag is unknown');
    assert.strictEqual(report.operators[0].gross_unknown, 1);
    assert.strictEqual(report.operators[0].conversations.find((conversation) => conversation.id === 'c').gross_unknown, true);
    const summaries = await (await fetch(base + '/evaluations?group_id=A')).json();
    assert.strictEqual(summaries.find((evaluation) => evaluation.id === 'c').gross_error_unknown, true);
    const csv = await (await fetch(base + '/export.csv?group_id=A&checklist_id=analytics')).text();
    const columns = csv.split('\n')[0].replace(/^\uFEFF/, '').split(',');
    const criticalColumn = columns.indexOf('gross_error');
    const unknownRow = csv.split('\n').find((line) => line.startsWith('"c",'));
    assert.strictEqual(unknownRow.split(',')[criticalColumn], '"UNKNOWN"', 'CSV must not export unknown critical as NO');
    console.log('analytics: median, INVALID/N/A, zero-weight and unknown critical flag — PASS');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { if (server.listening) server.close(); }
})();

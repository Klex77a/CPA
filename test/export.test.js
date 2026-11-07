'use strict';
// Contract tests use invented fixtures. They never call a model or create submission files.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
Object.assign(process.env, { CQA_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-export-')), LLM_PROVIDER: 'mock' });
const { buildSubmission, validateSubmission } = require('../src/result-export');
const checklist = require('../src/default-checklist.json');
const store = require('../src/store');
const { server } = require('../server');

const clone = (value) => JSON.parse(JSON.stringify(value));
const transcript = Array.from({ length: 8 }, (_, index) => ({ timestamp: `00:0${index}`, speaker: ['bot', 'client', 'system', 'operator'][index % 4], text: `Реплика ${index + 1}` }));
const records = Array.from({ length: 10 }, (_, index) => ({ conversation_id: `fixture-${index}`, transcript, channel: 'agent chat', language: 'RU' }));
const dataset = { group_id: 'TEST', records };
const answers = Object.fromEntries(checklist.criteria.map((criterion, index) => [criterion.id, {
  answer: ['YES', 'NA', 'NA', 'SCORE', 'YES', 'SCORE', 'YES', 'NO'][index],
  value: index === 3 ? 15 : index === 5 ? 7 : null,
  explanation: `Основание критерия ${index + 1}`, evidence: [{ msg: index }],
}]));
const evaluations = records.map((record, index) => ({
  id: `ev-${index}`, group_id: 'TEST', conversation_id: record.conversation_id,
  transcript_hash: crypto.createHash('sha256').update(JSON.stringify(transcript)).digest('hex').slice(0, 16),
  checklist: { id: 'default', version: 1 }, provider: 'deepseek', model: 'unit-test-fixture',
  channel: record.channel, language: record.language,
  created_at: '2026-01-01T00:00:00Z', status: 'ok', final_criteria: clone(answers),
}));
const input = { dataset, checklist, evaluations, teamName: 'Midnight Commit', split: 'prod' };
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('✔', name); }

(async () => {
  try {
    await test('Appendix example: raw dialogue=7, 1-based source turns, weighted final=85.38', () => {
      const output = buildSubmission(input);
      assert.strictEqual(output.schema_version, '1.0');
      assert.strictEqual(output.team_name, 'Midnight Commit');
      assert.deepStrictEqual(output.results[0].criteria.map((row) => row.value), [true, null, null, 15, true, 7, true, false]);
      assert.deepStrictEqual(output.results[0].criteria.map((row) => row.evidence_turns), [[1], [2], [3], [4], [5], [6], [7], [8]]);
      assert.deepStrictEqual(output.results[0].score, { final_score: 85.38, critical_flag: false });
      assert.deepStrictEqual(validateSubmission(output, { split: 'prod', records }), []);
    });
    await test('missing, stale and needs-review results remain error records with original IDs', () => {
      const stale = clone(evaluations);
      stale[1].transcript_hash = 'different';
      stale[2].checklist.version = 2;
      stale[3].status = 'needs_review';
      const output = buildSubmission({ ...input, evaluations: stale.slice(1) });
      assert.strictEqual(output.results.length, 10);
      assert.deepStrictEqual(output.results.slice(0, 4).map((row) => row.status), ['error', 'error', 'error', 'error']);
      for (const result of output.results.slice(0, 4)) {
        assert.deepStrictEqual(result.criteria, []);
        assert.strictEqual(result.score, null);
        assert.ok(result.error);
      }
      const changedLanguage = { ...dataset, records: records.map((record, index) => index === 0 ? { ...record, language: 'EN' } : record) };
      assert.strictEqual(buildSubmission({ ...input, dataset: changedLanguage }).results[0].status, 'error', 'изменение языка не использует прежнюю оценку при том же тексте');
    });
    await test('even all failed model attempts export every ID and the attempted model without inventing scores', () => {
      const failed = evaluations.map((evaluation) => ({ ...evaluation, status: 'error', final_criteria: undefined, validation_errors: ['Сервис модели недоступен'] }));
      const output = buildSubmission({ ...input, evaluations: failed });
      assert.ok(output.results.every((result) => result.status === 'error' && result.score === null && result.error === 'Сервис модели недоступен'));
      assert.match(output.model.name, /unit-test-fixture/);
      assert.deepStrictEqual(validateSubmission(output, { split: 'prod', records }), []);
      assert.throws(() => buildSubmission({ ...input, evaluations: [] }), /Нет результатов настоящей модели/);
      const newestFailure = { ...failed[0], created_at: '2026-11-01T00:00:00Z' };
      assert.strictEqual(buildSubmission({ ...input, evaluations: [...evaluations, newestFailure] }).results[0].status, 'ok', 'неудачная переоценка не стирает последний готовый результат');
    });
    await test('ranges export source indices; invalid proof becomes an error instead of fabricated evidence', () => {
      const changed = clone(evaluations);
      changed[0].final_criteria.c08.evidence = [];
      changed[0].final_criteria.c08.checked_range = { from: 0, to: 7 };
      changed[1].final_criteria.c01.evidence[0].msg = 50;
      const output = buildSubmission({ ...input, evaluations: changed });
      assert.deepStrictEqual(output.results[0].criteria[7].evidence_turns, [1, 2, 3, 4, 5, 6, 7, 8]);
      assert.strictEqual(output.results[1].status, 'error');
    });
    await test('submission blocks mock results, wrong counts, duplicate sources and changed scoring', () => {
      for (const variation of [
        { split: 'dev' }, { teamName: '' },
        { evaluations: evaluations.map((ev) => ({ ...ev, provider: 'mock' })) },
        { checklist: { ...checklist, criteria: checklist.criteria.slice(1) } },
        { checklist: { ...checklist, criteria: checklist.criteria.map((criterion) => ({ ...criterion, weight: 1 })) } },
        { dataset: { ...dataset, records: Array(10).fill(records[0]) } },
      ]) assert.throws(() => buildSubmission({ ...input, ...variation }));
    });
    await test('inherited object names are rejected as split values with a controlled client error', () => {
      for (const split of ['constructor', 'toString', '__proto__', '', null, {}, ['prod']]) {
        assert.throws(() => buildSubmission({ ...input, split }), (error) => error.status === 400 && /dev или prod/.test(error.message));
        assert.ok(validateSubmission(buildSubmission(input), { split, records }).some((error) => /split/.test(error)));
      }
    });
    await test('malformed checklist arrays and scale steps produce controlled validation errors', () => {
      const variants = [null, {}, { ...checklist, criteria: null }, { ...checklist, criteria: {} }, { ...checklist, criteria: Array(8).fill(null) }];
      for (const scale of [{}, 'bad', [null], [{ value: { toString: 1 }, description: 'bad' }]]) {
        const changed = clone(checklist);
        changed.criteria[3].scale = scale;
        variants.push(changed);
      }
      for (const changed of variants) assert.throws(() => buildSubmission({ ...input, checklist: changed }), (error) => error.status === 422 && !(error instanceof TypeError));
    });
    await test('malformed source records are rejected without accessing invalid IDs or transcript bounds', () => {
      const variants = [null, {}, { ...dataset, records: null }, { ...dataset, records: {} }, { ...dataset, records: Array(10).fill(null) }];
      for (const transcript of [undefined, null, {}, [], [null]]) {
        const changed = clone(dataset);
        changed.records[0].transcript = transcript;
        variants.push(changed);
      }
      for (const changed of variants) assert.throws(() => buildSubmission({ ...input, dataset: changed }), (error) => error.status === 422 && !(error instanceof TypeError));
      const output = buildSubmission(input);
      for (const source of [null, {}, [null], [{ conversation_id: null, transcript }], records.map((record, index) => index ? record : { ...record, transcript: null }), Array(10).fill(records[0])]) {
        const errors = validateSubmission(output, { split: 'prod', records: source });
        assert.ok(errors.length, 'malformed source must never validate');
      }
    });
    await test('malformed evaluations cannot crash export or replace a latest needs-review result with an older success', () => {
      for (const invalid of [null, {}]) assert.throws(() => buildSubmission({ ...input, evaluations: invalid }), (error) => error.status === 422);
      assert.deepStrictEqual(buildSubmission({ ...input, evaluations: [null, {}, ...evaluations] }), buildSubmission(input));
      const missingChecklist = clone(evaluations);
      missingChecklist[0].checklist = null;
      assert.strictEqual(buildSubmission({ ...input, evaluations: missingChecklist }).results[0].status, 'error');
      for (const malformed of [{ created_at: null }, { created_at: 'invalid' }, { provider: {} }, { model: null }]) {
        const changed = clone(evaluations);
        Object.assign(changed[0], malformed);
        assert.throws(() => buildSubmission({ ...input, evaluations: changed }), (error) => error.status === 422 && !(error instanceof TypeError));
      }
      const latest = { ...clone(evaluations[0]), status: 'needs_review', validation_errors: {}, created_at: '2026-11-07T00:00:00Z' };
      const output = buildSubmission({ ...input, evaluations: [...evaluations, latest] });
      assert.strictEqual(output.results[0].status, 'error');
      assert.match(output.results[0].error, /проверки человеком/);
      for (const mutate of [
        (evaluation) => { evaluation.final_criteria = null; },
        (evaluation) => { evaluation.final_criteria.c01.evidence = {}; },
        (evaluation) => { evaluation.final_criteria.c01.evidence = [null]; },
        (evaluation) => { evaluation.final_criteria.c01.explanation = { toString: 1 }; },
        (evaluation) => { evaluation.final_criteria.c01.review_required = true; },
        (evaluation) => { evaluation.final_criteria.c01.issues = {}; },
        (evaluation) => { evaluation.global_validation_errors = ['Unresolved output-shape error']; },
        (evaluation) => { evaluation.checklist_snapshot = { criteria: {} }; },
      ]) {
        const changed = clone(evaluations);
        mutate(changed[0]);
        const invalid = buildSubmission({ ...input, evaluations: changed }).results[0];
        assert.strictEqual(invalid.status, 'error');
        assert.strictEqual(invalid.score, null);
        assert.deepStrictEqual(invalid.criteria, []);
      }
    });
    await test('validator rejects wrong score/critical/types/IDs/turns and missing records', () => {
      const mutations = [
        (output) => { output.results[0].score.final_score = 85.39; },
        (output) => { output.results[0].score.critical_flag = true; },
        (output) => { output.results[0].criteria[5].value = 10.5; },
        (output) => { output.results[0].criteria[0].value = null; },
        (output) => { output.results[0].criteria[0].evidence_turns = [0]; },
        (output) => { output.results[0].criteria[0].evidence_turns = [9]; },
        (output) => { output.results[0].criteria[0].criterion_id = 'c01'; },
        (output) => { output.results[0].criteria[1].criterion_id = 'contact'; },
        (output) => { output.results[0].conversation_id = output.results[1].conversation_id; },
        (output) => { output.results.pop(); },
      ];
      for (const mutate of mutations) {
        const output = buildSubmission(input);
        mutate(output);
        assert.ok(validateSubmission(output, { split: 'prod', records }).length);
      }
      const malformed = buildSubmission(input);
      malformed.results[0].conversation_id = { toString: 1 };
      assert.ok(validateSubmission(malformed, { split: 'prod', records }).length);
      assert.ok(validateSubmission(buildSubmission(input), null).length);
    });
    await test('HTTP export returns official attachment, validates count and never publishes a mock submission', async () => {
      store.write('datasets', dataset.group_id, dataset);
      for (const evaluation of evaluations) store.write('evaluations', evaluation.id, evaluation);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${server.address().port}/api/export.json?group_id=TEST&checklist_id=default&team_name=Midnight+Commit&split=`;
      let response = await fetch(url + 'prod');
      assert.strictEqual(response.status, 200);
      assert.match(response.headers.get('content-disposition'), /results.json/);
      assert.strictEqual((await response.json()).results.length, 10);
      response = await fetch(url + 'dev');
      assert.strictEqual(response.status, 422);
      for (const evaluation of evaluations) store.write('evaluations', evaluation.id, { ...evaluation, provider: 'mock' });
      response = await fetch(url + 'prod');
      assert.strictEqual(response.status, 409);
    });
    await test('judging endpoints return readiness and downloadable evidence without provider calls', async () => {
      const base = `http://127.0.0.1:${server.address().port}/api`;
      let response = await fetch(base + '/readiness');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get('cache-control'), 'no-store');
      const readiness = await response.json();
      assert.deepStrictEqual(readiness.submissions.map((item) => item.split), ['dev', 'prod']);
      assert.strictEqual(readiness.publication.state, 'not_verified');
      assert.strictEqual(readiness.demo.steps.reduce((sum, step) => sum + step.seconds, 0), 300);
      response = await fetch(base + '/benchmark/report');
      assert.strictEqual(response.status, 200);
      assert.match(response.headers.get('content-disposition'), /benchmark-report\.json/);
      const report = await response.json();
      assert.strictEqual(report.provenance, 'engineering_reference');
      assert.strictEqual(report.cases.length, 15);
      response = await fetch(base + '/demo-guide');
      assert.strictEqual(response.status, 200);
      assert.match(response.headers.get('content-disposition'), /Midnight-Commit-demo\.md/);
      assert.match(await response.text(), /300|5 минут/);
    });
    console.log(`export: пройдено ${passed}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally { if (server.listening) server.close(); }
})();

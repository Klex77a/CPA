'use strict';
const assert = require('node:assert');
const crypto = require('node:crypto');
const { evaluationFreshness } = require('../src/evaluation-freshness');

const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (transcript) => crypto.createHash('sha256').update(JSON.stringify(transcript)).digest('hex').slice(0, 16);
const record = {
  conversation_id: 'same-id', channel: 'agent chat', language: 'RU', audio_url: null,
  transcript: [
    { timestamp: '00:00', speaker: 'client', text: 'Здравствуйте, где скачать отчёт?' },
    { timestamp: '00:01', speaker: 'operator', text: 'Здравствуйте, меня зовут Анна.' },
  ],
};
const checklist = { id: 'default', version: 1 };
const evaluation = {
  conversation_id: record.conversation_id, channel: record.channel, language: record.language,
  transcript_hash: hash(record.transcript), checklist,
};
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('✔', name); }

(async () => {
  try {
    await test('unchanged source and checklist remain current; renewed audio URL does not invalidate text', () => {
      const expected = { stale: false, stale_reasons: [], record_changed: false };
      assert.deepStrictEqual(evaluationFreshness(evaluation, record, checklist), expected);
      assert.deepStrictEqual(evaluationFreshness(evaluation, { ...record, audio_url: 'https://recordings.example/audio?sig=new' }, checklist), expected);
    });
    await test('same conversation ID with changed text, timestamps, roles or order invalidates evidence binding', () => {
      const changes = [
        (source) => { source.transcript[1].text = 'Другой ответ без приветствия'; },
        (source) => { source.transcript[1].timestamp = '00:09'; },
        (source) => { source.transcript[1].speaker = 'bot'; },
        (source) => { source.transcript.reverse(); },
      ];
      for (const change of changes) {
        const source = clone(record);
        change(source);
        assert.deepStrictEqual(evaluationFreshness(evaluation, source, checklist), { stale: true, stale_reasons: ['transcript'], record_changed: true });
      }
    });
    await test('channel, language and source identity changes are distinct from checklist-only changes', () => {
      for (const changed of [{ channel: 'voice call' }, { language: 'EN' }, { conversation_id: 'other-id' }]) {
        assert.deepStrictEqual(evaluationFreshness(evaluation, { ...record, ...changed }, checklist), { stale: true, stale_reasons: ['metadata'], record_changed: true });
      }
      for (const changed of [{ id: 'copy', version: 1 }, { id: 'default', version: 2 }, null]) {
        assert.deepStrictEqual(evaluationFreshness(evaluation, record, changed), { stale: true, stale_reasons: ['checklist'], record_changed: false });
      }
    });
    await test('missing or unverifiable source never silently binds historical proof IDs to the live transcript', () => {
      assert.deepStrictEqual(evaluationFreshness(evaluation, null, checklist), { stale: true, stale_reasons: ['source_missing'], record_changed: true });
      for (const transcriptHash of [undefined, 'broken', 1234567890123456, true, []]) {
        const changed = { ...evaluation, transcript_hash: transcriptHash };
        assert.deepStrictEqual(evaluationFreshness(changed, record, checklist), { stale: true, stale_reasons: ['unverifiable'], record_changed: true });
      }
      assert.deepStrictEqual(evaluationFreshness(evaluation, { ...record, transcript: null }, checklist), { stale: true, stale_reasons: ['unverifiable'], record_changed: true });
    });
    await test('combined stale reasons are preserved without mutating source or saved evaluation', () => {
      const changed = { ...clone(record), language: 'KZ' };
      changed.transcript[0].text = 'Өзгерген сұрақ';
      const before = JSON.stringify([evaluation, changed]);
      assert.deepStrictEqual(evaluationFreshness(evaluation, changed, { ...checklist, version: 2 }), { stale: true, stale_reasons: ['transcript', 'metadata', 'checklist'], record_changed: true });
      assert.strictEqual(JSON.stringify([evaluation, changed]), before);
    });
    await test('evaluation preserves an independent record snapshot from before the asynchronous model call', async () => {
      process.env.LLM_PROVIDER = 'mock';
      const cfg = require('../src/config');
      const llm = require('../src/llm');
      const mock = require('../src/mock');
      const { evaluate } = require('../src/evaluator');
      const initialRecord = clone(record);
      const mutableRecord = clone(record);
      const cl = require('../src/default-checklist.json');
      const parsed = mock.evaluate(initialRecord, cl);
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      let modelCalls = 0;
      cfg.provider = 'deepseek';
      cfg.model = 'offline-snapshot-test';
      cfg.SAMPLES = 1;
      cfg.REPAIR_ATTEMPTS = 0;
      llm.complete = async () => {
        modelCalls++;
        await gate;
        return { text: JSON.stringify(parsed), usage: { input: 0, output: 0, thoughts: 0 }, metrics: { http_attempts: 0, request_ms: 0, wait_ms: 0 } };
      };
      const pending = evaluate(mutableRecord, cl, 'FRESHNESS_TEST');
      mutableRecord.transcript[0].text = 'Changed while the request was running';
      mutableRecord.language = 'EN';
      release();
      const saved = await pending;
      assert.strictEqual(modelCalls, 1);
      assert.deepStrictEqual(saved.record_snapshot, initialRecord);
      assert.strictEqual(saved.transcript_hash, hash(initialRecord.transcript));
      assert.notStrictEqual(saved.record_snapshot.transcript, mutableRecord.transcript);
      assert.deepStrictEqual(evaluationFreshness(saved, mutableRecord, cl), { stale: true, stale_reasons: ['transcript', 'metadata'], record_changed: true });
      assert.deepStrictEqual(evaluationFreshness(saved, initialRecord, cl), { stale: false, stale_reasons: [], record_changed: false });
    });
    console.log(`freshness: пройдено ${passed}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
})();

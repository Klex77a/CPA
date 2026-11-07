'use strict';
// Regressions found during the jury-readiness review. All model/HTTP calls below
// are local test doubles; the configured real provider is never contacted.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-core-review-'));
Object.assign(process.env, {
  CQA_DATA_DIR: dataDir, LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'offline-test-secret',
  LLM_MODEL: 'offline-review-model', SAMPLES: '1', REPAIR_ATTEMPTS: '1', LLM_MAX_ATTEMPTS: '1',
  DEEPSEEK_BASE_URL: '', GEMINI_THINKING_LEVEL: '', DEEPSEEK_REASONING_EFFORT: '',
  MAX_OUTPUT_TOKENS: '', TEMPERATURE: '', PRICE_IN_PER_M: '1', PRICE_OUT_PER_M: '2',
});
global.fetch = async () => { throw new Error('Unexpected HTTP request in an offline test'); };
const cfg = require('../src/config');
const llm = require('../src/llm');
const { evaluate, recompute, cacheKey, PROMPT_VERSION } = require('../src/evaluator');
const { safeFailureMessage, saveEvaluationFailure } = require('../src/evaluation-failure');
const realComplete = llm.complete;
const clone = (value) => JSON.parse(JSON.stringify(value));
const sha = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const checklist = {
  id: 'offline', version: 1, name: 'Offline checklist', rounding: 2, sections: [],
  criteria: [
    { id: 'greeting', title: 'Приветствие', type: 'binary', weight: 10, description: 'Оператор приветствует клиента.' },
    { id: 'ending', title: 'Завершение', type: 'binary', weight: 5, description: 'Оператор прощается.' },
  ],
};
const record = {
  conversation_id: 'offline-core-review', channel: 'agent chat', language: 'RU',
  transcript: [
    { timestamp: '00:00', speaker: 'client', text: 'Здравствуйте, мой вопрос уже решён.' },
    { timestamp: '00:01', speaker: 'operator', text: 'Здравствуйте, я Анна. Всего доброго.' },
  ],
};
const parsed = () => ({ operator_name: 'Анна', criteria: [
  { id: 'greeting', answer: 'YES', explanation: 'Оператор поздоровался в своей первой реплике.', evidence: [{ msg: 'm1' }] },
  { id: 'ending', answer: 'YES', explanation: 'Оператор попрощался с клиентом в конце ответа.', evidence: [{ msg: 'm1' }] },
], coaching: [] });
const response = (body = parsed(), usage = { input: 100, output: 30, thoughts: 20 }) => ({ text: JSON.stringify(body), usage, metrics: { http_attempts: 1, request_ms: 3, wait_ms: 0 } });
let passed = 0;
async function test(name, run) {
  cfg.SAMPLES = 1;
  cfg.REPAIR_ATTEMPTS = 1;
  await run();
  passed++;
  console.log('✔', name);
}

(async () => {
  try {
    await test('failed repair retains usage of the initial response and persists measured failure work', async () => {
      let calls = 0;
      llm.complete = async () => {
        if (++calls === 1) return { ...response(), text: 'invalid model JSON' };
        throw Object.assign(new Error('LLM HTTP 503: Bearer offline-test-secret'), { status: 503, metrics: { http_attempts: 1, request_ms: 5, wait_ms: 0, usage: { input: 25, output: 10, thoughts: 0 } } });
      };
      const error = await evaluate(record, checklist, 'FAILURE').then(() => { throw new Error('Expected a failed evaluation'); }, (failure) => failure);
      assert.equal(error.status, 503);
      assert.equal(calls, 2);
      assert.deepEqual(error.evaluation_metrics.usage, { input: 125, output: 40, thoughts: 20 });
      assert.equal(error.evaluation_metrics.cost_usd, 0.000245);
      assert.equal(error.evaluation_metrics.timing.http_attempts, 2);
      assert.equal(error.evaluation_metrics.timing.llm_ms, 8);
      assert.equal(error.evaluation_metrics.successful_samples, 0);
      assert.ok(!JSON.stringify(error.evaluation_metrics).includes('offline-test-secret'));
      const saved = saveEvaluationFailure(record, checklist, 'FAILURE', error);
      assert.deepEqual(saved.usage, error.evaluation_metrics.usage);
      assert.equal(saved.cost_usd, error.evaluation_metrics.cost_usd);
      assert.equal(saved.duration_ms, error.evaluation_metrics.duration_ms);
      assert.equal(saved.timing.calls.length, 2);
      assert.ok(!JSON.stringify(saved).includes('offline-test-secret'));
      assert.ok(!('final_result' in saved));
    });

    await test('a failed sample cannot hide its paid initial response when another sample succeeds', async () => {
      cfg.SAMPLES = 2;
      let calls = 0;
      llm.complete = async () => {
        const call = ++calls;
        if (call === 1) return { ...response(), text: 'invalid model JSON' };
        if (call === 2) return response(parsed(), { input: 200, output: 50, thoughts: 0 });
        throw Object.assign(new Error('repair unavailable'), { metrics: { http_attempts: 1, request_ms: 4, wait_ms: 0 } });
      };
      const saved = await evaluate(record, checklist, 'PARTIAL');
      assert.equal(saved.status, 'ok');
      assert.equal(saved.samples, 2);
      assert.equal(saved.successful_samples, 1);
      assert.equal(saved.usage, null);
      assert.equal(saved.cost_usd, null);
      assert.deepEqual(saved.known_usage, { input: 300, output: 80, thoughts: 20 });
      assert.equal(saved.known_cost_usd, 0.0005);
      assert.equal(saved.billing_complete, false);
      assert.equal(saved.unknown_call_count, 1);
      assert.equal(saved.timing.calls.length, 3);
    });

    await test('an actual HTTP error before any usage is unknown billing, never a fabricated free attempt', async () => {
      llm.complete = realComplete;
      global.fetch = async () => ({ ok: false, status: 503, headers: { get: () => null }, text: async () => 'Service unavailable' });
      const error = await evaluate(record, checklist, 'NO_USAGE_HTTP').then(() => { throw new Error('Expected failure'); }, error => error);
      assert.equal(error.code, 'PROVIDER_HTTP_503'); assert.equal(error.status, 503);
      const work = error.evaluation_metrics;
      assert.equal(work.cost_usd, null); assert.equal(work.usage, null); assert.equal(work.billing_complete, false); assert.equal(work.unknown_call_count, 1);
      assert.equal(work.known_cost_usd, 0); assert.deepEqual(work.known_usage, { input: 0, output: 0, thoughts: 0 });
      assert.equal(work.timing.calls[0].usage, null); assert.equal(work.timing.http_attempts, 1);
    });

    await test('a billed initial response survives an unknown repair failure as an explicit lower bound', async () => {
      let calls = 0;
      llm.complete = async () => {
        if (++calls === 1) return { ...response(), text: 'invalid model JSON' };
        throw Object.assign(new Error('Transport disconnected'), { status: 'network', metrics: { http_attempts: 1, request_ms: 5, wait_ms: 0 } });
      };
      const error = await evaluate(record, checklist, 'PARTIAL_BILLING').then(() => { throw new Error('Expected failure'); }, error => error);
      const work = error.evaluation_metrics;
      assert.equal(work.cost_usd, null); assert.equal(work.usage, null); assert.equal(work.known_cost_usd, 0.0002);
      assert.deepEqual(work.known_usage, { input: 100, output: 30, thoughts: 20 }); assert.equal(work.unknown_call_count, 1); assert.equal(work.billing_complete, false);
      const saved = saveEvaluationFailure(record, checklist, 'PARTIAL_BILLING', error);
      assert.equal(saved.cost_usd, null); assert.equal(saved.usage, null); assert.equal(saved.known_cost_usd, 0.0002); assert.equal(saved.billing_complete, false);
    });

    await test('a successful completion without provider usage does not fabricate zero-cost billing', async () => {
      llm.complete = realComplete;
      global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(parsed()) }, finish_reason: 'stop' }] }) });
      const result = await evaluate(record, checklist, 'SUCCESS_WITHOUT_USAGE');
      assert.equal(result.status, 'ok'); assert.equal(result.usage, null); assert.equal(result.cost_usd, null);
      assert.equal(result.known_cost_usd, 0); assert.equal(result.unknown_call_count, 1); assert.equal(result.billing_complete, false);
    });

    await test('every concurrent failed sample settles before failure metrics are returned', async () => {
      cfg.SAMPLES = 2;
      cfg.REPAIR_ATTEMPTS = 0;
      let call = 0;
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      llm.complete = async () => {
        const index = ++call;
        if (index === 2) await gate;
        throw Object.assign(new Error('unusable paid response'), { metrics: { http_attempts: 1, request_ms: index, wait_ms: 0, usage: { input: 100 * index, output: 10, thoughts: 0 } } });
      };
      let settled = false;
      const pending = evaluate(record, checklist, 'SETTLE').then(() => { throw new Error('Expected failure'); }, (error) => { settled = true; return error; });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      release();
      const error = await pending;
      assert.deepEqual(error.evaluation_metrics.usage, { input: 300, output: 20, thoughts: 0 });
      assert.equal(error.evaluation_metrics.timing.calls.length, 2);
    });

    await test('voted criteria use their own validation errors and coaching, not the first sample', async () => {
      cfg.SAMPLES = 3;
      cfg.REPAIR_ATTEMPTS = 0;
      let call = 0;
      llm.complete = async () => {
        const body = parsed();
        body.coaching = [{ criterion_id: 'greeting', type: 'optional', text: call === 0 ? 'Advice from invalid answer' : 'Advice accompanying valid proof' }];
        if (++call === 1) { body.criteria[0].answer = 'NA'; body.criteria[0].na_reason = 'Not allowed'; }
        return response(body);
      };
      const saved = await evaluate(record, checklist, 'VOTE');
      assert.equal(saved.criteria.greeting.answer, 'YES');
      assert.deepEqual(saved.criteria.greeting.issues, []);
      assert.deepEqual(saved.validation_errors, []);
      assert.equal(saved.status, 'ok');
      assert.equal(saved.coaching[0].text, 'Advice accompanying valid proof');
      assert.deepEqual(saved.criteria.greeting.agreement, { agree: 2, runs: 3 });
    });

    await test('unsupported answers and broken evidence cannot outvote a validated candidate', async () => {
      cfg.SAMPLES = 3;
      cfg.REPAIR_ATTEMPTS = 0;
      let call = 0;
      llm.complete = async () => {
        const body = parsed();
        if (++call < 3) { body.criteria[0].answer = 'NO'; body.criteria[0].evidence = [{ msg: 'm99' }]; }
        return response(body);
      };
      const saved = await evaluate(record, checklist, 'EVIDENCE');
      assert.equal(saved.criteria.greeting.answer, 'YES');
      assert.equal(saved.status, 'ok');
      assert.deepEqual(saved.validation_errors, []);
    });

    await test('combined samples still undergo the duplicate-explanation consistency check', async () => {
      cfg.SAMPLES = 3;
      cfg.REPAIR_ATTEMPTS = 0;
      let call = 0;
      const same = 'Одинаковая формулировка не объясняет два разных критерия.';
      llm.complete = async () => {
        const index = ++call;
        const body = parsed();
        if (index === 1) { body.criteria[0].explanation = same; body.criteria[1].answer = 'NO'; }
        else body.criteria[1].explanation = same;
        return response(body);
      };
      const saved = await evaluate(record, checklist, 'COMBINED');
      assert.equal(saved.status, 'needs_review');
      assert.ok(saved.validation_errors.some((message) => message.includes('одинаковое объяснение')));
      assert.equal(saved.criteria.greeting.review_required, true);
      assert.equal(saved.criteria.ending.review_required, true);
    });

    await test('checklist snapshot cannot be changed by its caller during a model request', async () => {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const mutable = clone(checklist);
      llm.complete = async () => { await gate; return response(); };
      const pending = evaluate(record, mutable, 'SNAPSHOT');
      mutable.criteria[0].weight = 999;
      mutable.criteria[0].description = 'Changed after request started';
      release();
      const saved = await pending;
      assert.deepEqual(saved.checklist_snapshot, checklist);
      assert.equal(saved.checklist.content_hash, sha({ name: checklist.name, notes: '', rounding: 2, sections: [], criteria: checklist.criteria }).slice(0, 16));
    });

    await test('an appeal cannot silently clear an unresolved response-shape validation error', async () => {
      cfg.REPAIR_ATTEMPTS = 0;
      const body = parsed();
      body.criteria.push({ id: 'unknown', answer: 'YES', explanation: 'Unexpected extra criterion', evidence: [{ msg: 'm1' }] });
      llm.complete = async () => response(body);
      const saved = await evaluate(record, checklist, 'GLOBAL-ERROR');
      assert.equal(saved.status, 'needs_review');
      assert.equal(saved.global_validation_errors.length, 1);
      assert.ok(saved.summary.includes('Структура ответа модели требует проверки'));
      saved.appeals.push({ id: 'review', criterion_id: 'greeting', status: 'resolved', decision: { action: 'change', answer: 'YES', reason: 'Greeting confirmed by reviewer.' } });
      recompute(saved);
      assert.equal(saved.status, 'needs_review');
      assert.equal(saved.global_validation_errors.length, 1);
      assert.ok(saved.summary.includes('Структура ответа модели требует проверки'));
    });

    await test('default fingerprint stays compatible while output budget and custom endpoint invalidate cache', () => {
      cfg.SAMPLES = 1;
      const content = { name: checklist.name, notes: '', rounding: 2, sections: [], criteria: checklist.criteria };
      const legacy = sha({ conv: record.conversation_id, transcript: record.transcript, channel: record.channel, language: record.language, checklist_id: checklist.id, checklist_version: checklist.version, checklist: sha(content), settings: { provider: cfg.provider, model: cfg.model, samples: 1, temperature: cfg.TEMPERATURE, thinking: null, structured: cfg.STRUCTURED_OUTPUT, repair: cfg.REPAIR_ATTEMPTS, prompt: PROMPT_VERSION, kb: null } });
      const base = cacheKey(record, checklist);
      assert.equal(base, legacy);
      cfg.MAX_OUTPUT_TOKENS = 1024;
      assert.notEqual(cacheKey(record, checklist), base);
      cfg.MAX_OUTPUT_TOKENS = null;
      cfg.DEEPSEEK_BASE_URL = 'https://private-provider.example/v1?api_key=endpoint-secret';
      assert.notEqual(cacheKey(record, checklist), base);
      cfg.DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
      cfg.GEMINI_THINKING_LEVEL = 'high';
      assert.equal(cacheKey(record, checklist), base, 'irrelevant Gemini settings must not override DeepSeek reasoning');
      cfg.DEEPSEEK_REASONING_EFFORT = 'low';
      const low = cacheKey(record, checklist);
      cfg.DEEPSEEK_REASONING_EFFORT = 'high';
      assert.notEqual(cacheKey(record, checklist), low);
      cfg.GEMINI_THINKING_LEVEL = '';
      cfg.DEEPSEEK_REASONING_EFFORT = '';
    });

    await test('provider-reported usage survives an unusable successful HTTP response', async () => {
      llm.complete = realComplete;
      global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 10 } } }) });
      await assert.rejects(llm.complete('system', 'user', null), (error) => {
        assert.equal(error.status, 'empty');
        assert.deepEqual(error.metrics.usage, { input: 100, output: 40, thoughts: 10 });
        return true;
      });
    });

    await test('provider errors redact configured keys, authorization, generic credentials and URL signatures before exposure', async () => {
      llm.complete = realComplete;
      const body = 'Authorization: Bearer arbitrary-secret; api_key: "generic-secret"; offline-test-secret; https://example.com/a?sig=signed-secret';
      global.fetch = async () => ({ ok: false, status: 401, headers: { get: () => null }, text: async () => body });
      await assert.rejects(llm.complete('system', 'user', null), (error) => {
        for (const secret of ['arbitrary-secret', 'generic-secret', 'offline-test-secret', 'signed-secret']) assert.ok(!error.message.includes(secret));
        assert.equal(error.status, 401);
        assert.equal(error.metrics.http_attempts, 1);
        return true;
      });
      const safe = safeFailureMessage('api-key="another-secret", access_token=access-secret');
      assert.ok(!safe.includes('another-secret'));
      assert.ok(!safe.includes('access-secret'));
    });

    await test('malformed provider HTTP JSON is not retried as a transient network failure', async () => {
      llm.complete = realComplete;
      cfg.LLM_MAX_ATTEMPTS = 3;
      let calls = 0;
      global.fetch = async () => { calls++; return { ok: true, status: 200, headers: { get: () => null }, text: async () => 'not HTTP JSON' }; };
      await assert.rejects(llm.complete('system', 'user', null), (error) => error.status === 'invalid_json');
      assert.equal(calls, 1);
    });

    console.log(`core-review: пройдено ${passed}`);
  } finally {
    llm.complete = realComplete;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

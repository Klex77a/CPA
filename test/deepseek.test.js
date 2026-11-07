'use strict';
// Запрос к DeepSeek с имитацией сети (без платных вызовов).
const assert = require('assert');

Object.assign(process.env, { LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'test-key-123', LLM_MODEL: '', DEEPSEEK_BASE_URL: '', LLM_MAX_ATTEMPTS: '1', TEMPERATURE: '', DEEPSEEK_REASONING_EFFORT: '', MAX_OUTPUT_TOKENS: '', PRICE_IN_PER_M: '', PRICE_OUT_PER_M: '' });

let call = null;
global.fetch = async (url, opt) => {
  call = { url: String(url), headers: opt.headers, body: JSON.parse(opt.body) };
  const payload = {
    choices: [{ message: { content: '{"ok":true}', reasoning_content: 'скрыто' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3000, completion_tokens: 1000, completion_tokens_details: { reasoning_tokens: 400 } },
  };
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload) };
};

const cfg = require('../src/config');
const llm = require('../src/llm');

(async () => {
  assert.strictEqual(cfg.provider, 'deepseek');
  assert.strictEqual(cfg.model, 'deepseek-flash');
  assert.strictEqual(cfg.PRICE_IN_PER_M, 0.3);
  assert.strictEqual(cfg.PRICE_OUT_PER_M, 1.2);

  const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
  const r = await llm.complete('система', 'вопрос', schema);

  assert.strictEqual(call.url, 'https://api.deepseek.com/chat/completions');
  assert.strictEqual(call.headers.Authorization, 'Bearer test-key-123');
  assert.strictEqual(call.body.model, 'deepseek-flash');
  assert.deepStrictEqual(call.body.response_format, { type: 'json_object' });
  assert.ok(call.body.messages[0].content.includes(JSON.stringify(schema)), 'схема не передана в инструкции');
  assert.ok(!('temperature' in call.body));

  assert.strictEqual(r.text, '{"ok":true}');
  assert.deepStrictEqual(r.usage, { input: 3000, output: 600, thoughts: 400 });
  assert.strictEqual(r.metrics.finish_reason, 'stop');
  console.log('deepseek: пройдено');
})().catch((e) => { console.error(e); process.exit(1); });

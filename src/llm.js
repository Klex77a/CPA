'use strict';
/**
 * Адаптер к LLM без SDK (только fetch): DeepSeek, Gemini, OpenAI, Anthropic.
 *  - тайм-аут каждого HTTP-запроса (LLM_TIMEOUT_MS);
 *  - ограниченные повторы временных ошибок (429/5xx/тайм-аут) с учётом Retry-After / retryDelay;
 *  - измерение: число HTTP-попыток, время ожидания между попытками, время самих запросов;
 *  - структурированный ответ по JSON Schema (Gemini: generationConfig.responseJsonSchema),
 *    с автоматическим отключением схемы, если API её не принимает (ответ 400 о поле схемы);
 *  - ключ передаётся в заголовке и никогда не пишется в журнал.
 * Возвращает {text, usage:{input, output, thoughts}, metrics:{http_attempts, request_ms, wait_ms, structured}}.
 */
const cfg = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let schemaSupported = true; // выключается на время работы процесса, если API отклонил схему

class LlmError extends Error {
  constructor(msg, status, retryAfterMs) {
    super(msg);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfter(res, bodyText) {
  const h = res.headers && res.headers.get && res.headers.get('retry-after');
  if (h && /^\d+(\.\d+)?$/.test(h)) return Number(h) * 1000;
  const m = String(bodyText || '').match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return m ? Number(m[1]) * 1000 : null;
}

async function postJson(url, headers, body, metrics) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.LLM_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new LlmError(`LLM HTTP ${res.status}: ${text.slice(0, 400)}`, res.status, parseRetryAfter(res, text));
    return JSON.parse(text);
  } catch (e) {
    if (e.name === 'AbortError') throw new LlmError(`LLM: тайм-аут ${Math.round(cfg.LLM_TIMEOUT_MS / 1000)} с`, 'timeout');
    if (e instanceof LlmError) throw e;
    throw new LlmError(`LLM: сетевая ошибка (${e.message})`, 'network');
  } finally {
    clearTimeout(timer);
    metrics.request_ms += Date.now() - t0;
  }
}

const RETRIABLE = new Set([429, 500, 502, 503, 504, 529, 'timeout', 'network']);

async function withRetry(fn, metrics) {
  const max = cfg.LLM_MAX_ATTEMPTS;
  for (let i = 0; ; i++) {
    metrics.http_attempts++;
    try {
      return await fn();
    } catch (e) {
      if (!RETRIABLE.has(e.status) || i >= max - 1) throw e;
      const wait = Math.min(60000, e.retryAfterMs != null ? e.retryAfterMs + 250 : 2000 * Math.pow(2, i) + Math.random() * 500);
      console.warn(`[llm] ${e.status} — повтор ${i + 2}/${max} через ${Math.round(wait / 1000)} с`);
      metrics.wait_ms += wait;
      await sleep(wait);
    }
  }
}

const isGemini3 = () => /^gemini-3/i.test(cfg.model);

async function gemini(system, user, schema, metrics) {
  if (!cfg.keys.gemini) throw new Error('Не задан GEMINI_API_KEY в .env');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`;
  const generationConfig = { responseMimeType: 'application/json' };
  // Для Gemini 3 Google рекомендует оставлять температуру по умолчанию (1.0); задаём её только явно.
  if (cfg.TEMPERATURE != null) generationConfig.temperature = cfg.TEMPERATURE;
  else if (!isGemini3()) generationConfig.temperature = 0;
  if (cfg.GEMINI_THINKING_LEVEL) generationConfig.thinkingConfig = { thinkingLevel: cfg.GEMINI_THINKING_LEVEL };
  if (cfg.MAX_OUTPUT_TOKENS) generationConfig.maxOutputTokens = cfg.MAX_OUTPUT_TOKENS;
  const useSchema = schema && schemaSupported && cfg.STRUCTURED_OUTPUT;
  if (useSchema) generationConfig.responseJsonSchema = schema;
  const body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig };
  let j;
  try {
    j = await withRetry(() => postJson(url, { 'x-goog-api-key': cfg.keys.gemini }, body, metrics), metrics);
  } catch (e) {
    if (useSchema && e.status === 400 && /responseJsonSchema|response_json_schema|schema/i.test(e.message)) {
      console.warn('[llm] API не принял responseJsonSchema — продолжаю без схемы (только серверная валидация)');
      schemaSupported = false;
      delete generationConfig.responseJsonSchema;
      j = await withRetry(() => postJson(url, { 'x-goog-api-key': cfg.keys.gemini }, body, metrics), metrics);
    } else throw e;
  }
  metrics.structured = !!generationConfig.responseJsonSchema;
  const cand = j.candidates?.[0];
  if (!cand) throw new LlmError(`LLM: пустой ответ (${JSON.stringify(j.promptFeedback || {}).slice(0, 200)})`, 'empty');
  metrics.finish_reason = cand.finishReason || null;
  const text = (cand.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  const u = j.usageMetadata || {};
  return { text, usage: { input: u.promptTokenCount || 0, output: u.candidatesTokenCount || 0, thoughts: u.thoughtsTokenCount || 0 } };
}

async function deepseek(system, user, schema, metrics) {
  if (!cfg.keys.deepseek) throw new Error('Не задан DEEPSEEK_API_KEY в .env');
  // JSON Output у DeepSeek гарантирует только валидный JSON, схему API не принимает — передаём её в инструкции.
  const content = schema ? `${system}\n\nJSON SCHEMA ОТВЕТА:\n${JSON.stringify(schema)}` : system;
  const body = {
    model: cfg.model,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content }, { role: 'user', content: user }],
  };
  if (cfg.TEMPERATURE != null) body.temperature = cfg.TEMPERATURE;
  if (cfg.DEEPSEEK_REASONING_EFFORT) body.reasoning_effort = cfg.DEEPSEEK_REASONING_EFFORT;
  if (cfg.MAX_OUTPUT_TOKENS) body.max_tokens = cfg.MAX_OUTPUT_TOKENS;
  const j = await withRetry(() => postJson(`${cfg.DEEPSEEK_BASE_URL}/chat/completions`, { Authorization: `Bearer ${cfg.keys.deepseek}` }, body, metrics), metrics);
  const choice = j.choices?.[0];
  if (!choice) throw new LlmError('LLM: пустой ответ', 'empty');
  metrics.structured = false;
  metrics.finish_reason = choice.finish_reason || null;
  // completion_tokens включает токены размышления; разделяем их, как у Gemini.
  const thoughts = j.usage?.completion_tokens_details?.reasoning_tokens || 0;
  return { text: choice.message?.content || '', usage: { input: j.usage?.prompt_tokens || 0, output: Math.max(0, (j.usage?.completion_tokens || 0) - thoughts), thoughts } };
}

async function openai(system, user, schema, metrics) {
  if (!cfg.keys.openai) throw new Error('Не задан OPENAI_API_KEY в .env');
  const j = await withRetry(() => postJson(`${cfg.OPENAI_BASE_URL}/chat/completions`, { Authorization: `Bearer ${cfg.keys.openai}` }, {
    model: cfg.model,
    temperature: cfg.TEMPERATURE ?? 0,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  }, metrics), metrics);
  metrics.structured = false;
  return { text: j.choices?.[0]?.message?.content || '', usage: { input: j.usage?.prompt_tokens || 0, output: j.usage?.completion_tokens || 0, thoughts: 0 } };
}

async function anthropic(system, user, schema, metrics) {
  if (!cfg.keys.anthropic) throw new Error('Не задан ANTHROPIC_API_KEY в .env');
  const j = await withRetry(() => postJson('https://api.anthropic.com/v1/messages', { 'x-api-key': cfg.keys.anthropic, 'anthropic-version': '2023-06-01' }, {
    model: cfg.model,
    max_tokens: cfg.MAX_OUTPUT_TOKENS || 8192,
    temperature: cfg.TEMPERATURE ?? 0,
    system,
    messages: [{ role: 'user', content: user }],
  }, metrics), metrics);
  metrics.structured = false;
  return { text: (j.content || []).map((c) => c.text || '').join(''), usage: { input: j.usage?.input_tokens || 0, output: j.usage?.output_tokens || 0, thoughts: 0 } };
}

/** Один логический запрос к модели (внутри — ограниченные повторы временных ошибок). */
async function complete(system, user, schema) {
  const fn = { deepseek, gemini, openai, anthropic }[cfg.provider];
  if (!fn) throw new Error(`Неизвестный LLM_PROVIDER: ${cfg.provider}`);
  const metrics = { http_attempts: 0, request_ms: 0, wait_ms: 0, structured: false, finish_reason: null };
  try {
    const r = await fn(system, user, schema, metrics);
    return { ...r, metrics };
  } catch (e) {
    e.metrics = metrics;
    throw e;
  }
}

/** Достаёт JSON из ответа модели (на случай ```json ... ``` обёртки). */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Модель вернула не-JSON ответ');
  }
}

module.exports = { complete, parseJson, _reset: () => (schemaSupported = true) };

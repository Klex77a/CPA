'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const optNum = (v) => (v === undefined || v === '' ? null : Number(v));

// Минимальный парсер .env (без зависимостей)
function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv();

const env = process.env;
let provider = (env.LLM_PROVIDER || (env.DEEPSEEK_API_KEY ? 'deepseek' : env.GEMINI_API_KEY ? 'gemini' : env.OPENAI_API_KEY ? 'openai' : env.ANTHROPIC_API_KEY ? 'anthropic' : 'mock')).toLowerCase();
const keyFor = { deepseek: env.DEEPSEEK_API_KEY, gemini: env.GEMINI_API_KEY, openai: env.OPENAI_API_KEY, anthropic: env.ANTHROPIC_API_KEY };
if (provider !== 'mock' && !keyFor[provider]) {
  console.warn(`[config] LLM_PROVIDER=${provider}, но ключ не задан — включён ДЕМО-режим без ИИ (mock).`);
  provider = 'mock';
}

const defaultModels = {
  deepseek: 'deepseek-flash',
  gemini: 'gemini-3.8-flash',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-5-5',
  mock: 'mock-heuristic',
};

const model = env.LLM_MODEL || defaultModels[provider] || '';
// Цены DeepSeek в часы пик, без учёта кэша (https://api-docs.deepseek.com/quick_start/pricing) — оценка сверху.
const deepseekPrice = /pro/i.test(model) ? { in: 1.32, out: 3.96 } : { in: 0.3, out: 1.2 };

module.exports = {
  ROOT,
  DATA_DIR: process.env.CQA_DATA_DIR || path.join(ROOT, 'data'),
  PUBLIC_DIR: path.join(ROOT, 'public'),
  PORT: Number(env.PORT || 3000),
  // Ссылка GET организаторов БЕЗ параметра group_id (он подставляется сервером)
  DATA_API_URL: env.DATA_API_URL || '',
  provider,
  model,
  keys: {
    deepseek: env.DEEPSEEK_API_KEY || '',
    gemini: env.GEMINI_API_KEY || '',
    openai: env.OPENAI_API_KEY || '',
    anthropic: env.ANTHROPIC_API_KEY || '',
  },
  OPENAI_BASE_URL: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  DEEPSEEK_BASE_URL: (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
  CONCURRENCY: Math.max(1, Number(env.CONCURRENCY || 2)),
  // Сколько независимых прогонов модели на один диалог (голосование большинством). 1 = быстро, 3 = точнее.
  SAMPLES: Math.max(1, Math.min(7, Number(env.SAMPLES || 1))),
  // Температура: если не задана — для Gemini 3 не передаётся (рекомендация Google — значение по умолчанию 1.0),
  // для остальных моделей 0.
  TEMPERATURE: optNum(env.TEMPERATURE),
  // Уровень «размышления» Gemini 3 (minimal | low | medium | high). Не задан — значение модели по умолчанию.
  GEMINI_THINKING_LEVEL: env.GEMINI_THINKING_LEVEL || '',
  // Режим размышления DeepSeek: none (выключить) | low | high | max. Не задан — значение API (размышление включено).
  DEEPSEEK_REASONING_EFFORT: env.DEEPSEEK_REASONING_EFFORT || '',
  STRUCTURED_OUTPUT: env.STRUCTURED_OUTPUT !== '0',
  MAX_OUTPUT_TOKENS: optNum(env.MAX_OUTPUT_TOKENS),
  LLM_TIMEOUT_MS: Math.max(10000, Number(env.LLM_TIMEOUT_MS || 240000)),
  LLM_MAX_ATTEMPTS: Math.max(1, Math.min(6, Number(env.LLM_MAX_ATTEMPTS || 3))),
  // Сколько раз можно переспросить модель, если её ответ не прошёл валидацию
  REPAIR_ATTEMPTS: Math.max(0, Math.min(2, Number(env.REPAIR_ATTEMPTS ?? 1))),
  // Цена за 1M токенов (USD) для оценки стоимости — меняйте под свою модель
  PRICE_IN_PER_M: Number(env.PRICE_IN_PER_M || (provider === 'deepseek' ? deepseekPrice.in : provider === 'gemini' ? 0.3 : provider === 'openai' ? 0.15 : provider === 'anthropic' ? 1 : 0)),
  PRICE_OUT_PER_M: Number(env.PRICE_OUT_PER_M || (provider === 'deepseek' ? deepseekPrice.out : provider === 'gemini' ? 2.5 : provider === 'openai' ? 0.6 : provider === 'anthropic' ? 5 : 0)),
};

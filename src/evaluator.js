'use strict';
/**
 * Оценка диалога:
 *   транскрипт + сохранённый чек-лист → запрос к модели (структурированный JSON)
 *   → строгая серверная валидация (ответы, N/A, шкала, доказательства)
 *   → не более REPAIR_ATTEMPTS повторных запросов с перечнем ошибок
 *   → расчёт баллов кодом (scoring.js) → итоговый вывод и рекомендации, собранные из результатов критериев.
 */
const crypto = require('crypto');
const cfg = require('./config');
const llm = require('./llm');
const mock = require('./mock');
const { computeScore, validateAnswer, validateChecklist, round } = require('./scoring');
const { safeFailureMessage } = require('./evaluation-failure');

const { PROMPT_VERSION, SYSTEM_PROMPT, buildUserPrompt, buildSchema, computeFacts } = require('./evaluation-prompt');

const sha = (x) => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');

// ---------- валидация ответа модели ----------

const norm = (s) => String(s ?? '').toLowerCase().replace(/[«»“”"'`]/g, '').replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim();

function parseMsgId(ref, n) {
  if (typeof ref !== 'string') return { error: 'ID доказательства должен быть строкой m<номер>' };
  const m = ref.trim().match(/^m(\d+)$/i);
  if (!m) return { error: `ID «${ref}» не в формате m<номер>` };
  const i = Number(m[1]);
  if (i >= n) return { error: `реплики ${ref} нет в диалоге (m0–m${n - 1})` };
  return { index: i };
}

function parseRange(r, n, label, errs) {
  if (!r) return null;
  const a = parseMsgId(r.from, n);
  const b = parseMsgId(r.to, n);
  if (a.error || b.error) { errs.push(`${label}: ${a.error || b.error}`); return null; }
  if (a.index > b.index) { errs.push(`${label}: начало m${a.index} позже конца m${b.index}`); return null; }
  return { from: a.index, to: b.index };
}

/**
 * Проверяет ответ модели целиком. Ничего не «подгоняет»: всё недопустимое попадает в errors.
 * @returns {criteria:{[id]:{...}}, errors:[{criterion, message}], operator_name, coaching}
 */
function validateOutput(checklist, record, parsed) {
  const tr = record.transcript || [];
  const n = tr.length;
  const errors = [];
  const out = {};
  const list = Array.isArray(parsed && parsed.criteria) ? parsed.criteria : [];
  if (!Array.isArray(parsed && parsed.criteria)) errors.push({ criterion: null, message: 'нет массива criteria' });

  const seen = Object.create(null);
  for (const item of list) {
    const id = typeof item?.id === 'string' ? item.id : '';
    seen[id] = (seen[id] || 0) + 1;
    if (!checklist.criteria.some((c) => c.id === id)) errors.push({ criterion: id, message: `неизвестный критерий ${id}` });
  }
  for (const [id, cnt] of Object.entries(seen)) if (cnt > 1) errors.push({ criterion: id, message: `критерий ${id} оценён ${cnt} раза` });

  for (const c of checklist.criteria) {
    const raw = list.find((x) => x?.id === c.id);
    const errs = [];
    if (!raw) {
      errors.push({ criterion: c.id, message: `нет оценки критерия ${c.id}` });
      out[c.id] = { answer: 'INVALID', value: null, explanation: '', evidence: [], missing_range: null, checked_range: null, na_reason: null, unverified_claims: [], issues: ['Модель не вернула оценку'] };
      continue;
    }
    if (seen[c.id] > 1) errs.push('Модель вернула несколько оценок этого критерия');
    const notObservable = typeof raw.not_observable_reason === 'string' ? raw.not_observable_reason.trim() : '';
    if (raw.not_observable_reason != null && typeof raw.not_observable_reason !== 'string') errs.push('not_observable_reason должен быть строкой или null');
    let ans;
    if (notObservable) {
      errs.push(`Недостаточно данных для оценки: ${notObservable}`);
      ans = { answer: 'INVALID', value: null };
    } else try {
      ans = validateAnswer(c, { answer: raw.answer, value: raw.score ?? raw.value });
    } catch (e) {
      errs.push(e.message);
      ans = { answer: 'INVALID', value: null };
    }
    const explanation = typeof raw.explanation === 'string' ? raw.explanation.trim() : '';
    if (!explanation) errs.push('пустое объяснение');

    const evidence = [];
    for (const e of Array.isArray(raw.evidence) ? raw.evidence : []) {
      const p = parseMsgId(e && e.msg, n);
      if (p.error) { errs.push(`доказательство: ${p.error}`); continue; }
      const full = String(tr[p.index].text ?? '');
      const frag = typeof e?.fragment === 'string' ? e.fragment.trim() : '';
      if (e?.fragment != null && typeof e.fragment !== 'string') errs.push('фрагмент доказательства должен быть строкой');
      if (frag && !norm(full).includes(norm(frag))) { errs.push(`фрагмент «${frag.slice(0, 60)}» не входит в реплику m${p.index}`); continue; }
      if (!evidence.some((x) => x.msg === p.index)) evidence.push({ msg: p.index, fragment: frag || null });
    }
    const missing = parseRange(raw.missing_range, n, 'missing_range', errs);
    const checked = parseRange(raw.checked_range, n, 'checked_range', errs);
    const proofIndices = evidence.map(item => item.msg);
    if (checked) for (let index = checked.from; index <= checked.to; index++) proofIndices.push(index);
    if ((ans.answer === 'YES' || ans.answer === 'SCORE' && ans.value > 0) && proofIndices.length && proofIndices.every(index => tr[index].speaker === 'bot')) {
      errs.push('Только реплики бота не подтверждают действие оператора');
    }
    const naReason = ans.answer === 'NA' ? typeof raw.na_reason === 'string' ? raw.na_reason.trim() : '' : null;

    // наличие необходимых оснований
    if (ans.answer === 'NA') {
      if (!naReason) errs.push('NA без причины (na_reason)');
      if (!evidence.length && !checked) errs.push('NA без контекста (реплик или проверенного участка)');
    } else if (c.type === 'flag' && ans.answer === 'NO') {
      if (!evidence.length && !checked) errs.push('для «нарушений нет» нужен проверенный участок (checked_range) или реплики');
    } else if (ans.answer === 'NO') {
      if (!evidence.length && !missing) errs.push('NO без реплик и без участка, где действие ожидалось (missing_range)');
    } else if (ans.answer === 'YES' || ans.answer === 'SCORE') {
      if (!evidence.length && !checked) errs.push(`${ans.answer === 'SCORE' ? 'оценка' : 'YES'} без реплик-доказательств`);
    }

    for (const m of errs) errors.push({ criterion: c.id, message: `${c.id}: ${m}`, ...(notObservable && m === `Недостаточно данных для оценки: ${notObservable}` ? { code: 'NOT_OBSERVABLE' } : {}) });
    out[c.id] = {
      answer: ans.answer,
      value: ans.value,
      explanation,
      evidence,
      missing_range: missing,
      checked_range: checked,
      na_reason: naReason,
      not_observable_reason: notObservable || null,
      unverified_claims: (Array.isArray(raw.unverified_claims) ? raw.unverified_claims : []).filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, 5),
      issues: errs,
    };
  }

  checkDuplicateExplanations(checklist, out, errors);

  const coaching = (Array.isArray(parsed && parsed.coaching) ? parsed.coaching : [])
    .filter((x) => x && checklist.criteria.some((c) => c.id === x.criterion_id) && typeof x.text === 'string' && x.text.trim())
    .map((x) => ({ criterion_id: x.criterion_id, type: x.type === 'required' ? 'required' : 'optional', text: x.text.trim() }))
    .slice(0, 3);

  return { criteria: out, errors, operator_name: cleanName(parsed && parsed.operator_name), coaching };
}

function checkDuplicateExplanations(checklist, criteria, errors) {
  const byText = new Map();
  for (const c of checklist.criteria) {
    const text = norm(criteria[c.id].explanation);
    if (text.length > 20) byText.set(text, [...(byText.get(text) || []), c.id]);
  }
  for (const ids of byText.values()) if (ids.length > 1) for (const id of ids) {
    const message = `одинаковое объяснение у критериев ${ids.join(', ')} — нужно отдельное основание по определению каждого`;
    if (!criteria[id].issues.includes(message)) criteria[id].issues.push(message);
    if (!errors.some((error) => error.criterion === id && error.message === `${id}: ${message}`)) errors.push({ criterion: id, message: `${id}: ${message}` });
  }
}

function cleanName(v) {
  const s = typeof v === 'string' ? v.trim().replace(/[«»"'.!,]/g, '') : '';
  if (!s || /^(null|none|нет|unknown|неизвестно)$/i.test(s) || s.length > 40) return null;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** «Обязательная» рекомендация допустима только для невыполненного/сниженного критерия. */
function reconcileCoaching(coaching, checklist, criteria) {
  return coaching.map((x) => {
    const c = checklist.criteria.find((k) => k.id === x.criterion_id);
    const a = criteria[x.criterion_id];
    const failed = a && ((a.answer === 'NO' && c.type !== 'flag') || (c.type === 'flag' && a.answer === 'YES') || (a.answer === 'SCORE' && a.value < Math.max(...c.scale.map((s) => s.value))));
    return { ...x, type: x.type === 'required' && !failed ? 'optional' : x.type, criterion_title: c.title };
  });
}

/** Итоговый вывод строится из результатов критериев — он не может им противоречить. */
function buildSummary(checklist, criteria, result, globalErrors = []) {
  const label = (c) => `«${c.title}»`;
  const met = [], lowered = [], na = [], review = [];
  for (const c of checklist.criteria) {
    const a = criteria[c.id];
    if (!a || c.type === 'flag') continue;
    if (a.answer === 'INVALID' || (a.issues || []).length) review.push(label(c));
    if (a.answer === 'NA') na.push(label(c));
    else if (a.answer === 'YES' || (a.answer === 'SCORE' && a.value === Math.max(...c.scale.map((s) => s.value)))) met.push(label(c));
    else if (a.answer === 'NO' || a.answer === 'SCORE') lowered.push(c.type === 'scale' ? `${label(c)} (${a.value} из ${Math.max(...c.scale.map((s) => s.value))})` : label(c));
  }
  const parts = [];
  if (met.length) parts.push(`Выполнено: ${met.join(', ')}.`);
  if (lowered.length) parts.push(`Снижено: ${lowered.join(', ')}.`);
  if (na.length) parts.push(`Неприменимо (N/A): ${na.join(', ')}.`);
  const flags = checklist.criteria.filter(c => c.type === 'flag');
  const unresolvedFlag = flags.some(c => !criteria[c.id] || criteria[c.id].answer === 'INVALID' || criteria[c.id].review_required || (criteria[c.id].issues || []).length);
  if (flags.length === 1 && flags[0].title === 'Грубые ошибки') {
    parts.push(unresolvedFlag ? 'Проверка грубых ошибок не завершена.' : result.gross_error ? 'Выявлена грубая ошибка.' : 'Грубых ошибок не выявлено.');
  } else if (flags.length) {
    const raised = flags.filter(c => criteria[c.id]?.answer === 'YES' && !(criteria[c.id].issues || []).length && !criteria[c.id].review_required);
    if (raised.length) parts.push(`Выявлены флаги: ${raised.map(label).join(', ')}.`);
    if (unresolvedFlag) parts.push('Проверка части флагов не завершена.');
    else if (!raised.length) parts.push('События, проверяемые флагами чек-листа, не выявлены.');
  }
  const unverified = checklist.criteria.filter((c) => (criteria[c.id]?.unverified_claims || []).length).map(label);
  if (unverified.length) parts.push(`Фактическая корректность информации оператора не проверена по базе знаний (${unverified.join(', ')}).`);
  if (review.length) parts.push(`Требует проверки человеком: ${review.join(', ')}.`);
  if (globalErrors.length) parts.push('Структура ответа модели требует проверки человеком.');
  return parts.join(' ');
}

// ---------- ключ кэша ----------

function settingsFingerprint() {
  const thinking = cfg.provider === 'gemini' ? cfg.GEMINI_THINKING_LEVEL : cfg.provider === 'deepseek' ? cfg.DEEPSEEK_REASONING_EFFORT : null;
  const settings = { provider: cfg.provider, model: cfg.model, samples: cfg.provider === 'mock' ? 1 : cfg.SAMPLES, temperature: cfg.TEMPERATURE, thinking: thinking || null, structured: cfg.STRUCTURED_OUTPUT, repair: cfg.REPAIR_ATTEMPTS, prompt: PROMPT_VERSION, kb: null };
  // The prompt version separates new requests from historical paid evaluations.
  // Service/output overrides also require a distinct key.
  if (cfg.MAX_OUTPUT_TOKENS != null) settings.max_output_tokens = cfg.MAX_OUTPUT_TOKENS;
  const endpoint = cfg.provider === 'deepseek' ? cfg.DEEPSEEK_BASE_URL : cfg.provider === 'openai' ? cfg.OPENAI_BASE_URL : null;
  const standardEndpoint = cfg.provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com/v1';
  if (endpoint && endpoint.replace(/\/+$/, '') !== standardEndpoint) settings.endpoint_hash = sha(endpoint.replace(/\/+$/, ''));
  return settings;
}
/** Operational limits are measured separately from scoring/cache identity. */
function runtimeFingerprint() {
  return { version: 1, execution_mode: cfg.CLOUD_MODE ? 'cloud-stepped' : 'local', timeout_ms: cfg.LLM_TIMEOUT_MS, max_attempts: cfg.LLM_MAX_ATTEMPTS, repair_attempts: cfg.REPAIR_ATTEMPTS, samples: cfg.provider === 'mock' ? 1 : cfg.SAMPLES, concurrency: cfg.CLOUD_MODE ? 1 : cfg.CONCURRENCY };
}
function checklistContent(cl) {
  return { name: cl.name, notes: cl.notes || '', rounding: cl.rounding, sections: cl.sections || [], criteria: cl.criteria };
}
/** Ключ: содержимое диалога + содержимое и версия чек-листа + модель и значимые настройки + версия инструкций. */
function cacheKey(record, checklist) {
  return sha({ conv: record.conversation_id, transcript: record.transcript, channel: record.channel, language: record.language, checklist_id: checklist.id, checklist_version: checklist.version, checklist: sha(checklistContent(checklist)), settings: settingsFingerprint() });
}

// ---------- голосование ----------

function vote(cands) {
  if (cands.length === 1) return cands[0];
  const key = (x) => x.answer;
  const tally = {};
  cands.forEach((x) => (tally[key(x)] = (tally[key(x)] || 0) + 1));
  const best = Object.keys(tally).sort((a, b) => tally[b] - tally[a] || cands.findIndex((x) => key(x) === a) - cands.findIndex((x) => key(x) === b))[0];
  const pool = cands.filter((x) => key(x) === best);
  if (best !== 'SCORE') return pool[0];
  const vals = pool.map((x) => x.value).sort((a, b) => a - b);
  const median = vals[Math.floor((vals.length - 1) / 2)];
  return pool.find((x) => x.value === median) || pool[0];
}

// ---------- один прогон: запрос → валидация → (ограниченный) повтор ----------

async function runOnce(record, checklist, timing) {
  const system = SYSTEM_PROMPT;
  const user = buildUserPrompt(record, checklist);
  const schema = buildSchema(checklist);
  let usage = { input: 0, output: 0, thoughts: 0 };
  let prompt = user;
  let last = null;
  for (let attempt = 0; attempt <= cfg.REPAIR_ATTEMPTS; attempt++) {
    const t0 = Date.now();
    let res, parsed;
    try {
      res = await llm.complete(system, prompt, schema);
    } catch (e) {
      timing.calls.push({ kind: attempt ? 'repair' : 'initial', ok: false, ...(e.metrics || {}), ...callAccounting(e.metrics?.usage, e.metrics), error: safeFailureMessage(e).slice(0, 160), ms: Date.now() - t0 });
      throw e;
    }
    const accounting = callAccounting(res.usage, res.metrics);
    usage = addUsage(usage, accounting.known_usage);
    const call = { kind: attempt ? 'repair' : 'initial', ok: true, ...res.metrics, ...accounting, ms: Date.now() - t0 };
    timing.calls.push(call);
    const v0 = Date.now();
    try { parsed = llm.parseJson(res.text); } catch (e) { parsed = null; }
    const v = parsed ? validateOutput(checklist, record, parsed) : { criteria: {}, errors: [{ criterion: null, message: 'ответ модели не является JSON' }], coaching: [], operator_name: null };
    timing.validation_ms += Date.now() - v0;
    call.errors = v.errors.length;
    call.ms = Date.now() - t0;
    last = v;
    // A repair cannot provide absent audio/knowledge. Do not ask the model to
    // invent a passing value just to erase an explicit observation limitation.
    if (!v.errors.some(error => error.code !== 'NOT_OBSERVABLE')) break;
    if (attempt < cfg.REPAIR_ATTEMPTS) {
      prompt = `${user}

ТВОЙ ПРЕДЫДУЩИЙ ОТВЕТ НЕ ПРОШЁЛ ПРОВЕРКУ. Исправь перечисленное и верни полный JSON заново (все критерии):
${v.errors.map((e) => '- ' + e.message).join('\n')}

Исправляй ошибки структуры и доказательств. Отсутствующие исходные данные не появились: сохраняй not_observable_reason для непроверяемых обязательных свойств, не выдумывай оценку ради прохождения проверки.

Предыдущий ответ:
${String(res.text).slice(0, 12000)}`;
    }
  }
  // если после повторов остались ошибки, полностью невалидный ответ уже помечен INVALID,
  // а критерии с проблемами доказательств помечаются как требующие проверки
  if (!last.criteria || !Object.keys(last.criteria).length) {
    last.criteria = Object.fromEntries(checklist.criteria.map((c) => [c.id, { answer: 'INVALID', value: null, explanation: '', evidence: [], missing_range: null, checked_range: null, na_reason: null, unverified_claims: [], issues: ['Модель не вернула корректный JSON'] }]));
  }
  return { ...last, usage };
}

function measuredUsage(usage) {
  return Object.fromEntries(['input', 'output', 'thoughts'].map((key) => [key, typeof usage?.[key] === 'number' && Number.isFinite(usage[key]) && usage[key] >= 0 ? usage[key] : 0]));
}
function addUsage(a, b) {
  return { input: a.input + b.input, output: a.output + b.output, thoughts: a.thoughts + b.thoughts };
}
function callAccounting(usage, metrics = {}) {
  const reported = usage && ['input', 'output'].every(key => typeof usage[key] === 'number' && Number.isFinite(usage[key]) && usage[key] >= 0) && (usage.thoughts === undefined || typeof usage.thoughts === 'number' && Number.isFinite(usage.thoughts) && usage.thoughts >= 0) && metrics?.usage_reported !== false;
  const attempts = Number.isSafeInteger(metrics?.http_attempts) ? Math.max(0, metrics.http_attempts) : 1;
  const unknown = Math.max(Number.isSafeInteger(metrics?.unknown_call_count) ? metrics.unknown_call_count : 0, reported ? 0 : attempts);
  const known = measuredUsage(usage);
  return { usage: reported ? known : null, known_usage: known, unknown_call_count: unknown, billing_complete: unknown === 0 };
}
function measuredWork(timing, startedAt, samples, successfulSamples) {
  const knownUsage = timing.calls.reduce((total, call) => addUsage(total, measuredUsage(call.known_usage || call.usage)), { input: 0, output: 0, thoughts: 0 });
  const unknownCalls = timing.calls.reduce((sum, call) => sum + (call.unknown_call_count || 0), 0);
  timing.total_ms = Date.now() - startedAt;
  timing.llm_ms = timing.calls.reduce((sum, call) => sum + (call.request_ms || 0), 0);
  timing.retry_wait_ms = timing.calls.reduce((sum, call) => sum + (call.wait_ms || 0), 0);
  timing.http_attempts = timing.calls.reduce((sum, call) => sum + (call.http_attempts || 0), 0);
  const cost = round((knownUsage.input * cfg.PRICE_IN_PER_M + (knownUsage.output + knownUsage.thoughts) * cfg.PRICE_OUT_PER_M) / 1e6, 6);
  return { usage: unknownCalls ? null : knownUsage, cost_usd: unknownCalls ? null : cost, known_usage: knownUsage, known_cost_usd: cost, billing_complete: unknownCalls === 0, unknown_call_count: unknownCalls, duration_ms: timing.total_ms, timing, samples, successful_samples: successfulSamples };
}

/** Keep the chosen proof, errors and coaching from the same sample. */
function combineRuns(runs, checklist) {
  if (runs.length === 1) return runs[0];
  const criteria = {}, selected = new Map();
  for (const c of checklist.criteria) {
    const candidates = runs.map((run) => run.criteria[c.id]);
    // An invalid answer or broken evidence cannot outvote a validated candidate.
    const valid = candidates.filter((candidate) => candidate.answer !== 'INVALID' && !(candidate.issues || []).length);
    const chosen = vote(valid.length ? valid : candidates);
    criteria[c.id] = { ...chosen, issues: [...(chosen.issues || [])], agreement: { agree: candidates.filter((candidate) => candidate.answer === chosen.answer && candidate.value === chosen.value).length, runs: candidates.length } };
    selected.set(c.id, runs[candidates.indexOf(chosen)]);
  }
  const errors = Object.entries(criteria).flatMap(([id, criterion]) => (criterion.issues || []).map((message) => ({ criterion: id, message: `${id}: ${message}` })));
  checkDuplicateExplanations(checklist, criteria, errors);
  // Preserve unscoped response-shape errors only when their sample contributes
  // to the selected result; discarded runs must not leave stale validation errors.
  const usedRuns = new Set(selected.values());
  for (const run of usedRuns) for (const error of run.errors || []) {
    if (!checklist.criteria.some((criterion) => criterion.id === error.criterion)) errors.push(error);
  }
  const coaching = checklist.criteria.flatMap((criterion) => (selected.get(criterion.id).coaching || []).filter((item) => item.criterion_id === criterion.id)).slice(0, 3);
  return { criteria, errors, operator_name: runs[0].operator_name, coaching };
}

const inflight = new Map();

/** Публичная функция оценки. Одинаковые одновременные запросы (тот же ключ) объединяются. */
function evaluate(record, checklist, groupId, opts = {}) {
  const problems = validateChecklist(checklist);
  if (problems.length) return Promise.reject(Object.assign(new Error(`Некорректный чек-лист: ${problems.join('; ')}`), { status: 400 }));
  if (!record || !['agent chat', 'voice call'].includes(record.channel) || !Array.isArray(record.transcript) || !record.transcript.length) {
    return Promise.reject(Object.assign(new Error('Для оценки нужен чат или звонок с непустым транскриптом'), { status: 400 }));
  }
  const key = cacheKey(record, checklist);
  // Результат содержит историю апелляций группы, поэтому объединяем только запросы этой группы.
  const requestKey = JSON.stringify([groupId, key, opts.operation_id || null]);
  if (inflight.has(requestKey)) return inflight.get(requestKey);
  const p = doEvaluate(record, checklist, groupId, key, opts).finally(() => inflight.delete(requestKey));
  inflight.set(requestKey, p);
  return p;
}

async function doEvaluate(record, checklist, groupId, key, opts) {
  // Freeze the exact source before awaiting the model. Later imports or caller
  // mutations must not change the transcript behind this evaluation's proof IDs.
  const recordSnapshot = JSON.parse(JSON.stringify({
    conversation_id: record.conversation_id,
    channel: record.channel,
    language: record.language,
    transcript: record.transcript,
    audio_url: record.audio_url ?? null,
  }));
  record = recordSnapshot;
  checklist = JSON.parse(JSON.stringify(checklist));
  const t0 = Date.now();
  const timing = { queue_ms: opts.queue_ms || 0, calls: [], validation_ms: 0, total_ms: 0 };
  let successfulSamples = 1;
  let v;

  if (cfg.provider === 'mock') {
    const parsed = mock.evaluate(record, checklist);
    v = validateOutput(checklist, record, parsed);
  } else {
    // Wait for every concurrent sample before reporting failure, so late billed
    // responses are included in the measured usage and no work is left behind.
    const runs = await Promise.allSettled(Array.from({ length: cfg.SAMPLES }, () => runOnce(record, checklist, timing)));
    const ok = runs.filter((run) => run.status === 'fulfilled').map((run) => run.value);
    successfulSamples = ok.length;
    if (!ok.length) {
      const cause = runs[0].reason;
      const error = new Error(cfg.SAMPLES === 1 ? safeFailureMessage(cause) : 'Все прогоны модели завершились ошибкой');
      if (cfg.SAMPLES === 1 && cause?.status != null) error.status = cause.status;
      if (cfg.SAMPLES === 1 && /^PROVIDER_[A-Z0-9_]+$/.test(cause?.code || '')) error.code = cause.code;
      error.evaluation_metrics = measuredWork(timing, t0, cfg.SAMPLES, 0);
      throw error;
    }
    for (const run of runs) if (run.status === 'rejected') console.warn(`[eval] ${record.conversation_id}: прогон не удался — ${safeFailureMessage(run.reason)}`);
    v = combineRuns(ok, checklist);
  }

  const criteria = {};
  for (const c of checklist.criteria) {
    const a = v.criteria[c.id];
    criteria[c.id] = { ...a, review_required: a.answer === 'INVALID' || (a.issues || []).length > 0, fact_check: (a.unverified_claims || []).length ? 'needs_human' : null };
  }
  const result = computeScore(checklist, criteria);
  const coaching = reconcileCoaching(v.coaching || [], checklist, criteria);
  const globalErrors = (v.errors || []).filter((error) => !checklist.criteria.some((criterion) => criterion.id === error.criterion)).map((error) => error.message);
  const needsReview = (v.errors || []).length > 0 || Object.values(criteria).some((x) => x.review_required);
  const work = measuredWork(timing, t0, cfg.provider === 'mock' ? 1 : cfg.SAMPLES, successfulSamples);
  const usage = work.known_usage;
  console.log(`[eval] ${record.conversation_id}: ${(timing.total_ms / 1000).toFixed(1)} с, вызовов ${timing.calls.length}, HTTP-попыток ${timing.http_attempts}, ожидание повторов ${(timing.retry_wait_ms / 1000).toFixed(1)} с, наблюдённые токены in/out/think ${usage.input}/${usage.output}/${usage.thoughts}${work.billing_complete ? '' : `, расход неполный: попыток без usage ${work.unknown_call_count}`}${needsReview ? ', ТРЕБУЕТ ПРОВЕРКИ' : ''}`);

  return {
    id: `${groupId}__${record.conversation_id}__${checklist.id}__v${checklist.version}__${key.slice(0, 10)}${opts.force ? '__' + crypto.randomBytes(6).toString('hex') : ''}`,
    cache_key: key,
    prompt_version: PROMPT_VERSION,
    settings: settingsFingerprint(),
    conversation_id: record.conversation_id,
    transcript_hash: sha(record.transcript).slice(0, 16),
    record_snapshot: recordSnapshot,
    group_id: groupId,
    channel: record.channel,
    language: record.language,
    checklist: { id: checklist.id, version: checklist.version, name: checklist.name, content_hash: sha(checklistContent(checklist)).slice(0, 16) },
    checklist_snapshot: checklist,
    provider: cfg.provider,
    model: cfg.model,
    samples: cfg.provider === 'mock' ? 1 : cfg.SAMPLES,
    successful_samples: successfulSamples,
    status: needsReview ? 'needs_review' : 'ok',
    validation_errors: (v.errors || []).map((e) => e.message),
    global_validation_errors: globalErrors,
    created_at: new Date().toISOString(),
    duration_ms: timing.total_ms,
    timing,
    usage: work.usage,
    cost_usd: work.cost_usd,
    known_usage: work.known_usage,
    known_cost_usd: work.known_cost_usd,
    billing_complete: work.billing_complete,
    unknown_call_count: work.unknown_call_count,
    knowledge_base: null,
    operator_name: v.operator_name || null,
    coaching,
    summary: buildSummary(checklist, criteria, result, globalErrors),
    criteria,
    original_result: result,
    final_criteria: JSON.parse(JSON.stringify(criteria)),
    final_result: result,
    appeals: [],
  };
}

/** Пересчёт финального результата после решений по апелляциям (та же функция расчёта). */
function recompute(evaluation) {
  const cl = evaluation.checklist_snapshot;
  if (!evaluation.original_summary) evaluation.original_summary = evaluation.summary;
  if (!evaluation.original_coaching) evaluation.original_coaching = JSON.parse(JSON.stringify(evaluation.coaching || []));
  const finalCriteria = JSON.parse(JSON.stringify(evaluation.criteria));
  for (const ap of evaluation.appeals) {
    if (ap.status !== 'resolved' || ap.decision?.action !== 'change') continue;
    const c = cl.criteria.find((x) => x.id === ap.criterion_id);
    if (!c) continue;
    const a = validateAnswer(c, { answer: ap.decision.answer, value: ap.decision.value });
    finalCriteria[c.id] = {
      ...finalCriteria[c.id], answer: a.answer, value: a.value,
      changed_by_appeal: ap.id, reviewer_reason: ap.decision.reason,
      explanation: ap.decision.reason, na_reason: a.answer === 'NA' ? ap.decision.reason : null,
      issues: [], review_required: false, not_observable_reason: null,
    };
  }
  evaluation.final_criteria = finalCriteria;
  evaluation.final_result = computeScore(cl, finalCriteria);
  evaluation.summary = buildSummary(cl, finalCriteria, evaluation.final_result, evaluation.global_validation_errors || []);
  evaluation.coaching = reconcileCoaching(evaluation.original_coaching, cl, finalCriteria);
  evaluation.status = (evaluation.global_validation_errors || []).length || Object.values(finalCriteria).some((x) => x.review_required || x.answer === 'INVALID' || (x.issues || []).length) ? 'needs_review' : 'ok';
  return evaluation;
}

module.exports = { evaluate, recompute, cacheKey, settingsFingerprint, runtimeFingerprint, validateOutput, buildUserPrompt, buildSchema, buildSummary, computeFacts, vote, SYSTEM_PROMPT, PROMPT_VERSION };

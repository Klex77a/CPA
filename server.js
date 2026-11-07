'use strict';
/**
 * CQA — Conversation Quality Analytics (прототип для хакатона Freedom Broker).
 * Запуск: node server.js  → http://localhost:3000
 * Локальный JSON-режим: Node.js 18+. Облачный режим использует pg/Postgres.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./src/config');
const store = require('./src/store');
const { evaluate, recompute, cacheKey } = require('./src/evaluator');
const { audioSegments } = require('./src/audio-offsets');
const { validateChecklist, validateAnswer, AnswerError } = require('./src/scoring');
const { buildSubmission } = require('./src/result-export');
const { fetchAudioPage, assertAudioPageUrl } = require('./src/audio-access');
const { saveEvaluationFailure } = require('./src/evaluation-failure');
const { evaluationFreshness } = require('./src/evaluation-freshness');
const { getReadiness, inspectBenchmark, benchmarkReportPath } = require('./src/readiness');
const { authorize, isSameOrigin } = require('./src/access');
const { HttpBuffer } = require('./src/http-buffer');

// ---------- начальный чек-лист ----------
// Исходный чек-лист из PDF лежит в src/default-checklist.json и копируется в data/ при первом запуске.
// Чтобы сбросить к исходному — удалите data/checklists/default.json и перезапустите сервер.
if (!store.cloudMode && !store.read('checklists', 'default')) {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'src', 'default-checklist.json'), 'utf8'));
  seed.updated_at = new Date().toISOString();
  store.write('checklists', 'default', seed);
}

// ---------- утилиты HTTP ----------
function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(isStr ? body : JSON.stringify(body));
}
const fail = (res, status, msg) => send(res, status, { error: msg });

function readBody(req, limit = 20 * 1024 * 1024) {
  const parse = (value) => {
    const raw = Buffer.isBuffer(value) ? value.toString('utf8') : value;
    if (raw === undefined || raw === '') return {};
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Object.assign(new Error('Тело запроса должно быть JSON-объектом'), { status: 400 });
    if (Buffer.byteLength(JSON.stringify(parsed)) > limit) throw Object.assign(new Error('Слишком большой запрос'), { status: 413 });
    return parsed;
  };
  // Vercel exposes a lazy parsed body; its stream may already be consumed.
  if ('body' in req) {
    try { return Promise.resolve(parse(req.body)); }
    catch (error) { return Promise.reject(error.status ? error : Object.assign(new Error('Некорректный JSON'), { status: 400 })); }
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (c) => {
      if (tooLarge) return;
      size += c.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        reject(Object.assign(new Error('Слишком большой запрос'), { status: 413 }));
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(parse(raw));
      } catch (e) {
        reject(e.status ? e : Object.assign(new Error('Некорректный JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff' };
function serveStatic(req, res, pathname) {
  let rel;
  try { rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname); }
  catch (_) { return fail(res, 400, 'Некорректный URL'); }
  const file = path.resolve(cfg.PUBLIC_DIR, '.' + rel);
  const relative = path.relative(cfg.PUBLIC_DIR, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return fail(res, 403, 'forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return fail(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// ---------- данные ----------
function normalizeRecords(payload) {
  // принимает ответ API целиком, {records:[...]} или массив
  let records = payload;
  if (payload && payload.data && Array.isArray(payload.data.records)) records = payload.data.records;
  else if (payload && Array.isArray(payload.records)) records = payload.records;
  if (!Array.isArray(records)) throw Object.assign(new Error('Не найден массив records'), { status: 400 });
  const bad = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
  const ids = new Set();
  return records.map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) bad(`Диалог ${i + 1}: ожидается объект`);
    const id = r.conversation_id;
    if (typeof id !== 'string' || !id.trim() || id.length > 200) bad(`Диалог ${i + 1}: нужен исходный строковый conversation_id (1–200 символов)`);
    if (ids.has(id)) bad(`Повторяется conversation_id: ${id}`);
    ids.add(id);
    let tr = r.transcript;
    if (typeof tr === 'string') {
      try { tr = JSON.parse(tr); } catch (_) { tr = [{ timestamp: '', speaker: 'system', text: tr }]; }
    }
    if (!Array.isArray(tr)) bad(`Диалог ${id}: transcript должен быть массивом реплик`);
    const transcript = tr.map((m, j) => {
      if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.text !== 'string') bad(`Диалог ${id}, реплика ${j + 1}: необходим текст text`);
      const speaker = String(m.speaker || '').toLowerCase();
      if (!['operator', 'client', 'bot', 'system'].includes(speaker)) bad(`Диалог ${id}, реплика ${j + 1}: неизвестный speaker`);
      if (m.timestamp != null && typeof m.timestamp !== 'string' && typeof m.timestamp !== 'number') bad(`Диалог ${id}, реплика ${j + 1}: некорректный timestamp`);
      return { timestamp: m.timestamp ?? '', speaker, text: m.text };
    });
    if (r.audio_url != null && typeof r.audio_url !== 'string') bad(`Диалог ${id}: audio_url должен быть строкой`);
    if (r.audio_url) {
      let audio;
      try { audio = new URL(r.audio_url); } catch (_) { bad(`Диалог ${id}: некорректный audio_url`); }
      if (audio.protocol !== 'https:' || audio.username || audio.password) bad(`Диалог ${id}: audio_url должен быть HTTPS без логина и пароля`);
    }
    return {
      conversation_id: id,
      channel: String(r.channel || 'agent chat'),
      language: String(r.language || '').toUpperCase(),
      transcript,
      audio_url: r.audio_url || null,
    };
  });
}

function saveDataset(groupId, records, source) {
  return store.write('datasets', groupId, { group_id: groupId, fetched_at: new Date().toISOString(), source, total_records: records.length, records });
}

async function fetchDataset(groupId) {
  if (!cfg.DATA_API_URL) throw Object.assign(new Error('В .env не задан DATA_API_URL (ссылка GET организаторов)'), { status: 400 });
  const url = new URL(cfg.DATA_API_URL);
  url.searchParams.set('group_id', groupId);
  const r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`API организаторов вернул ${r.status}: ${text.slice(0, 300)}`), { status: 502 });
  const j = JSON.parse(text);
  if (j.isSuccess === false) throw Object.assign(new Error(`API: ${j.error || 'isSuccess=false'}`), { status: 502 });
  const records = normalizeRecords(j);
  return saveDataset(groupId, records, 'api');
}

// audio_url из данных ведёт на HTML-страницу с плеером, а не на файл. Внутри неё — прямая ссылка на MP3,
// которая действует ограниченное время (параметр se), поэтому получаем её при каждом прослушивании.
const AUDIO_CACHE_MS = 10 * 60 * 1000;
const audioCache = new Map();

async function resolveAudio(pageUrl) {
  const hit = audioCache.get(pageUrl);
  if (hit && hit.until > Date.now()) return hit.url;
  const bad = (message) => Object.assign(new Error(message), { status: 502 });
  if (!/^https:\/\//i.test(pageUrl)) throw bad('Ссылка на запись должна начинаться с https://');
  const r = await fetchAudioPage(pageUrl);
  if (!r.ok) throw bad(`Сервис записей ответил ошибкой ${r.status}`);
  let url = pageUrl;
  if (/text\/html/i.test(r.headers.get('content-type') || '')) {
    const m = (await r.text()).match(/<(?:source|audio)\b[^>]*\bsrc="([^"]+)"/i);
    if (!m) throw bad('На странице записи не найден аудиофайл');
    url = m[1].replace(/&amp;/g, '&');
    if (!/^https:\/\//i.test(url)) throw bad('Ссылка на аудиофайл должна начинаться с https://');
    await assertAudioPageUrl(url);
  } else if (r.body) await r.body.cancel();
  const expires = Date.parse(new URL(url).searchParams.get('se'));
  audioCache.set(pageUrl, { url, until: Math.min(Date.now() + AUDIO_CACHE_MS, Number.isNaN(expires) ? Infinity : expires - 60000) });
  return url;
}

function getRecord(groupId, conversationId) {
  const ds = store.read('datasets', groupId);
  if (!ds) return null;
  return ds.records.find((r) => r.conversation_id === conversationId) || null;
}

// ---------- чек-листы ----------
function cleanChecklist(cl) {
  return {
    ...cl,
    rounding: cl.rounding != null ? Number(cl.rounding) : 2,
    sections: (cl.sections || []).filter((s) => s.id && s.name),
    criteria: cl.criteria.map((c) => ({
      id: String(c.id).trim(),
      code: c.code || '',
      section: c.section || null,
      title: String(c.title || '').trim(),
      type: c.type,
      weight: c.type === 'flag' ? 0 : Number(c.weight) || 0,
      na_allowed: !!c.na_allowed && c.type !== 'flag',
      description: String(c.description || ''),
      na_condition: c.na_allowed ? String(c.na_condition || '') : '',
      ...(c.type === 'scale' ? { scale: c.scale.map((s) => ({ value: Number(s.value), description: String(s.description || '') })).sort((a, b) => b.value - a.value) } : {}),
    })),
  };
}

// ---------- пакетная оценка ----------
const jobs = new Map();
/** Готовый результат для того же содержимого диалога, чек-листа и настроек (последний по времени). */
function findCached(record, checklist, groupId) {
  const key = cacheKey(record, checklist);
  return store.list('evaluations').filter((e) => e.group_id === groupId && e.cache_key === key).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] || null;
}

async function runBatch(job, records, checklist, force) {
  let idx = 0;
  const worker = async () => {
    while (idx < records.length && !job.cancelled) {
      const rec = records[idx++];
      const item = job.items[rec.conversation_id];
      if (!force && findCached(rec, checklist, job.group_id)) {
        item.status = 'skipped';
        job.skipped++;
        job.done++;
        continue;
      }
      item.status = 'running';
      const queueMs = Date.now() - job.t0;
      try {
        const ev = await evaluate(rec, checklist, job.group_id, { force, queue_ms: queueMs });
        store.write('evaluations', ev.id, ev);
        job.cost_usd += ev.cost_usd;
        item.status = ev.status === 'needs_review' ? 'needs_review' : 'done';
        item.ms = ev.duration_ms;
      } catch (e) {
        saveEvaluationFailure(rec, checklist, job.group_id, e);
        item.status = 'error';
        item.error = e.message;
        job.errors.push({ conversation_id: rec.conversation_id, error: e.message });
        console.error(`[batch] ${rec.conversation_id}: ${e.message}`);
      }
      job.done++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(cfg.CONCURRENCY, records.length || 1) }, worker));
  for (const it of Object.values(job.items)) if (it.status === 'queued') it.status = 'cancelled';
  job.status = job.cancelled ? 'cancelled' : 'finished';
  job.finished_at = new Date().toISOString();
}

function jobView(job) {
  const counts = {};
  for (const it of Object.values(job.items)) counts[it.status] = (counts[it.status] || 0) + 1;
  const { items, t0, ...rest } = job;
  return { ...rest, counts };
}

function flagStatus(e) {
  const flags = (e.checklist_snapshot.criteria || []).filter((criterion) => criterion.type === 'flag');
  const unknown = flags.some((criterion) => {
    const answer = e.final_criteria[criterion.id];
    return !answer || !['YES', 'NO'].includes(answer.answer) || answer.review_required || (answer.issues || []).length > 0;
  });
  return { gross_error: e.final_result.gross_error, gross_error_unknown: unknown };
}

function evalSummary(e) {
  return {
    id: e.id,
    conversation_id: e.conversation_id,
    group_id: e.group_id,
    channel: e.channel,
    language: e.language,
    checklist: e.checklist,
    created_at: e.created_at,
    provider: e.provider,
    model: e.model,
    original_total: e.original_result.total,
    final_total: e.final_result.total,
    ...flagStatus(e),
    status: e.status || 'ok',
    operator_name: e.operator_name || null,
    appeals_open: e.appeals.filter((a) => a.status === 'open').length,
    appeals_total: e.appeals.length,
    ...evaluationFreshness(e, getRecord(e.group_id, e.conversation_id), store.read('checklists', e.checklist.id)),
  };
}

function evaluationView(evaluation) {
  const snapshot = evaluation.record_snapshot;
  return {
    ...evaluation,
    ...evaluationFreshness(evaluation, getRecord(evaluation.group_id, evaluation.conversation_id), store.read('checklists', evaluation.checklist.id)),
    record_snapshot: snapshot ? { ...snapshot, audio_segments: audioSegments(snapshot) } : null,
  };
}


// ---------- аналитика ----------
/** Порядок оценок одного диалога: новая версия чек-листа, затем настоящая модель вместо демо, затем самая свежая. */
function compareEvals(a, b) {
  return (b.checklist.version - a.checklist.version) || ((a.provider === 'mock') - (b.provider === 'mock')) || b.created_at.localeCompare(a.created_at);
}

/** Действующая оценка каждого диалога по каждому чек-листу. */
function latestEvals(groupId, checklistId) {
  const by = new Map();
  for (const e of store.list('evaluations').sort(compareEvals)) {
    if (groupId && e.group_id !== groupId) continue;
    if (checklistId && e.checklist.id !== checklistId) continue;
    if (evaluationFreshness(e, getRecord(e.group_id, e.conversation_id), store.read('checklists', e.checklist.id)).stale) continue;
    const key = JSON.stringify([e.group_id, e.conversation_id, e.checklist.id]);
    if (!by.has(key)) by.set(key, e);
  }
  return [...by.values()];
}

function analytics(groupId, checklistId) {
  const evs = latestEvals(groupId, checklistId);
  const scored = evs.filter((e) => e.final_result.total != null);
  const avg = (arr) => (arr.length ? Math.round((arr.reduce((s, x) => s + x, 0) / arr.length) * 100) / 100 : null);
  const cl = evs[0] ? store.read('checklists', evs[0].checklist.id) || evs[0].checklist_snapshot : store.read('checklists', checklistId || 'default');
  const crits = (cl ? cl.criteria : []).filter((c) => c.type !== 'flag');
  const langs = [...new Set(evs.map((e) => e.language || '—'))].sort();

  // доля выполнения критерия = набранные / максимальные баллы среди применимых
  const critStat = (list, cid) => {
    let got = 0, max = 0, applicable = 0, na = 0, invalid = 0;
    for (const e of list) {
      const r = e.final_result.criteria.find((x) => x.id === cid);
      if (!r) continue;
      if (!r.scored) {
        if (r.answer === 'NA') na++;
        if (r.answer === 'INVALID') invalid++;
        continue;
      }
      applicable++; got += r.raw; max += r.weight;
    }
    return { applicable, na, invalid, rate: max > 0 ? Math.round((got / max) * 1000) / 10 : null };
  };
  const criteria = crits.map((c) => ({
    id: c.id, code: c.code, title: c.title,
    ...critStat(evs, c.id),
    by_language: Object.fromEntries(langs.map((l) => [l, critStat(evs.filter((e) => (e.language || '—') === l), c.id).rate])),
  }));

  const buckets = [[0, 50], [50, 60], [60, 70], [70, 80], [80, 90], [90, 100.01]].map(([a, b]) => ({ from: a, to: Math.min(b, 100), count: scored.filter((e) => e.final_result.total >= a && e.final_result.total < b).length }));

  const ops = new Map();
  for (const e of evs) {
    const name = e.operator_name || 'Не представился';
    if (!ops.has(name)) ops.set(name, []);
    ops.get(name).push(e);
  }
  const operators = [...ops.entries()].map(([name, list]) => {
    const sc = list.filter((e) => e.final_result.total != null).map((e) => e.final_result.total);
    const weak = crits.map((c) => ({ c, s: critStat(list, c.id) })).filter((x) => x.s.rate != null).sort((a, b) => a.s.rate - b.s.rate)[0];
    return {
      name, unnamed: !list[0].operator_name, dialogs: list.length, avg: avg(sc), min: sc.length ? Math.min(...sc) : null,
      gross: list.filter((e) => e.final_result.gross_error).length,
      gross_unknown: list.filter((e) => flagStatus(e).gross_error_unknown).length,
      languages: [...new Set(list.map((e) => e.language))],
      weakest: weak && weak.s.rate < 100 ? { title: weak.c.title, rate: weak.s.rate } : null,
      criteria: crits.map((c) => ({ id: c.id, code: c.code, title: c.title, ...critStat(list, c.id) })),
      coaching: list.flatMap((e) => (e.coaching || []).filter((x) => x.type === 'required').map((x) => ({ text: x.text, criterion_id: x.criterion_id, conversation_id: e.conversation_id }))).slice(0, 6),
      conversations: list.map((e) => ({ id: e.conversation_id, total: e.final_result.total, eval_id: e.id, language: e.language, channel: e.channel, gross: !!e.final_result.gross_error, gross_unknown: flagStatus(e).gross_error_unknown })),
    };
  }).sort((a, b) => (a.unnamed - b.unnamed) || (b.avg ?? -1) - (a.avg ?? -1) || a.gross - b.gross);

  const groupAvg = (key) => Object.fromEntries([...new Set(evs.map((e) => e[key] || '—'))].map((k) => [k, { avg: avg(scored.filter((e) => (e[key] || '—') === k).map((e) => e.final_result.total)), n: evs.filter((e) => (e[key] || '—') === k).length }]));

  const orderedTotals = scored.map((e) => e.final_result.total).sort((a, b) => a - b);
  const middle = Math.floor(orderedTotals.length / 2);
  const median = orderedTotals.length ? (orderedTotals.length % 2 ? orderedTotals[middle] : (orderedTotals[middle - 1] + orderedTotals[middle]) / 2) : null;
  return {
    group_id: groupId, checklist: cl ? { id: cl.id, name: cl.name, version: cl.version } : null,
    evaluated: evs.length, avg: avg(scored.map((e) => e.final_result.total)),
    models: [...new Set(evs.map((e) => `${e.provider} / ${e.model}`))],
    demo_count: evs.filter((e) => e.provider === 'mock').length,
    median: median == null ? null : Math.round(median * 100) / 100,
    gross_count: evs.filter((e) => e.final_result.gross_error).length,
    gross_unknown_count: evs.filter((e) => flagStatus(e).gross_error_unknown).length,
    appeals_open: evs.reduce((s, e) => s + e.appeals.filter((a) => a.status === 'open').length, 0),
    appeals_total: evs.reduce((s, e) => s + e.appeals.length, 0),
    changed_by_appeal: evs.filter((e) => e.final_result.total !== e.original_result.total).length,
    cost_usd: Math.round(evs.reduce((s, e) => s + (e.cost_usd || 0), 0) * 10000) / 10000,
    low_confidence: evs.reduce((s, e) => s + Object.values(e.final_criteria).filter((c) => c.agreement && c.agreement.runs > 1 && c.agreement.agree < c.agreement.runs).length, 0),
    languages: langs, by_language: groupAvg('language'), by_channel: groupAvg('channel'),
    distribution: buckets, criteria, operators,
    gross: evs.filter((e) => e.final_result.gross_error).map((e) => ({ conversation_id: e.conversation_id, eval_id: e.id, operator: e.operator_name, explanation: (e.final_criteria[e.final_result.gross_error_criteria[0]] || {}).explanation })),
    worst: scored.slice().sort((a, b) => a.final_result.total - b.final_result.total).slice(0, 5).map((e) => ({ conversation_id: e.conversation_id, eval_id: e.id, total: e.final_result.total, operator: e.operator_name, summary: e.summary })),
  };
}

// ---------- роутер ----------
async function handleApi(req, res, url) {
  let p;
  try { p = url.pathname.replace(/^\/api/, '').split('/').filter(Boolean).map(decodeURIComponent); }
  catch (_) { return fail(res, 400, 'Некорректный URL'); }
  const m = req.method;
  const q = Object.fromEntries(url.searchParams);

  if (p[0] === 'workspace' && p[1] === 'import' && p.length === 2 && m === 'POST') {
    if (!store.cloudMode) return fail(res, 404, 'Перенос рабочего пространства доступен в облачной версии');
    const { importEntries } = require('./src/workspace-transfer');
    return send(res, 200, importEntries(await readBody(req, 1024 * 1024)));
  }

  if (p[0] === 'readiness' && p.length === 1 && m === 'GET') return send(res, 200, getReadiness(), { 'Cache-Control': 'no-store' });
  if (p[0] === 'benchmark' && p[1] === 'report' && p.length === 2 && m === 'GET') {
    const status = inspectBenchmark();
    if (status.state === 'not_run') return fail(res, 404, status.message);
    if (status.state === 'blocked') return fail(res, 422, status.message);
    return send(res, 200, fs.readFileSync(benchmarkReportPath()), { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="benchmark-report.json"', 'Cache-Control': 'no-store' });
  }
  if (p[0] === 'demo-guide' && p.length === 1 && m === 'GET') {
    return send(res, 200, fs.readFileSync(path.join(cfg.ROOT, 'docs', 'DEMO_SCRIPT.md')), { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="Midnight-Commit-demo.md"' });
  }

  // /api/config
  // /api/audio/:group/:conversation — перенаправляет встроенный плеер на актуальный аудиофайл
  if (p[0] === 'audio' && p.length === 3 && m === 'GET') {
    const rec = getRecord(p[1], p[2]);
    if (!rec || !rec.audio_url) return fail(res, 404, 'Запись не найдена');
    const target = await resolveAudio(rec.audio_url);
    res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' });
    return res.end();
  }

  if (p[0] === 'config' && m === 'GET') {
    return send(res, 200, { provider: cfg.provider, model: cfg.model, data_api_configured: !!cfg.DATA_API_URL, concurrency: cfg.CONCURRENCY, timeout_ms: cfg.LLM_TIMEOUT_MS, max_attempts: cfg.LLM_MAX_ATTEMPTS, repair_attempts: cfg.REPAIR_ATTEMPTS, thinking_level: cfg.GEMINI_THINKING_LEVEL || null, temperature: cfg.TEMPERATURE, samples: cfg.provider === 'mock' ? 1 : cfg.SAMPLES, price_in_per_m: cfg.PRICE_IN_PER_M, price_out_per_m: cfg.PRICE_OUT_PER_M });
  }

  // /api/datasets
  if (p[0] === 'datasets') {
    if (p.length === 1 && m === 'GET') {
      return send(res, 200, store.list('datasets').map((d) => ({ group_id: d.group_id, total_records: d.total_records, fetched_at: d.fetched_at, source: d.source })));
    }
    if (p[1] === 'fetch' && m === 'POST') {
      const b = await readBody(req);
      const gid = String(b.group_id || 'DEV').trim();
      if (!gid) return fail(res, 400, 'Укажите непустой group_id');
      const ds = await fetchDataset(gid);
      return send(res, 200, { group_id: gid, total_records: ds.total_records });
    }
    if (p[1] === 'upload' && m === 'POST') {
      const b = await readBody(req);
      const gid = String(b.group_id || 'UPLOAD').trim();
      if (!gid) return fail(res, 400, 'Укажите непустой group_id');
      const records = normalizeRecords(b.payload);
      // дополняем существующий набор, если загружаем по одному диалогу
      const ds = store.read('datasets', gid);
      const map = new Map((ds ? ds.records : []).map((r) => [r.conversation_id, r]));
      for (const r of records) map.set(r.conversation_id, r);
      const saved = saveDataset(gid, [...map.values()], 'upload');
      return send(res, 200, { group_id: gid, total_records: saved.total_records });
    }
    if (p.length === 2 && m === 'GET') {
      const ds = store.read('datasets', p[1]);
      if (!ds) return fail(res, 404, 'Набор не найден');
      const evs = store.list('evaluations').filter((e) => e.group_id === p[1]).sort(compareEvals);
      return send(res, 200, {
        group_id: ds.group_id,
        fetched_at: ds.fetched_at,
        records: ds.records.map((r) => ({
          conversation_id: r.conversation_id,
          channel: r.channel,
          language: r.language,
          messages: r.transcript.length,
          has_audio: !!r.audio_url,
          evaluations: evs.filter((e) => e.conversation_id === r.conversation_id).map(evalSummary),
        })),
      });
    }
    if (p.length === 3 && m === 'GET') {
      const r = getRecord(p[1], p[2]);
      return r ? send(res, 200, { ...r, audio_segments: audioSegments(r) }) : fail(res, 404, 'Диалог не найден');
    }
    if (p.length === 2 && m === 'DELETE') {
      store.remove('datasets', p[1]);
      return send(res, 200, { ok: true });
    }
  }

  // /api/checklists
  if (p[0] === 'checklists') {
    if (p.length === 1 && m === 'GET') return send(res, 200, store.list('checklists').map((c) => ({ id: c.id, name: c.name, version: c.version, updated_at: c.updated_at, criteria: c.criteria.length })));
    if (p.length === 1 && m === 'POST') {
      const b = await readBody(req);
      const errs = validateChecklist(b);
      if (errs.length) return fail(res, 400, errs.join('; '));
      const cl = cleanChecklist(b);
      cl.id = store.newId('cl');
      cl.version = 1;
      cl.updated_at = new Date().toISOString();
      return send(res, 201, store.write('checklists', cl.id, cl));
    }
    if (p.length === 2 && m === 'GET') {
      const cl = store.read('checklists', p[1]);
      return cl ? send(res, 200, cl) : fail(res, 404, 'Чек-лист не найден');
    }
    if (p.length === 2 && m === 'PUT') {
      const b = await readBody(req);
      const prev = store.read('checklists', p[1]);
      if (!prev) return fail(res, 404, 'Чек-лист не найден');
      const errs = validateChecklist(b);
      if (errs.length) return fail(res, 400, errs.join('; '));
      const cl = cleanChecklist(b);
      cl.id = prev.id;
      cl.version = (prev.version || 1) + 1;
      cl.updated_at = new Date().toISOString();
      cl.history = [...(prev.history || []), { version: prev.version, updated_at: prev.updated_at, criteria: prev.criteria.map((c) => c.id + ':' + c.title) }].slice(-20);
      return send(res, 200, store.write('checklists', cl.id, cl));
    }
    if (p.length === 2 && m === 'DELETE') {
      if (p[1] === 'default') return fail(res, 400, 'Чек-лист по умолчанию удалить нельзя');
      store.remove('checklists', p[1]);
      return send(res, 200, { ok: true });
    }
  }

  // /api/evaluate — один диалог. Без force возвращает готовый результат для того же содержимого
  // (диалог + содержимое/версия чек-листа + модель/настройки + версия инструкций). force=true — новая оценка.
  if (p[0] === 'evaluate' && m === 'POST') {
    const b = await readBody(req);
    const rec = getRecord(b.group_id, b.conversation_id);
    if (!rec) return fail(res, 404, 'Диалог не найден — сначала загрузите набор');
    const cl = store.read('checklists', b.checklist_id || 'default');
    if (!cl) return fail(res, 404, 'Чек-лист не найден');
    if (!b.force) {
      const cached = findCached(rec, cl, b.group_id);
      if (cached) return send(res, 200, { ...cached, cached: true });
    }
    let ev;
    try { ev = await evaluate(rec, cl, b.group_id, { force: !!b.force }); }
    catch (error) { saveEvaluationFailure(rec, cl, b.group_id, error); throw error; }
    store.write('evaluations', ev.id, ev);
    return send(res, 200, ev);
  }

  // /api/batch — пакетная оценка набора
  if (p[0] === 'batch') {
    if (store.cloudMode) {
      const batch = require('./src/cloud-batch');
      if (p.length === 1 && m === 'POST') return send(res, 202, batch.createBatch(await readBody(req)));
      if (p.length === 2 && m === 'GET') return send(res, 200, batch.getBatch(p[1]));
      if (p.length === 3 && p[2] === 'step' && m === 'POST') return send(res, 200, await batch.stepBatch(p[1]));
      if (p.length === 3 && p[2] === 'cancel' && m === 'POST') return send(res, 200, batch.cancelBatch(p[1]));
      return fail(res, 404, 'Неизвестный маршрут пакетной задачи');
    }
    if (p.length === 1 && m === 'POST') {
      const b = await readBody(req);
      const ds = store.read('datasets', b.group_id);
      if (!ds) return fail(res, 404, 'Набор не найден');
      const cl = store.read('checklists', b.checklist_id || 'default');
      if (!cl) return fail(res, 404, 'Чек-лист не найден');
      let records = ds.records;
      if (b.conversation_ids !== undefined) {
        if (!Array.isArray(b.conversation_ids) || !b.conversation_ids.length || b.conversation_ids.some((id) => typeof id !== 'string' || !id.trim())) return fail(res, 400, 'conversation_ids должен содержать непустой список ID выбранных диалогов');
        const selected = new Set(b.conversation_ids);
        if (selected.size !== b.conversation_ids.length || b.conversation_ids.some((id) => !ds.records.some((record) => record.conversation_id === id))) return fail(res, 400, 'В conversation_ids есть повторяющиеся или неизвестные ID');
        records = records.filter((record) => selected.has(record.conversation_id));
      }
      const job = { id: store.newId('job'), group_id: b.group_id, checklist_id: cl.id, checklist_version: cl.version, total: records.length, done: 0, skipped: 0, errors: [], cost_usd: 0, status: 'running', started_at: new Date().toISOString(), t0: Date.now(), items: Object.fromEntries(records.map((r) => [r.conversation_id, { status: 'queued' }])) };
      jobs.set(job.id, job);
      runBatch(job, records, cl, !!b.force).catch((e) => {
        job.status = 'failed';
        job.errors.push({ error: e.message });
      });
      return send(res, 202, jobView(job));
    }
    if (p.length === 2 && m === 'GET') {
      const job = jobs.get(p[1]);
      return job ? send(res, 200, jobView(job)) : fail(res, 404, 'Задача не найдена');
    }
    if (p.length === 3 && p[2] === 'cancel' && m === 'POST') {
      const job = jobs.get(p[1]);
      if (!job) return fail(res, 404, 'Задача не найдена');
      job.cancelled = true;
      return send(res, 200, { ok: true });
    }
  }

  // /api/evaluations
  if (p[0] === 'evaluations') {
    if (p.length === 1 && m === 'GET') {
      let evs = store.list('evaluations');
      if (q.group_id) evs = evs.filter((e) => e.group_id === q.group_id);
      if (q.checklist_id) evs = evs.filter((e) => e.checklist.id === q.checklist_id);
      return send(res, 200, evs.sort(compareEvals).map(evalSummary));
    }
    // Очистка результата одной строки: все оценки диалога по чек-листу вместе с их апелляциями. Сам диалог остаётся.
    if (p.length === 1 && m === 'DELETE') {
      if (!q.group_id || !q.conversation_id || !q.checklist_id) return fail(res, 400, 'Укажите group_id, conversation_id и checklist_id');
      const evs = store.list('evaluations').filter((e) => e.group_id === q.group_id && e.conversation_id === q.conversation_id && e.checklist.id === q.checklist_id);
      for (const e of evs) store.remove('evaluations', e.id);
      return send(res, 200, { removed: evs.length, appeals: evs.reduce((s, e) => s + e.appeals.length, 0) });
    }
    let ev = p[1] ? store.read('evaluations', p[1]) : null;
    if (p.length === 2 && m === 'GET') {
      if (!ev) return fail(res, 404, 'Оценка не найдена');
      return send(res, 200, evaluationView(ev));
    }
    if (!ev) return fail(res, 404, 'Оценка не найдена');

    // подать апелляцию
    if (p[2] === 'appeals' && p.length === 3 && m === 'POST') {
      const b = await readBody(req);
      ev = store.read('evaluations', p[1]);
      if (!ev) return fail(res, 404, 'Оценка не найдена');
      const c = ev.checklist_snapshot.criteria.find((x) => x.id === b.criterion_id);
      if (!c) return fail(res, 400, 'Критерий не найден');
      if (!String(b.comment || '').trim()) return fail(res, 400, 'Добавьте комментарий');
      if (ev.appeals.some((a) => a.criterion_id === c.id && a.status === 'open')) return fail(res, 400, 'По этому критерию уже есть открытая апелляция');
      const cur = ev.final_criteria[c.id];
      const row = ev.final_result.criteria.find((r) => r.id === c.id);
      const ap = {
        id: store.newId('ap'),
        criterion_id: c.id,
        criterion_title: c.title,
        comment: String(b.comment).trim(),
        author: b.author || 'Пользователь',
        created_at: new Date().toISOString(),
        status: 'open',
        disputed: { answer: cur.answer, value: cur.value, points: row ? row.points : null, explanation: cur.explanation, evidence: cur.evidence, missing_range: cur.missing_range || null, checked_range: cur.checked_range || null, na_reason: cur.na_reason || null },
        decision: null,
      };
      ev.appeals.push(ap);
      store.write('evaluations', ev.id, ev);
      return send(res, 201, evaluationView(ev));
    }

    // решение проверяющего
    if (p[2] === 'appeals' && p.length === 5 && p[4] === 'decision' && m === 'POST') {
      const b = await readBody(req);
      ev = store.read('evaluations', p[1]);
      if (!ev) return fail(res, 404, 'Оценка не найдена');
      const ap = ev.appeals.find((a) => a.id === p[3]);
      if (!ap) return fail(res, 404, 'Апелляция не найдена');
      if (ap.status !== 'open') return fail(res, 400, 'Апелляция уже рассмотрена');
      if (!['confirm', 'change'].includes(b.action)) return fail(res, 400, 'action должен быть confirm или change');
      if (!String(b.reason || '').trim()) return fail(res, 400, 'Укажите причину решения');
      const totalBefore = ev.final_result.total;
      let checked = { answer: null, value: null };
      const c = ev.checklist_snapshot.criteria.find((x) => x.id === ap.criterion_id);
      if (b.action === 'change') {
        try {
          checked = validateAnswer(c, { answer: b.answer, value: b.value });
        } catch (e) {
          if (e instanceof AnswerError) return fail(res, 400, e.message);
          throw e;
        }
      }
      ap.decision = { action: b.action, answer: checked.answer, value: checked.value, reason: String(b.reason).trim(), reviewer: b.reviewer || 'Проверяющий', decided_at: new Date().toISOString() };
      ap.status = 'resolved';
      recompute(ev);
      ap.decision.total_before = totalBefore;
      ap.decision.total_after = ev.final_result.total;
      store.write('evaluations', ev.id, ev);
      return send(res, 200, evaluationView(ev));
    }
    if (p.length === 2 && m === 'DELETE') {
      store.remove('evaluations', ev.id);
      return send(res, 200, { ok: true });
    }
  }

  // /api/analytics — дашборд
  if (p[0] === 'analytics' && m === 'GET') return send(res, 200, analytics(q.group_id, q.checklist_id));

  // /api/appeals — очередь проверяющего
  if (p[0] === 'appeals' && m === 'GET') {
    const out = [];
    for (const e of store.list('evaluations')) {
      for (const a of e.appeals) {
        if (q.status && a.status !== q.status) continue;
        out.push({ ...a, evaluation_id: e.id, conversation_id: e.conversation_id, group_id: e.group_id, checklist: e.checklist, final_total: e.final_result.total, original_total: e.original_result.total });
      }
    }
    out.sort((a, b) => (a.status === b.status ? b.created_at.localeCompare(a.created_at) : a.status === 'open' ? -1 : 1));
    return send(res, 200, out);
  }

  // Official submission format (Appendix, JSON 1.0). The original source controls coverage.
  if (p[0] === 'export.json' && p.length === 1 && m === 'GET') {
    if (!q.group_id) return fail(res, 400, 'Укажите group_id');
    const dataset = store.read('datasets', q.group_id);
    const checklist = store.read('checklists', q.checklist_id || 'default');
    if (!dataset || !checklist) return fail(res, 404, 'Набор или чек-лист не найден');
    const output = buildSubmission({ dataset, checklist, evaluations: [...store.list('evaluations'), ...store.list('failures')], teamName: q.team_name, split: q.split });
    return send(res, 200, JSON.stringify(output, null, 2), { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="results.json"', 'Cache-Control': 'no-store' });
  }

  // /api/export.csv — выгрузка итогов
  if (p[0] === 'export.csv' && m === 'GET') {
    const evs = latestEvals(q.group_id, q.checklist_id);
    const critIds = [...new Set(evs.flatMap((e) => e.checklist_snapshot.criteria.map((c) => c.id)))];
    const esc = (v) => {
      const value = String(v ?? '');
      // Кавычки CSV не защищают от формул при открытии файла в Excel.
      const safe = /^[\s\u0000-\u001f]*[=+@-]/.test(value) ? "'" + value : value;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const head = ['conversation_id', 'group_id', 'channel', 'language', 'checklist', 'version', 'original_total', 'final_total', 'gross_error', 'status', ...critIds];
    const lines = [head.join(',')];
    for (const e of evs) {
      const ans = critIds.map((id) => {
        const c = e.final_criteria[id];
        const r = e.final_result.criteria.find((x) => x.id === id);
        if (!c) return '';
        return c.answer === 'SCORE' ? `${c.value} (${r?.points})` : `${c.answer}${r && r.points != null ? ' (' + r.points + ')' : ''}`;
      });
      const gross = flagStatus(e).gross_error_unknown ? 'UNKNOWN' : e.final_result.gross_error ? 'YES' : 'NO';
      lines.push([e.conversation_id, e.group_id, e.channel, e.language, e.checklist.name, e.checklist.version, e.original_result.total, e.final_result.total, gross, e.status || 'ok', ...ans].map(esc).join(','));
    }
    return send(res, 200, '﻿' + lines.join('\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="cqa-results.csv"' });
  }

  return fail(res, 404, 'Неизвестный маршрут API');
}

async function dispatch(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    // Local-only service must not be exposed through an attacker-controlled DNS name.
    if (!store.cloudMode && ['127.0.0.1', 'localhost', '::1'].includes(cfg.HOST)) {
      let hostname;
      try { hostname = new URL('http://' + req.headers.host).hostname.toLowerCase().replace(/\.$/, ''); }
      catch (_) { return fail(res, 400, 'Некорректный Host'); }
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) return fail(res, 421, 'Для локального приложения используйте localhost или 127.0.0.1');
    }
    const origin = req.headers.origin;
    if (origin) {
      const sameOrigin = isSameOrigin(req, origin, store.cloudMode);
      if (!sameOrigin && !cfg.CORS_ORIGINS.includes(origin)) return fail(res, 403, 'Этот источник не разрешён. Для встраивания настройте CORS_ORIGINS.');
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return send(res, 204, '', { 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    // Ошибки входных данных ожидаемы; не засоряем журнал их stack trace.
    if (!e.status || e.status >= 500) console.error(e);
    const st = Number.isInteger(e.status) && e.status >= 400 && e.status < 600 ? e.status : e.status ? 502 : 500;
    return fail(res, st, e.message || 'Ошибка сервера');
  }
}

async function handler(req, res) {
  if (!authorize(req, res, cfg)) return;
  // Static assets need no workspace transaction; they still require authorization.
  if (!store.cloudMode || !req.url.split('?')[0].startsWith('/api/')) return dispatch(req, res);
  const response = new HttpBuffer();
  try {
    const { withCloudStore } = require('./src/cloud-store');
    await withCloudStore({ readOnly: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) }, () => dispatch(req, response));
    response.flush(res);
  } catch (error) {
    // Connection strings and database diagnostics must stay out of the HTTP body.
    const status = error.status === 409 ? 409 : 503;
    return fail(res, status, error.publicMessage || 'Хранилище временно недоступно. Повторите запрос.');
  }
}

const server = http.createServer(handler);

if (require.main === module) {
  server.listen(cfg.PORT, cfg.HOST, () => {
    console.log(`CQA запущен: http://localhost:${cfg.PORT}`);
    console.log(`ИИ: ${cfg.provider} / ${cfg.model}${cfg.provider === 'mock' ? '  (ДЕМО без ключа — задайте ключ в .env)' : ''}`);
    console.log(`API данных: ${cfg.DATA_API_URL ? 'настроен' : 'НЕ настроен (DATA_API_URL в .env)'}`);
  });
}

module.exports = { server, handler, normalizeRecords, readBody };

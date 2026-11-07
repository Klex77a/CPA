'use strict';
/**
 * CQA — Conversation Quality Analytics (прототип для хакатона Freedom Broker).
 * Запуск: node server.js  → http://localhost:3000
 * Зависимостей нет: нужен только Node.js 18+.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./src/config');
const store = require('./src/store');
const { evaluate, recompute, cacheKey } = require('./src/evaluator');
const { audioSegments } = require('./src/audio-offsets');
const { validateChecklist, validateAnswer, AnswerError } = require('./src/scoring');

// ---------- начальный чек-лист ----------
// Исходный чек-лист из PDF лежит в src/default-checklist.json и копируется в data/ при первом запуске.
// Чтобы сбросить к исходному — удалите data/checklists/default.json и перезапустите сервер.
if (!store.read('checklists', 'default')) {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'src', 'default-checklist.json'), 'utf8'));
  seed.updated_at = new Date().toISOString();
  store.write('checklists', 'default', seed);
}

// ---------- утилиты HTTP ----------
function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(isStr ? body : JSON.stringify(body));
}
const fail = (res, status, msg) => send(res, status, { error: msg });

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Слишком большой запрос'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(Object.assign(new Error('Некорректный JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const file = path.normalize(path.join(cfg.PUBLIC_DIR, rel));
  if (!file.startsWith(cfg.PUBLIC_DIR)) return fail(res, 403, 'forbidden');
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
  return records.map((r, i) => {
    let tr = r.transcript;
    if (typeof tr === 'string') {
      try { tr = JSON.parse(tr); } catch (_) { tr = [{ timestamp: '', speaker: 'system', text: tr }]; }
    }
    return {
      conversation_id: String(r.conversation_id || `conv-${i + 1}`),
      channel: r.channel || 'agent chat',
      language: r.language || '',
      transcript: (tr || []).map((m) => ({ timestamp: m.timestamp ?? '', speaker: String(m.speaker || '').toLowerCase(), text: m.text ?? '' })),
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
  const r = await fetch(url, { method: 'GET' });
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
  const r = await fetch(pageUrl, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw bad(`Сервис записей ответил ошибкой ${r.status}`);
  let url = pageUrl;
  if (/text\/html/i.test(r.headers.get('content-type') || '')) {
    const m = (await r.text()).match(/<(?:source|audio)\b[^>]*\bsrc="([^"]+)"/i);
    if (!m) throw bad('На странице записи не найден аудиофайл');
    url = m[1].replace(/&amp;/g, '&');
    if (!/^https:\/\//i.test(url)) throw bad('Ссылка на аудиофайл должна начинаться с https://');
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
function findCached(record, checklist) {
  const key = cacheKey(record, checklist);
  return store.list('evaluations').filter((e) => e.cache_key === key).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] || null;
}

async function runBatch(job, records, checklist, force) {
  let idx = 0;
  const worker = async () => {
    while (idx < records.length && !job.cancelled) {
      const rec = records[idx++];
      const item = job.items[rec.conversation_id];
      if (!force && findCached(rec, checklist)) {
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
    gross_error: e.final_result.gross_error,
    status: e.status || 'ok',
    operator_name: e.operator_name || null,
    appeals_open: e.appeals.filter((a) => a.status === 'open').length,
    appeals_total: e.appeals.length,
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
    const key = `${e.group_id}|${e.conversation_id}|${e.checklist.id}`;
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
    let got = 0, max = 0, applicable = 0, na = 0;
    for (const e of list) {
      const r = e.final_result.criteria.find((x) => x.id === cid);
      if (!r) continue;
      if (!r.scored) { na++; continue; }
      applicable++; got += r.raw; max += r.weight;
    }
    return { applicable, na, rate: max > 0 ? Math.round((got / max) * 1000) / 10 : null };
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
      languages: [...new Set(list.map((e) => e.language))],
      weakest: weak && weak.s.rate < 100 ? { title: weak.c.title, rate: weak.s.rate } : null,
      criteria: crits.map((c) => ({ id: c.id, code: c.code, title: c.title, ...critStat(list, c.id) })),
      coaching: list.flatMap((e) => (e.coaching || []).filter((x) => x.type === 'required').map((x) => ({ text: x.text, criterion_id: x.criterion_id, conversation_id: e.conversation_id }))).slice(0, 6),
      conversations: list.map((e) => ({ id: e.conversation_id, total: e.final_result.total, eval_id: e.id, language: e.language, channel: e.channel, gross: !!e.final_result.gross_error })),
    };
  }).sort((a, b) => (a.unnamed - b.unnamed) || (b.avg ?? -1) - (a.avg ?? -1) || a.gross - b.gross);

  const groupAvg = (key) => Object.fromEntries([...new Set(evs.map((e) => e[key] || '—'))].map((k) => [k, { avg: avg(scored.filter((e) => (e[key] || '—') === k).map((e) => e.final_result.total)), n: evs.filter((e) => (e[key] || '—') === k).length }]));

  return {
    group_id: groupId, checklist: cl ? { id: cl.id, name: cl.name, version: cl.version } : null,
    evaluated: evs.length, avg: avg(scored.map((e) => e.final_result.total)),
    models: [...new Set(evs.map((e) => `${e.provider} / ${e.model}`))],
    demo_count: evs.filter((e) => e.provider === 'mock').length,
    median: scored.length ? scored.map((e) => e.final_result.total).sort((a, b) => a - b)[Math.floor((scored.length - 1) / 2)] : null,
    gross_count: evs.filter((e) => e.final_result.gross_error).length,
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
  const p = url.pathname.replace(/^\/api/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const m = req.method;
  const q = Object.fromEntries(url.searchParams);

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
      const ds = await fetchDataset(gid);
      return send(res, 200, { group_id: gid, total_records: ds.total_records });
    }
    if (p[1] === 'upload' && m === 'POST') {
      const b = await readBody(req);
      const gid = String(b.group_id || 'UPLOAD').trim();
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
      const prev = store.read('checklists', p[1]);
      if (!prev) return fail(res, 404, 'Чек-лист не найден');
      const b = await readBody(req);
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
      const cached = findCached(rec, cl);
      if (cached) return send(res, 200, { ...cached, cached: true });
    }
    const ev = await evaluate(rec, cl, b.group_id, { force: !!b.force });
    store.write('evaluations', ev.id, ev);
    return send(res, 200, ev);
  }

  // /api/batch — пакетная оценка набора
  if (p[0] === 'batch') {
    if (p.length === 1 && m === 'POST') {
      const b = await readBody(req);
      const ds = store.read('datasets', b.group_id);
      if (!ds) return fail(res, 404, 'Набор не найден');
      const cl = store.read('checklists', b.checklist_id || 'default');
      if (!cl) return fail(res, 404, 'Чек-лист не найден');
      let records = ds.records;
      if (Array.isArray(b.conversation_ids) && b.conversation_ids.length) records = records.filter((r) => b.conversation_ids.includes(r.conversation_id));
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
      if (job) job.cancelled = true;
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
    const ev = p[1] ? store.read('evaluations', p[1]) : null;
    if (p.length === 2 && m === 'GET') return ev ? send(res, 200, ev) : fail(res, 404, 'Оценка не найдена');
    if (!ev) return fail(res, 404, 'Оценка не найдена');

    // подать апелляцию
    if (p[2] === 'appeals' && p.length === 3 && m === 'POST') {
      const b = await readBody(req);
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
      return send(res, 201, ev);
    }

    // решение проверяющего
    if (p[2] === 'appeals' && p.length === 5 && p[4] === 'decision' && m === 'POST') {
      const ap = ev.appeals.find((a) => a.id === p[3]);
      if (!ap) return fail(res, 404, 'Апелляция не найдена');
      if (ap.status !== 'open') return fail(res, 400, 'Апелляция уже рассмотрена');
      const b = await readBody(req);
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
      return send(res, 200, ev);
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

  // /api/export.csv — выгрузка итогов
  if (p[0] === 'export.csv' && m === 'GET') {
    const evs = latestEvals(q.group_id, q.checklist_id);
    const critIds = [...new Set(evs.flatMap((e) => e.checklist_snapshot.criteria.map((c) => c.id)))];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['conversation_id', 'group_id', 'channel', 'language', 'checklist', 'version', 'original_total', 'final_total', 'gross_error', ...critIds];
    const lines = [head.join(',')];
    for (const e of evs) {
      const ans = critIds.map((id) => {
        const c = e.final_criteria[id];
        const r = e.final_result.criteria.find((x) => x.id === id);
        if (!c) return '';
        return c.answer === 'SCORE' ? `${c.value} (${r?.points})` : `${c.answer}${r && r.points != null ? ' (' + r.points + ')' : ''}`;
      });
      lines.push([e.conversation_id, e.group_id, e.channel, e.language, e.checklist.name, e.checklist.version, e.original_result.total, e.final_result.total, e.final_result.gross_error ? 'YES' : 'NO', ...ans].map(esc).join(','));
    }
    return send(res, 200, '﻿' + lines.join('\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="cqa-results.csv"' });
  }

  return fail(res, 404, 'Неизвестный маршрут API');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') return send(res, 204, '', { 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error(e);
    const st = Number.isInteger(e.status) && e.status >= 400 && e.status < 600 ? e.status : e.status ? 502 : 500;
    return fail(res, st, e.message || 'Ошибка сервера');
  }
});

if (require.main === module) {
  server.listen(cfg.PORT, () => {
    console.log(`CQA запущен: http://localhost:${cfg.PORT}`);
    console.log(`ИИ: ${cfg.provider} / ${cfg.model}${cfg.provider === 'mock' ? '  (ДЕМО без ключа — задайте ключ в .env)' : ''}`);
    console.log(`API данных: ${cfg.DATA_API_URL ? 'настроен' : 'НЕ настроен (DATA_API_URL в .env)'}`);
  });
}

module.exports = { server, normalizeRecords };

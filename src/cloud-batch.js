'use strict';
/** Durable, request-driven batches. Each step runs inside the cloud store's
 * mutation transaction; there is no work left running after the HTTP response.
 */
const crypto = require('node:crypto');
const clone = (value) => JSON.parse(JSON.stringify(value));
const problem = (message, status = 400) => Object.assign(new Error(message), { status });
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const sourceKey = (record) => crypto.createHash('sha256').update(JSON.stringify({ id: record.conversation_id, channel: record.channel, language: record.language, transcript: record.transcript })).digest('hex');

function createCloudBatch(dependencies = {}) {
  const store = dependencies.store || require('./store');
  const evaluator = dependencies.evaluate && dependencies.cacheKey ? null : require('./evaluator');
  const evaluate = dependencies.evaluate || evaluator.evaluate;
  const cacheKey = dependencies.cacheKey || evaluator.cacheKey;
  const failure = require('./evaluation-failure');
  const saveFailure = dependencies.saveEvaluationFailure || failure.saveEvaluationFailure;
  const safeFailureMessage = dependencies.safeFailureMessage || failure.safeFailureMessage;
  const now = dependencies.now || Date.now;

  function readJob(id) {
    if (typeof id !== 'string' || !id) throw problem('Укажите ID задачи');
    const job = store.read('jobs', id);
    if (!job) throw problem('Задача не найдена', 404);
    return job;
  }

  function view(job) {
    const counts = {};
    for (const item of Object.values(job.items)) counts[item.status] = (counts[item.status] || 0) + 1;
    const { items, records, checklist_snapshot, force, t0, ...publicFields } = job;
    return clone({ ...publicFields, counts });
  }

  function save(job) {
    store.write('jobs', job.id, job);
    return view(job);
  }

  function finish(job) {
    if (job.done >= job.total) {
      job.status = 'finished';
      job.finished_at = new Date(now()).toISOString();
    }
  }

  function createBatch(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.group_id !== 'string' || !body.group_id.trim()) throw problem('Укажите ID набора');
    const groupId = body.group_id;
    const checklistId = body.checklist_id || 'default';
    if (typeof checklistId !== 'string' || (body.force !== undefined && typeof body.force !== 'boolean')) throw problem('Некорректные параметры пакетной оценки');
    const dataset = store.read('datasets', groupId);
    if (!dataset) throw problem('Набор не найден', 404);
    const checklist = store.read('checklists', checklistId);
    if (!checklist) throw problem('Чек-лист не найден', 404);
    if (!Array.isArray(dataset.records) || dataset.records.some((record) => !record || typeof record.conversation_id !== 'string' || !record.conversation_id.trim() || !Array.isArray(record.transcript)) || new Set(dataset.records.map((record) => record.conversation_id)).size !== dataset.records.length) throw problem('Исходный набор содержит повреждённые или повторяющиеся диалоги');
    let records = dataset.records;
    if (body.conversation_ids !== undefined) {
      const ids = body.conversation_ids;
      if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string' || !id.trim())) throw problem('conversation_ids должен содержать непустой список ID выбранных диалогов');
      const selected = new Set(ids);
      if (selected.size !== ids.length || ids.some((id) => !dataset.records.some((record) => record.conversation_id === id))) throw problem('В conversation_ids есть повторяющиеся или неизвестные ID');
      records = records.filter((record) => selected.has(record.conversation_id));
    }
    const timestamp = now();
    const job = {
      id: store.newId('job'), execution_mode: 'stepped',
      group_id: groupId, checklist_id: checklist.id, checklist_version: checklist.version,
      total: records.length, done: 0, skipped: 0, errors: [], cost_usd: 0,
      unknown_cost_count: 0, status: records.length ? 'running' : 'finished',
      started_at: new Date(timestamp).toISOString(), t0: timestamp,
      force: !!body.force, records: clone(records), checklist_snapshot: clone(checklist),
      items: Object.fromEntries(records.map((record) => [record.conversation_id, { status: 'queued' }])),
    };
    if (!records.length) job.finished_at = job.started_at;
    return save(job);
  }

  function getBatch(id) { return view(readJob(id)); }

  async function stepBatch(id) {
    const job = readJob(id);
    if (job.status !== 'running') return view(job);
    const record = job.records.find((candidate) => job.items[candidate.conversation_id].status === 'queued');
    if (!record) { finish(job); return save(job); }
    const item = job.items[record.conversation_id];
    const current = store.read('datasets', job.group_id)?.records?.find((candidate) => candidate.conversation_id === record.conversation_id);
    // Never bind a completed job to a transcript imported under the same ID.
    if (!current || sourceKey(current) !== sourceKey(record)) {
      item.status = 'error';
      item.error = 'Диалог изменён или удалён после запуска. Запустите оценку нового набора.';
      job.errors.push({ conversation_id: record.conversation_id, error: item.error });
      job.done++;
      finish(job);
      return save(job);
    }
    const checklist = job.checklist_snapshot;
    const key = cacheKey(record, checklist);
    const cached = store.list('evaluations').filter((evaluation) => evaluation.group_id === job.group_id && evaluation.conversation_id === record.conversation_id && evaluation.cache_key === key && ['ok', 'needs_review'].includes(evaluation.status)).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0];
    if (!job.force && cached) {
      item.status = cached.status === 'needs_review' ? 'needs_review' : 'skipped';
      item.evaluation_id = cached.id;
      job.skipped++;
    } else {
      item.status = 'running';
      let evaluation;
      try {
        evaluation = await evaluate(clone(record), clone(checklist), job.group_id, { force: job.force, queue_ms: Math.max(0, now() - job.t0) });
        store.write('evaluations', evaluation.id, evaluation);
        item.status = evaluation.status === 'needs_review' ? 'needs_review' : 'done';
        item.evaluation_id = evaluation.id;
        item.ms = evaluation.duration_ms;
        if (finite(evaluation.cost_usd)) job.cost_usd += evaluation.cost_usd;
        else job.unknown_cost_count++;
      } catch (error) {
        const paid = evaluation || error?.evaluation_metrics;
        if (finite(paid?.cost_usd)) job.cost_usd += paid.cost_usd;
        else job.unknown_cost_count++;
        const recorded = error instanceof Error ? error : new Error('Оценка завершилась ошибкой');
        if (evaluation) recorded.evaluation_metrics = evaluation;
        saveFailure(record, checklist, job.group_id, recorded);
        item.status = 'error';
        item.error = safeFailureMessage(error);
        job.errors.push({ conversation_id: record.conversation_id, error: item.error });
      }
    }
    job.cost_usd = Number(job.cost_usd.toFixed(6));
    job.done++;
    finish(job);
    return save(job);
  }

  function cancelBatch(id) {
    const job = readJob(id);
    if (job.status !== 'running') return view(job);
    job.cancelled = true;
    job.status = 'cancelled';
    job.finished_at = new Date(now()).toISOString();
    for (const item of Object.values(job.items)) if (item.status === 'queued') item.status = 'cancelled';
    return save(job);
  }

  return { createBatch, getBatch, stepBatch, cancelBatch };
}

let defaultBatch;
const defaultMethod = (name) => (...args) => (defaultBatch ||= createCloudBatch())[name](...args);
module.exports = { createCloudBatch, createBatch: defaultMethod('createBatch'), getBatch: defaultMethod('getBatch'), stepBatch: defaultMethod('stepBatch'), cancelBatch: defaultMethod('cancelBatch') };

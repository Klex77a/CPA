'use strict';
/** Durable, request-driven batches. Each paid step has a short atomic claim and
 * finalization; the external model call holds no workspace/database lock.
 */
const crypto = require('node:crypto');
const { addJobCost } = require('./billing');
const clone = (value) => JSON.parse(JSON.stringify(value));
const problem = (message, status = 400) => Object.assign(new Error(message), { status });
const sourceKey = (record) =>
  crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        id: record.conversation_id,
        channel: record.channel,
        language: record.language,
        transcript: record.transcript,
      }),
    )
    .digest('hex');

function createCloudBatch(dependencies = {}) {
  const store = dependencies.store || require('./store');
  const evaluator = dependencies.evaluate && dependencies.cacheKey ? null : require('./evaluator');
  const evaluate = dependencies.evaluate || evaluator.evaluate;
  const cacheKey = dependencies.cacheKey || evaluator.cacheKey;
  const failure = require('./evaluation-failure');
  const saveFailure = dependencies.saveEvaluationFailure || failure.saveEvaluationFailure;
  const safeFailureMessage = dependencies.safeFailureMessage || failure.safeFailureMessage;
  const now = dependencies.now || Date.now;
  const transact =
    dependencies.transact ||
    (dependencies.store
      ? async (callback) => callback()
      : (callback) => require('./cloud-store').withCloudStore({}, callback));
  const tasks = require('./cloud-evaluation').createCloudEvaluation({
    ...dependencies,
    store,
    evaluate,
    cacheKey,
    now,
    transact,
  });

  function readJob(id) {
    if (typeof id !== 'string' || !id) throw problem('Укажите ID задачи');
    const job = store.read('jobs', id);
    if (!job || job.kind === 'evaluation-task') throw problem('Задача не найдена', 404);
    return job;
  }

  function view(job) {
    const counts = {};
    for (const item of Object.values(job.items))
      counts[item.status] = (counts[item.status] || 0) + 1;
    const { items, records, checklist_snapshot, force, t0, ...publicFields } = job;
    return clone({ ...publicFields, counts });
  }

  function save(job) {
    store.write('jobs', job.id, job);
    return view(job);
  }

  function finish(job) {
    if (job.status === 'running' && job.done >= job.total) {
      job.status = 'finished';
      job.finished_at = new Date(now()).toISOString();
    }
  }

  function createBatch(body) {
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      typeof body.group_id !== 'string' ||
      !body.group_id.trim()
    )
      throw problem('Укажите ID набора');
    const groupId = body.group_id;
    const checklistId = body.checklist_id || 'default';
    if (
      typeof checklistId !== 'string' ||
      (body.force !== undefined && typeof body.force !== 'boolean')
    )
      throw problem('Некорректные параметры пакетной оценки');
    const dataset = store.read('datasets', groupId);
    if (!dataset) throw problem('Набор не найден', 404);
    const checklist = store.read('checklists', checklistId);
    if (!checklist) throw problem('Чек-лист не найден', 404);
    if (
      !Array.isArray(dataset.records) ||
      dataset.records.some(
        (record) =>
          !record ||
          typeof record.conversation_id !== 'string' ||
          !record.conversation_id.trim() ||
          !Array.isArray(record.transcript),
      ) ||
      new Set(dataset.records.map((record) => record.conversation_id)).size !==
        dataset.records.length
    )
      throw problem('Исходный набор содержит повреждённые или повторяющиеся диалоги');
    let records = dataset.records;
    if (body.conversation_ids !== undefined) {
      const ids = body.conversation_ids;
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.some((id) => typeof id !== 'string' || !id.trim())
      )
        throw problem('conversation_ids должен содержать непустой список ID выбранных диалогов');
      const selected = new Set(ids);
      if (
        selected.size !== ids.length ||
        ids.some((id) => !dataset.records.some((record) => record.conversation_id === id))
      )
        throw problem('В conversation_ids есть повторяющиеся или неизвестные ID');
      records = records.filter((record) => selected.has(record.conversation_id));
    }
    const timestamp = now();
    const job = {
      id: store.newId('job'),
      execution_mode: 'stepped',
      group_id: groupId,
      checklist_id: checklist.id,
      checklist_version: checklist.version,
      total: records.length,
      done: 0,
      skipped: 0,
      errors: [],
      cost_usd: 0,
      known_cost_usd: 0,
      unknown_cost_count: 0,
      unknown_call_count: 0,
      billing_complete: true,
      status: records.length ? 'running' : 'finished',
      started_at: new Date(timestamp).toISOString(),
      t0: timestamp,
      force: !!body.force,
      records: clone(records),
      checklist_snapshot: clone(checklist),
      items: Object.fromEntries(
        records.map((record) => [record.conversation_id, { status: 'queued' }]),
      ),
    };
    if (!records.length) job.finished_at = job.started_at;
    return save(job);
  }

  function getBatch(id) {
    return view(readJob(id));
  }

  function settleItem(job, record, result) {
    const item = job.items[record.conversation_id];
    if (!['running', 'queued'].includes(item.status)) return view(job);
    if (result.evaluation) {
      const evaluation = result.evaluation;
      item.status =
        evaluation.status === 'needs_review' ? 'needs_review' : result.cached ? 'skipped' : 'done';
      item.evaluation_id = evaluation.id;
      item.ms = evaluation.duration_ms;
      if (result.cached) job.skipped++;
      else addJobCost(job, evaluation);
    } else {
      const paid = result.task?.metrics;
      addJobCost(job, paid);
      item.status = 'error';
      item.error = safeFailureMessage(result.error);
      job.errors.push({ conversation_id: record.conversation_id, error: item.error });
    }
    job.done++;
    finish(job);
    return save(job);
  }

  async function stepBatch(id) {
    const claimed = await transact(() => {
      const job = readJob(id);
      if (job.status !== 'running') return { view: view(job) };
      const running = job.records.find(
        (record) => job.items[record.conversation_id].status === 'running',
      );
      if (running) {
        const currentTask = tasks.readTask(job.items[running.conversation_id].task_id);
        if (tasks.pending(currentTask.id))
          return { task: currentTask, record: running, result: tasks.pending(currentTask.id) };
        const task = tasks.expire(currentTask);
        return {
          view:
            task.status === 'running' ? view(job) : settleItem(job, running, tasks.outcome(task)),
        };
      }
      const record = job.records.find(
        (candidate) => job.items[candidate.conversation_id].status === 'queued',
      );
      if (!record) {
        finish(job);
        return { view: save(job) };
      }
      const current = store
        .read('datasets', job.group_id)
        ?.records?.find((candidate) => candidate.conversation_id === record.conversation_id);
      // A changed source is not a paid model attempt and cannot reuse old proof.
      if (!current || sourceKey(current) !== sourceKey(record)) {
        const item = job.items[record.conversation_id];
        item.status = 'error';
        item.error = 'Диалог изменён или удалён после запуска. Запустите оценку нового набора.';
        job.errors.push({ conversation_id: record.conversation_id, error: item.error });
        job.done++;
        finish(job);
        return { view: save(job) };
      }
      const selected = tasks.claim({
        record,
        checklist: job.checklist_snapshot,
        groupId: job.group_id,
        force: job.force,
        requestId: crypto
          .createHash('sha256')
          .update(JSON.stringify([job.id, record.conversation_id]))
          .digest('hex'),
        queueMs: Math.max(0, now() - job.t0),
      });
      if (selected.type === 'settled') return { view: settleItem(job, record, selected) };
      job.items[record.conversation_id].status = 'running';
      job.items[record.conversation_id].task_id = selected.task.id;
      save(job);
      return selected.type === 'busy' ? { view: view(job) } : { task: selected.task, record };
    });
    if (claimed.view) return claimed.view;
    const result = claimed.result || (await tasks.execute(claimed.task));
    // Reload the latest workspace/job so cancellation, appeals and edits made
    // during the model call are preserved. A database error never repeats it.
    const resultView = await transact(() =>
      settleItem(readJob(id), claimed.record, tasks.complete(claimed.task, result)),
    );
    tasks.forget(claimed.task.id);
    return resultView;
  }

  function cancelBatch(id) {
    const job = readJob(id);
    if (job.status !== 'running') return view(job);
    job.cancelled = true;
    job.status = 'cancelled';
    job.finished_at = new Date(now()).toISOString();
    for (const item of Object.values(job.items))
      if (item.status === 'queued') item.status = 'cancelled';
    return save(job);
  }

  return { createBatch, getBatch, stepBatch, cancelBatch };
}

let defaultBatch;
const defaultMethod =
  (name) =>
  (...args) =>
    (defaultBatch ||= createCloudBatch())[name](...args);
module.exports = {
  createCloudBatch,
  createBatch: defaultMethod('createBatch'),
  getBatch: defaultMethod('getBatch'),
  stepBatch: defaultMethod('stepBatch'),
  cancelBatch: defaultMethod('cancelBatch'),
};

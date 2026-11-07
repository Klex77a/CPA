'use strict';
/** Short durable claims surround external model work. Nothing paid runs while
 * a PostgreSQL workspace row is locked; database errors never replay that work.
 */
const crypto = require('node:crypto');
const clone = (value) => JSON.parse(JSON.stringify(value));
const problem = (message, status = 409, code = 'EVALUATION_IN_PROGRESS') =>
  Object.assign(new Error(message), { status, code });
const LEASE_MS = 300000; // Exceeds the 180-second function lifetime plus clock skew.
// A live instance can retry only the commit after a transient database failure.
// After process loss the durable lease becomes uncertain, never an automatic retry.
const pendingResults = new Map();
const PENDING_TTL_MS = 900000;
const PENDING_LIMIT = 32;

function createCloudEvaluation(dependencies = {}) {
  const store = dependencies.store || require('./store');
  const evaluator = dependencies.evaluate && dependencies.cacheKey ? null : require('./evaluator');
  const evaluate = dependencies.evaluate || evaluator.evaluate;
  const cacheKey = dependencies.cacheKey || evaluator.cacheKey;
  const failure = require('./evaluation-failure');
  const saveFailure = dependencies.saveEvaluationFailure || failure.saveEvaluationFailure;
  const now = dependencies.now || Date.now;
  const leaseMs = dependencies.leaseMs || LEASE_MS;
  const pending = dependencies.pendingResults || pendingResults;
  const pendingTtlMs = dependencies.pendingTtlMs || PENDING_TTL_MS;
  const pendingLimit = dependencies.pendingLimit || PENDING_LIMIT;
  const transact =
    dependencies.transact ||
    (dependencies.store || !store.cloudMode
      ? async (callback) => callback()
      : (callback) => require('./cloud-store').withCloudStore({}, callback));

  function prunePending() {
    for (const [id, result] of pending) {
      if (result.retain_until <= now()) pending.delete(id);
    }
    while (pending.size > pendingLimit) pending.delete(pending.keys().next().value);
  }
  function remembered(id) {
    prunePending();
    return pending.get(id);
  }

  function readTask(id) {
    const task = store.read('jobs', id);
    if (!task || task.kind !== 'evaluation-task')
      throw problem('Попытка оценки не найдена.', 404, 'EVALUATION_NOT_FOUND');
    return task;
  }
  function expire(task) {
    if (task.status !== 'running' || now() < task.lease_until) return task;
    const error = problem(
      'Предыдущая попытка прервана. Списание у провайдера возможно; повторите оценку явно.',
      409,
      'EVALUATION_UNCERTAIN',
    );
    const saved = saveFailure(task.record, task.checklist, task.group_id, error, {
      id: `failure-${task.id}`,
      created_at: new Date(now()).toISOString(),
    });
    task.status = 'uncertain';
    task.error = error.message;
    task.failure_id = saved?.id || null;
    task.completed_at = new Date(now()).toISOString();
    store.write('jobs', task.id, task);
    return task;
  }
  function outcome(task) {
    if (task.status === 'completed') {
      const result = store.read('evaluations', task.evaluation_id);
      if (!result)
        throw problem(
          'Сохранённый результат этой попытки удалён. Запустите новую оценку явно.',
          409,
          'EVALUATION_RESULT_REMOVED',
        );
      return { evaluation: result, cached: true, task };
    }
    return {
      error: task.error,
      status: task.error_status || (task.status === 'uncertain' ? 409 : 502),
      code: task.status === 'uncertain' ? 'EVALUATION_UNCERTAIN' : 'EVALUATION_FAILED',
      task,
    };
  }
  function claim({ record, checklist, groupId, force = false, requestId, queueMs = 0 }) {
    if (
      requestId !== undefined &&
      (typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(requestId))
    )
      throw problem('Некорректный request_id.', 400, 'INVALID_REQUEST_ID');
    const key = cacheKey(record, checklist);
    const slot = JSON.stringify([groupId, key]);
    const id =
      'evaluation-task-' +
      crypto
        .createHash('sha256')
        .update(JSON.stringify([groupId, requestId || crypto.randomUUID()]))
        .digest('hex');
    const previous = store.read('jobs', id);
    if (previous?.kind === 'evaluation-task') {
      if (previous.cache_key !== key || previous.force !== !!force)
        throw problem(
          'Исходный диалог или параметры этой попытки изменились. Начните новую оценку с новым request_id.',
          409,
          'EVALUATION_INPUT_CHANGED',
        );
      const task = remembered(previous.id) ? previous : expire(previous);
      return task.status === 'running'
        ? { type: 'busy', task }
        : { type: 'settled', ...outcome(task) };
    }
    const tasks = store
      .list('jobs')
      .filter((item) => item.kind === 'evaluation-task' && item.slot === slot);
    for (const existing of tasks.filter((item) => item.status === 'running')) {
      const task = remembered(existing.id) ? existing : expire(existing);
      if (task.status === 'running') return { type: 'busy', task };
    }
    if (!force) {
      const cached = store
        .list('evaluations')
        .filter(
          (item) =>
            item.group_id === groupId &&
            item.conversation_id === record.conversation_id &&
            item.cache_key === key &&
            ['ok', 'needs_review'].includes(item.status),
        )
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
      if (cached) {
        const task = {
          id,
          kind: 'evaluation-task',
          slot,
          cache_key: key,
          group_id: groupId,
          conversation_id: record.conversation_id,
          force: false,
          status: 'completed',
          evaluation_id: cached.id,
          created_at: new Date(now()).toISOString(),
          completed_at: new Date(now()).toISOString(),
        };
        store.write('jobs', id, task);
        return { type: 'settled', evaluation: cached, cached: true, task };
      }
    }
    if (!force && tasks.some((item) => item.status === 'uncertain'))
      return { type: 'settled', ...outcome(tasks.find((item) => item.status === 'uncertain')) };
    const task = {
      id,
      kind: 'evaluation-task',
      slot,
      cache_key: key,
      group_id: groupId,
      conversation_id: record.conversation_id,
      record: clone(record),
      checklist: clone(checklist),
      force: !!force,
      queue_ms: queueMs,
      status: 'running',
      lease_token: crypto.randomUUID(),
      lease_until: now() + leaseMs,
      created_at: new Date(now()).toISOString(),
    };
    store.write('jobs', id, task);
    return { type: 'claimed', task };
  }
  async function execute(task) {
    let result;
    try {
      result = {
        evaluation: await evaluate(clone(task.record), clone(task.checklist), task.group_id, {
          force: task.force,
          queue_ms: task.queue_ms,
          operation_id: task.id,
        }),
      };
    } catch (error) {
      result = {
        failure: error instanceof Error ? error : new Error('Оценка завершилась ошибкой'),
      };
    }
    pending.set(task.id, { ...result, retain_until: now() + pendingTtlMs });
    prunePending();
    return result;
  }
  function complete(claimed, result) {
    const task = readTask(claimed.id);
    if (task.lease_token !== claimed.lease_token || task.status !== 'running') return outcome(task);
    if (result.evaluation) {
      const evaluation = clone(result.evaluation);
      const existing = store.read('evaluations', evaluation.id);
      // Never overwrite appeals/edits made while external work was in flight.
      if (existing) evaluation.id += '__' + task.lease_token;
      store.write('evaluations', evaluation.id, evaluation);
      task.status = 'completed';
      task.evaluation_id = evaluation.id;
    } else {
      const error = result.failure;
      const saved = saveFailure(task.record, task.checklist, task.group_id, error, {
        id: `failure-${task.id}`,
        created_at: new Date(now()).toISOString(),
      });
      task.status = 'failed';
      task.error = failure.safeFailureMessage(error);
      task.failure_id = saved?.id || null;
      task.error_status =
        Number.isInteger(error?.status) && error.status >= 400 && error.status < 600
          ? error.status
          : 502;
      if (error?.evaluation_metrics) {
        task.metrics = clone(error.evaluation_metrics);
        for (const call of task.metrics.timing?.calls || []) {
          if (call.error) call.error = failure.safeFailureMessage(call.error);
        }
      }
    }
    task.completed_at = new Date(now()).toISOString();
    store.write('jobs', task.id, task);
    return { ...outcome(task), cached: false };
  }
  async function perform(body) {
    const selected = await transact(() => {
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        typeof body.group_id !== 'string' ||
        typeof body.conversation_id !== 'string' ||
        (body.force !== undefined && typeof body.force !== 'boolean')
      )
        throw problem('Некорректные параметры оценки.', 400, 'INVALID_EVALUATION');
      const record = store
        .read('datasets', body.group_id)
        ?.records?.find((item) => item.conversation_id === body.conversation_id);
      if (!record)
        throw problem('Диалог не найден — сначала загрузите набор.', 404, 'RECORD_NOT_FOUND');
      const checklist = store.read('checklists', body.checklist_id || 'default');
      if (!checklist) throw problem('Чек-лист не найден.', 404, 'CHECKLIST_NOT_FOUND');
      return claim({
        record,
        checklist,
        groupId: body.group_id,
        force: body.force,
        requestId: body.request_id,
      });
    });
    if (selected.type === 'busy' && !remembered(selected.task.id))
      throw problem(
        'Оценка этого диалога уже выполняется. Готовый результат будет сохранён; повторять платный запрос не нужно.',
      );
    let final = selected;
    if (selected.type === 'claimed' || selected.type === 'busy') {
      const result = remembered(selected.task.id) || (await execute(selected.task));
      // A failed commit is deliberately surfaced; never re-run execute here.
      final = await transact(() => complete(selected.task, result));
      pending.delete(selected.task.id);
    }
    if (selected.type === 'settled' && selected.task) pending.delete(selected.task.id);
    if (final.error) throw problem(final.error, final.status, final.code);
    return { ...final.evaluation, ...(final.cached ? { cached: true } : {}) };
  }
  return {
    claim,
    execute,
    complete,
    readTask,
    expire,
    outcome,
    perform,
    transact,
    pending: remembered,
    forget: (id) => pending.delete(id),
  };
}

let instance;
const perform = (body) => (instance ||= createCloudEvaluation()).perform(body);
module.exports = { createCloudEvaluation, perform, LEASE_MS };

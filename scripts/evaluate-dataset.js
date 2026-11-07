'use strict';
const { addJobCost } = require('../src/billing');
// Planning is the default. Only --live can call the configured model.
class RunnerInputError extends Error {}

function parseArgs(args) {
  const options = { group: null, checklist: 'default', live: false, force: false, retryReview: false, maxNew: 65, concurrency: null };
  const values = { '--group': 'group', '--checklist': 'checklist', '--max-new': 'maxNew', '--concurrency': 'concurrency' };
  const flags = { '--live': 'live', '--force': 'force', '--retry-review': 'retryReview', '--help': 'help', '-h': 'help' };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const separator = args[index].indexOf('=');
    const key = separator < 0 ? args[index] : args[index].slice(0, separator);
    if (seen.has(key)) throw new RunnerInputError('Повторяющийся аргумент. Используйте --help.');
    seen.add(key);
    if (flags[key]) {
      if (separator >= 0) throw new RunnerInputError(`${key} — флаг без значения`);
      options[flags[key]] = true;
    } else if (values[key]) {
      const value = separator >= 0 ? args[index].slice(separator + 1) : args[++index];
      if (!value || value.startsWith('--')) throw new RunnerInputError(`${key} требует значение`);
      options[values[key]] = value;
    } else throw new RunnerInputError('Неизвестный аргумент. Используйте --help.');
  }
  if (options.help) return options;
  if (typeof options.group !== 'string' || !options.group.trim()) throw new RunnerInputError('Обязателен --group=<ID исходного набора>');
  options.group = options.group.trim();
  options.checklist = String(options.checklist).trim();
  if (!options.checklist) throw new RunnerInputError('--checklist не должен быть пустым');
  if (!/^\d+$/.test(String(options.maxNew))) throw new RunnerInputError('--max-new должен быть целым неотрицательным числом');
  options.maxNew = Number(options.maxNew);
  if (!Number.isSafeInteger(options.maxNew)) throw new RunnerInputError('--max-new слишком велик');
  if (options.concurrency !== null) {
    options.concurrency = Number(options.concurrency);
    if (![1, 2].includes(options.concurrency)) throw new RunnerInputError('--concurrency должен быть 1 или 2');
  }
  return options;
}

// Escape control characters in source IDs without logging transcript content.
const label = (value) => JSON.stringify(String(value)).slice(0, 240);
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function failureCode(error) {
  if (Number.isInteger(error?.status)) return `HTTP_${error.status}`;
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(error.code) ? error.code : 'EVALUATION_FAILED';
}

async function runDataset(options, dependencies = {}) {
  const cfg = dependencies.cfg || require('../src/config');
  const store = dependencies.store || require('../src/store');
  const evaluator = dependencies.evaluate && dependencies.cacheKey ? null : require('../src/evaluator');
  const evaluate = dependencies.evaluate || evaluator.evaluate;
  const cacheKey = dependencies.cacheKey || evaluator.cacheKey;
  const saveFailure = dependencies.saveEvaluationFailure || require('../src/evaluation-failure').saveEvaluationFailure;
  const log = dependencies.log || console.log;
  const now = dependencies.now || Date.now;
  const started = now();
  const dataset = store.read('datasets', options.group);
  const checklist = store.read('checklists', options.checklist);
  if (!dataset || !Array.isArray(dataset.records)) throw new RunnerInputError('Исходный набор не найден; сначала загрузите его в приложение');
  if (!checklist) throw new RunnerInputError('Чек-лист не найден');
  if (dataset.group_id !== options.group) throw new RunnerInputError('group_id исходного набора не совпадает с выбранным ID');
  const ids = dataset.records.map((record) => record.conversation_id);
  if (ids.some((id) => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) throw new RunnerInputError('В исходном наборе пустые или повторяющиеся conversation_id');
  const existing = store.list('evaluations').filter((evaluation) => evaluation.group_id === options.group);
  const planned = [];
  const summary = {
    mode: options.live ? 'live' : 'dry-run', group: options.group, checklist: options.checklist,
    total: dataset.records.length, planned: 0, skipped: 0, review_blocked: 0,
    done: 0, needs_review: 0, failed: 0, cost_usd: 0, known_cost_usd: 0, billing_complete: true, unknown_cost_count: 0, unknown_call_count: 0,
    http_attempts: 0, model_calls: 0,
  };
  for (const record of dataset.records) {
    const key = cacheKey(record, checklist);
    const cached = existing.filter((evaluation) => evaluation.conversation_id === record.conversation_id && evaluation.cache_key === key)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0];
    if (!options.force && cached?.status === 'ok') summary.skipped++;
    else if (!options.force && cached?.status === 'needs_review' && !options.retryReview) summary.review_blocked++;
    else planned.push({ record, force: options.force || !!cached });
  }
  summary.planned = planned.length;
  const concurrency = options.concurrency ?? Math.max(1, Math.min(2, Math.floor(cfg.CONCURRENCY || 1)));
  log(`${options.live ? 'LIVE' : 'DRY-RUN'} group=${label(options.group)} checklist=${label(options.checklist)} provider=${label(cfg.provider)} model=${label(cfg.model)} total=${summary.total} cached_ok=${summary.skipped} review_blocked=${summary.review_blocked} planned=${summary.planned} concurrency=${concurrency} max_new=${options.maxNew}`);
  if (summary.planned > options.maxNew) throw new RunnerInputError(`Нужно ${summary.planned} новых оценок, лимит --max-new=${options.maxNew}; запросы не отправлены`);
  if (!options.live) {
    if (summary.review_blocked) log('Спорные оценки сохранены: для повторного анализа добавьте --retry-review либо --force.');
    log('Планирование завершено. Запросов к модели и новых записей нет; для выполнения добавьте --live.');
    return { ...summary, duration_ms: now() - started, exitCode: summary.review_blocked ? 1 : 0 };
  }
  if (cfg.provider === 'mock' && planned.length) throw new RunnerInputError('Для --live нужна настоящая настроенная модель; демо-эвристика не создаёт результаты сдачи');

  const account = (metrics) => {
    addJobCost(summary, metrics);
    if (finite(metrics?.timing?.http_attempts)) summary.http_attempts += metrics.timing.http_attempts;
    if (Array.isArray(metrics?.timing?.calls)) summary.model_calls += metrics.timing.calls.length;
  };
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, planned.length) }, async () => {
    while (cursor < planned.length) {
      const { record, force } = planned[cursor++];
      const t0 = now();
      let evaluation;
      try {
        evaluation = await evaluate(record, checklist, options.group, { force, queue_ms: t0 - started });
        account(evaluation);
        store.write('evaluations', evaluation.id, evaluation);
        if (evaluation.status === 'ok') summary.done++;
        else summary.needs_review++;
        log(`${evaluation.status === 'ok' ? 'OK' : 'NEEDS_REVIEW'} ${label(record.conversation_id)} ${now() - t0}ms cost=${finite(evaluation.cost_usd) ? evaluation.cost_usd.toFixed(6) : 'unknown'}`);
      } catch (error) {
        summary.failed++;
        if (!evaluation) account(error?.evaluation_metrics);
        // A successful paid response can still fail persistence. Preserve its work
        // in a failure record when possible, while leaving historical results intact.
        const failure = error instanceof Error ? error : new Error('Оценка завершилась ошибкой');
        if (evaluation) failure.evaluation_metrics = evaluation;
        let persisted = true;
        try { saveFailure(record, checklist, options.group, failure); }
        catch (_) { persisted = false; }
        log(`FAILED ${label(record.conversation_id)} ${now() - t0}ms code=${evaluation ? 'PERSISTENCE_FAILED' : failureCode(error)}${persisted ? '' : ' failure_record=NOT_SAVED'}`);
      }
    }
  }));
  summary.duration_ms = now() - started;
  summary.exitCode = summary.failed || summary.needs_review || summary.review_blocked ? 1 : 0;
  log(`FINISHED total=${summary.total} done=${summary.done} skipped=${summary.skipped} review_blocked=${summary.review_blocked} needs_review=${summary.needs_review} failed=${summary.failed} observed_cost_lower_bound=$${summary.known_cost_usd.toFixed(6)} billing_complete=${summary.billing_complete} unknown_cost=${summary.unknown_cost_count} model_calls=${summary.model_calls} http_attempts=${summary.http_attempts}`);
  return summary;
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log('План: node scripts/evaluate-dataset.js --group=DEV [--checklist=default]\nВыполнение: node scripts/evaluate-dataset.js --group=DEV --live [--max-new=65] [--concurrency=1|2] [--retry-review] [--force]\nФайлы сдачи готовятся отдельной командой; этот скрипт их не публикует.');
    return 0;
  }
  return (await runDataset(options)).exitCode;
}

if (require.main === module) main().then((code) => { process.exitCode = code; }).catch((error) => {
  // Only local planning/configuration errors reach here; worker errors use codes.
  console.error(`Dataset runner: ${error instanceof RunnerInputError ? error.message : 'Ошибка чтения или сохранения локальных данных; проверьте JSON и доступ к хранилищу.'}`);
  process.exitCode = 2;
});
module.exports = { parseArgs, runDataset, main };

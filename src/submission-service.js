'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config');
const store = require('./store');
const { buildSubmission, validateSubmission } = require('./result-export');

const expectedCount = { dev: 65, prod: 10 };
const invalid = (message) => Object.assign(new Error(message), { status: 400 });
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

function submissionPath(split, root = cfg.ROOT) {
  if (!Object.hasOwn(expectedCount, split)) throw invalid('Выберите --split=dev или --split=prod');
  return path.join(root, 'results', split, 'results.json');
}

function buildForGroup({ split, groupId, teamName = 'Midnight Commit' }) {
  if (!groupId) throw invalid('Укажите ID набора через --group=...');
  const dataset = store.read('datasets', groupId);
  if (!dataset) throw invalid(`Набор ${groupId} не загружен`);
  const checklist = store.read('checklists', 'default');
  const output = buildSubmission({ dataset, checklist, evaluations: [...store.list('evaluations'), ...store.list('failures')], teamName, split });
  return { output, dataset };
}

/** Only the two explicit official paths are writable; no arbitrary path is accepted. */
function writeSubmissionFile(split, output, root = cfg.ROOT) {
  const target = submissionPath(split, root);
  const parent = path.dirname(target);
  const rootPath = fs.realpathSync(root);
  // Refuse junctions/symlinks before creating or replacing anything in results/.
  for (const segment of ['results', path.join('results', split), path.join('results', split, 'results.json')]) {
    const candidate = path.join(root, segment);
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) throw invalid('Путь сдачи не должен быть символической ссылкой');
  }
  fs.mkdirSync(parent, { recursive: true });
  const relative = path.relative(rootPath, fs.realpathSync(parent));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw invalid('Папка сдачи находится вне проекта');
  const temporary = target + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(output, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return target;
}

function prepareSubmission({ split, groupId, teamName, dryRun = false, root = cfg.ROOT }) {
  const { output, dataset } = buildForGroup({ split, groupId, teamName });
  const errors = validateSubmission(output, { split, records: dataset.records });
  if (errors.length) throw invalid(errors.join('; '));
  if (!dryRun) writeSubmissionFile(split, output, root);
  return { split, group_id: groupId, path: `results/${split}/results.json`, written: !dryRun, total: output.results.length, ok: output.results.filter((row) => row.status === 'ok').length, errors: output.results.filter((row) => row.status === 'error').length };
}

function matchingDataset(split, datasets, document, groupId) {
  if (groupId) return datasets.find((dataset) => dataset.group_id === groupId) || null;
  if (split === 'dev') return datasets.find((dataset) => dataset.group_id.toUpperCase() === 'DEV') || null;
  const candidates = datasets.filter((dataset) => dataset.records.length === 10 && !/^(SAMPLE|QA(?:_|$))/i.test(dataset.group_id));
  if (Array.isArray(document?.results) && document.results.length === 10) {
    const ids = new Set(document.results.map((result) => result?.conversation_id));
    return candidates.find((dataset) => dataset.records.every((record) => ids.has(record.conversation_id))) || null;
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function inspectSubmission({ split, groupId, teamName = 'Midnight Commit', root = cfg.ROOT }) {
  const location = submissionPath(split, root);
  const base = { split, path: `results/${split}/results.json`, expected: expectedCount[split], total: 0, ok: 0, errors: 0 };
  let document;
  try { if (fs.existsSync(location)) document = JSON.parse(fs.readFileSync(location, 'utf8').replace(/^\uFEFF/, '')); }
  catch (_) { return { ...base, state: 'blocked', message: 'Файл содержит некорректный JSON' }; }
  const dataset = matchingDataset(split, store.list('datasets'), document, groupId);
  if (document === undefined) return { ...base, group_id: dataset?.group_id || null, state: dataset ? 'missing_file' : 'waiting_dataset', message: dataset ? 'Набор загружен, файл сдачи ещё не сохранён' : split === 'prod' ? 'Ожидается контрольный набор организаторов' : 'DEV ещё не загружен' };
  if (Array.isArray(document?.results)) {
    base.total = document.results.length;
    base.ok = document.results.filter((row) => row?.status === 'ok').length;
    base.errors = document.results.filter((row) => row?.status === 'error').length;
  }
  const errors = validateSubmission(document, { split, records: dataset?.records });
  if (errors.length) return { ...base, state: 'blocked', message: 'Файл не прошёл валидацию', validation_errors: errors.slice(0, 12) };
  if (!dataset) return { ...base, state: 'unverified_source', message: 'Файл есть; для сверки исходных ID и реплик загрузите соответствующий набор' };
  try {
    const { output } = buildForGroup({ split, groupId: dataset.group_id, teamName });
    if (canonical(document) !== canonical(output)) return { ...base, group_id: dataset.group_id, state: 'stale', message: 'Сохранённый файл отличается от текущих оценок. Подготовьте его заново' };
  } catch (error) { return { ...base, group_id: dataset.group_id, state: 'blocked', message: error.message }; }
  return { ...base, group_id: dataset.group_id, state: base.errors ? 'valid_with_errors' : 'ready', message: base.errors ? `Формат корректен; ошибок обработки: ${base.errors}` : 'Файл сверён с текущим набором и оценками' };
}

module.exports = { prepareSubmission, inspectSubmission, writeSubmissionFile, submissionPath };

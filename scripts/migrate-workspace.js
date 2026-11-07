'use strict';
const fs = require('node:fs');
const { COLLECTIONS, importEntries, exportEntries, chunkEntries } = require('../src/workspace-transfer');

class InputError extends Error {}
function parseArgs(args) {
  const options = { live: false, replace: false, url: null, authFile: null };
  const values = { '--url': 'url', '--auth-file': 'authFile' };
  const flags = { '--live': 'live', '--replace-existing': 'replace', '--help': 'help', '-h': 'help' };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const separator = args[index].indexOf('=');
    const key = separator < 0 ? args[index] : args[index].slice(0, separator);
    if (seen.has(key)) throw new InputError('Повторяющийся аргумент; используйте --help.');
    seen.add(key);
    if (Object.hasOwn(flags, key)) {
      if (separator >= 0) throw new InputError('Флаг не должен содержать значение.');
      options[flags[key]] = true;
    } else if (Object.hasOwn(values, key)) {
      const value = separator >= 0 ? args[index].slice(separator + 1) : args[++index];
      if (!value || value.startsWith('--')) throw new InputError('Отсутствует значение аргумента.');
      options[values[key]] = value;
    } else throw new InputError('Неизвестный аргумент; используйте --help.');
  }
  if (options.url) {
    let target;
    try { target = new URL(options.url); } catch (_) { throw new InputError('Некорректный URL назначения.'); }
    if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash || !['', '/'].includes(target.pathname)) throw new InputError('Нужен точный HTTPS origin без пароля, пути и параметров.');
    options.url = target.origin;
  }
  if (options.live && (!options.url || !options.authFile)) throw new InputError('Для отправки обязательны --live, --url=https://host и --auth-file=private.json.');
  return options;
}

async function migrateWorkspace(options, dependencies = {}) {
  const store = dependencies.store || require('../src/store');
  const log = dependencies.log || console.log;
  const fetch = dependencies.fetch || globalThis.fetch;
  const readFile = dependencies.readFile || ((file) => fs.readFileSync(file, 'utf8'));
  const entries = exportEntries(store);
  const chunks = chunkEntries(entries, { replace: options.replace });
  const counts = Object.fromEntries(COLLECTIONS.map((name) => [name, entries.filter((entry) => entry.collection === name).length]));
  // Validate all local entries, including chunks not yet sent, before any network.
  const emptyStore = { read: () => null, write: () => {} };
  for (const chunk of chunks) importEntries({ entries: chunk, replace: options.replace }, { store: emptyStore });
  const summary = { mode: options.live ? 'live' : 'dry-run', counts, entries: entries.length, chunks: chunks.length, bytes: chunks.reduce((sum, chunk) => sum + Buffer.byteLength(JSON.stringify({ entries: chunk, replace: options.replace }), 'utf8'), 0), imported: 0, replaced: 0, skipped: 0 };
  log(JSON.stringify({ mode: summary.mode, counts, entries: summary.entries, chunks: summary.chunks, bytes: summary.bytes }));
  if (!options.live) { log('План готов. Сеть и модель не вызывались; для переноса добавьте --live с точным URL и приватным auth-файлом.'); return summary; }
  let auth;
  try { auth = JSON.parse(readFile(options.authFile)); } catch (_) { throw new InputError('Не удалось прочитать приватный auth-файл.'); }
  if (!auth || typeof auth.username !== 'string' || !auth.username || auth.username.includes(':') || typeof auth.password !== 'string' || auth.password.length < 16) throw new InputError('Auth-файл должен содержать username и password длиной не менее 16 символов.');
  const authorization = 'Basic ' + Buffer.from(auth.username + ':' + auth.password, 'utf8').toString('base64');
  for (let index = 0; index < chunks.length; index++) {
    let response;
    try {
      response = await fetch(options.url + '/api/workspace/import', {
        method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', Authorization: authorization },
        body: JSON.stringify({ entries: chunks[index], replace: options.replace }), signal: AbortSignal.timeout(120000),
      });
    } catch (_) { throw new InputError(`Перенос остановлен на пакете ${index + 1}/${chunks.length}: сетевая ошибка. Повтор безопасен для уже совпадающих записей.`); }
    if (!response.ok) throw new InputError(`Перенос остановлен на пакете ${index + 1}/${chunks.length}: HTTP ${Number.isInteger(response.status) ? response.status : 'ERROR'}. Содержимое ответа не выводится.`);
    let result;
    try { result = await response.json(); } catch (_) { throw new InputError('Сервер вернул некорректный ответ переноса.'); }
    if (!result || result.total !== chunks[index].length || ['imported', 'replaced', 'skipped'].some((field) => !Number.isSafeInteger(result[field]) || result[field] < 0) || result.imported + result.replaced + result.skipped !== result.total) throw new InputError('Сервер не подтвердил число перенесённых записей.');
    for (const field of ['imported', 'replaced', 'skipped']) summary[field] += result[field];
    log(`Пакет ${index + 1}/${chunks.length}: imported=${result.imported}, replaced=${result.replaced}, skipped=${result.skipped}`);
  }
  return summary;
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) { console.log('План: node scripts/migrate-workspace.js\nПеренос: node scripts/migrate-workspace.js --live --url=https://exact-host --auth-file=.vercel/access.local.json [--replace-existing]\nСекреты берутся из приватного файла; .env и фоновые задания не переносятся.'); return 0; }
  await migrateWorkspace(options);
  return 0;
}
if (require.main === module) main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(error instanceof InputError || Number.isInteger(error?.status) ? error.message : 'Не удалось прочитать или проверить локальное рабочее пространство.');
  process.exitCode = 1;
});
module.exports = { parseArgs, migrateWorkspace, main };

'use strict';
/**
 * Простое хранилище на JSON-файлах в папке data/.
 * Для прототипа этого достаточно; при переносе в Dynamics 365 заменяется на Dataverse.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { DATA_DIR } = require('./config');

const dirs = ['datasets', 'checklists', 'evaluations', 'appeals', 'failures', 'jobs'];
const cloudMode = process.env.VERCEL === '1' || process.env.CQA_STORAGE_DRIVER === 'postgres';
const snapshots = new AsyncLocalStorage();
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => JSON.parse(JSON.stringify(value));
const unavailable = (message, code = 'CLOUD_STORE_UNAVAILABLE') => Object.assign(new Error(message), { status: 503, code });
if (!cloudMode) for (const d of dirs) fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });

/** A request receives an isolated working snapshot; the cloud adapter commits it.
 * Reads return copies, matching the file adapter's read/modify/write contract.
 */
function withSnapshot(snapshot, { readOnly = false } = {}, callback) {
  if (!isObject(snapshot) || typeof callback !== 'function') throw unavailable('Некорректный контекст облачного хранилища.');
  for (const dir of dirs) {
    if (!own(snapshot, dir)) Object.defineProperty(snapshot, dir, { value: {}, writable: true, enumerable: true, configurable: true });
    if (!isObject(snapshot[dir])) throw unavailable('Некорректная структура облачного хранилища.');
  }
  const current = { snapshot, readOnly: !!readOnly, active: true };
  return snapshots.run(current, () => {
    let result;
    try { result = callback(); }
    catch (error) { current.active = false; throw error; }
    if (result && typeof result.then === 'function') return Promise.resolve(result).finally(() => { current.active = false; });
    current.active = false;
    return result;
  });
}

function context(dir, writing = false) {
  if (!dirs.includes(dir)) throw new Error(`Неизвестная коллекция: ${dir}`);
  const current = snapshots.getStore();
  if (current && !current.active) throw unavailable('Контекст облачного запроса уже завершён.', 'CLOUD_STORE_CONTEXT_EXPIRED');
  if (!current && cloudMode) throw unavailable('Облачное хранилище доступно только внутри запроса.', 'CLOUD_STORE_CONTEXT_REQUIRED');
  if (current?.readOnly && writing) throw unavailable('В этом запросе изменение данных запрещено.', 'CLOUD_STORE_READ_ONLY');
  return current;
}

// Сохраняем привычные имена, а остальные кодируем без коллизий и ограничений Windows.
function storageKey(id) {
  const value = String(id);
  if (/^[A-Za-z0-9_.-]{1,180}$/.test(value) && !value.startsWith('key-') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) return value;
  return `key-${crypto.createHash('sha256').update(value).digest('hex')}`;
}
function file(dir, id) {
  if (!dirs.includes(dir)) throw new Error(`Неизвестная коллекция: ${dir}`);
  return path.join(DATA_DIR, dir, storageKey(id) + '.json');
}

function read(dir, id) {
  const current = context(dir);
  if (current) {
    const collection = current.snapshot[dir], key = storageKey(id);
    return own(collection, key) ? clone(collection[key]) : null;
  }
  const f = file(dir, id);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function write(dir, id, obj) {
  const current = context(dir, true);
  if (current) {
    // defineProperty also handles an imported ID such as "__proto__" safely.
    Object.defineProperty(current.snapshot[dir], storageKey(id), { value: clone(obj), writable: true, enumerable: true, configurable: true });
    return obj;
  }
  const f = file(dir, id);
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, f);
  return obj;
}
function list(dir) {
  const current = context(dir);
  if (current) return Object.values(current.snapshot[dir]).map(clone);
  return fs
    .readdirSync(path.join(DATA_DIR, dir))
    .filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, dir, n), 'utf8')));
}
function remove(dir, id) {
  const current = context(dir, true);
  if (current) { delete current.snapshot[dir][storageKey(id)]; return; }
  const f = file(dir, id);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
const newId = (prefix) => `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;

module.exports = { read, write, list, remove, newId, withSnapshot, cloudMode };

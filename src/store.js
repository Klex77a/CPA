'use strict';
/**
 * Простое хранилище на JSON-файлах в папке data/.
 * Для прототипа этого достаточно; при переносе в Dynamics 365 заменяется на Dataverse.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');

const dirs = ['datasets', 'checklists', 'evaluations', 'appeals'];
for (const d of dirs) fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });

const safe = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '_');
const file = (dir, id) => path.join(DATA_DIR, dir, safe(id) + '.json');

function read(dir, id) {
  const f = file(dir, id);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function write(dir, id, obj) {
  const f = file(dir, id);
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, f);
  return obj;
}
function list(dir) {
  return fs
    .readdirSync(path.join(DATA_DIR, dir))
    .filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, dir, n), 'utf8')));
}
function remove(dir, id) {
  const f = file(dir, id);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
const newId = (prefix) => `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;

module.exports = { read, write, list, remove, newId };

'use strict';
/** One transactional workspace keeps the local store contract on stateless hosts.
 * This is intended for a small team; mutations in one workspace are serialized.
 */
const store = require('./store');
const defaultChecklist = require('./default-checklist.json');

const unavailable = (message = 'Облачное хранилище временно недоступно.') => Object.assign(new Error(message), { status: 503, code: 'CLOUD_STORE_UNAVAILABLE' });
const clone = (value) => JSON.parse(JSON.stringify(value));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function initialSnapshot() {
  return { datasets: {}, checklists: { default: clone(defaultChecklist) }, evaluations: {}, appeals: {}, failures: {}, jobs: {} };
}

/** The injected pool makes transaction behaviour testable without a database. */
function createCloudStore({ pool, workspaceId = 'midnight-commit', lockTimeoutMs = 15000 } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw unavailable('Не настроено подключение к облачному хранилищу.');
  if (typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId.length > 160) throw unavailable('Некорректный ID облачного рабочего пространства.');
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1 || lockTimeoutMs > 60000) throw unavailable('Некорректное время ожидания облачного хранилища.');
  let initialized = false;
  let initialization;
  async function ensureWorkspace(client) {
    if (initialized) return;
    if (!initialization) initialization = (async () => {
      // Concurrent cold instances may initialize the same database. Serialize
      // DDL too: CREATE TABLE IF NOT EXISTS alone can still race in PostgreSQL.
      await client.query('BEGIN');
      try {
        await client.query("SELECT set_config('lock_timeout', $1, true)", [`${lockTimeoutMs}ms`]);
        await client.query('SELECT pg_advisory_xact_lock(1129402707)');
        await client.query(`CREATE TABLE IF NOT EXISTS cqa_workspaces (
          id text PRIMARY KEY,
          payload json NOT NULL,
          revision bigint NOT NULL DEFAULT 0,
          updated_at timestamptz NOT NULL DEFAULT now()
        )`);
        // Legacy transcript hashes/cache keys serialize nested objects in their
        // original key order. JSONB normalizes that order, so keep the opaque
        // workspace as JSON; none of our queries inspect fields inside it.
        const column = await client.query(`SELECT format_type(a.atttypid, a.atttypmod) AS payload_type
          FROM pg_attribute AS a
          WHERE a.attrelid = 'cqa_workspaces'::regclass
            AND a.attname = 'payload' AND NOT a.attisdropped`);
        const payloadType = column.rows?.[0]?.payload_type;
        if (payloadType === 'jsonb') {
          await client.query('ALTER TABLE cqa_workspaces ALTER COLUMN payload TYPE json USING payload::json');
        } else if (payloadType !== 'json') {
          throw unavailable();
        }
        await client.query('INSERT INTO cqa_workspaces (id, payload) VALUES ($1, $2::json) ON CONFLICT (id) DO NOTHING', [workspaceId, JSON.stringify(initialSnapshot())]);
        await client.query('COMMIT');
        initialized = true;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) { /* caller discards this client */ }
        throw error;
      }
    })();
    try { await initialization; }
    finally { if (!initialized) initialization = null; }
  }
  function workingSnapshot(result) {
    const snapshot = result.rows?.[0]?.payload;
    if (!isObject(snapshot)) throw unavailable('Облачное рабочее пространство повреждено или отсутствует.');
    return clone(snapshot);
  }

  return async function withCloudStore({ readOnly = false } = {}, callback) {
    if (typeof callback !== 'function') throw unavailable('Не задан обработчик облачного запроса.');
    let client, transaction = false, callbackFailed = false, discard = false;
    try {
      client = await pool.connect();
      await ensureWorkspace(client);
      if (readOnly) {
        const result = await client.query('SELECT payload FROM cqa_workspaces WHERE id = $1', [workspaceId]);
        try { return await store.withSnapshot(workingSnapshot(result), { readOnly: true }, callback); }
        catch (error) { callbackFailed = true; throw error; }
      }
      await client.query('BEGIN');
      transaction = true;
      await client.query("SELECT set_config('lock_timeout', $1, true)", [`${lockTimeoutMs}ms`]);
      const result = await client.query('SELECT payload FROM cqa_workspaces WHERE id = $1 FOR UPDATE', [workspaceId]);
      const snapshot = workingSnapshot(result);
      let response;
      try { response = await store.withSnapshot(snapshot, { readOnly: false }, callback); }
      catch (error) { callbackFailed = true; throw error; }
      await client.query('UPDATE cqa_workspaces SET payload = $2::json, revision = revision + 1, updated_at = now() WHERE id = $1', [workspaceId, JSON.stringify(snapshot)]);
      await client.query('COMMIT');
      transaction = false;
      return response;
    } catch (error) {
      discard = !callbackFailed;
      if (transaction && client) {
        try { await client.query('ROLLBACK'); }
        catch (_) { discard = true; }
      }
      // Domain/API errors already carry a safe public message and HTTP status.
      // Database failures never expose connection strings or provider messages.
      if (callbackFailed) throw error;
      throw unavailable();
    } finally {
      if (client) {
        try { client.release(discard); }
        catch (_) { /* The response must not leak driver errors on cleanup. */ }
      }
    }
  };
}

let defaultAdapter;
function withCloudStore(options, callback) {
  if (!defaultAdapter) {
    const connectionString = process.env.CQA_DATABASE_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!connectionString) throw unavailable('Для Vercel настройте CQA_DATABASE_URL или DATABASE_URL.');
    try {
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000, allowExitOnIdle: true, application_name: 'freedom-cqa' });
      // Idle client errors must not terminate a healthy request or reveal secrets.
      pool.on('error', () => {});
      defaultAdapter = createCloudStore({ pool, workspaceId: process.env.CQA_WORKSPACE_ID || 'midnight-commit' });
    } catch (_) { throw unavailable('Не удалось настроить подключение к облачному хранилищу.'); }
  }
  return defaultAdapter(options, callback);
}

module.exports = { createCloudStore, withCloudStore };

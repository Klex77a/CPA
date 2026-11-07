'use strict';
/** Opt-in, disposable PostgreSQL verification. Default invocation does not read
 * credentials, import application configuration, or contact any service.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseEnv } = require('node:util');
const Module = require('node:module');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const KIND = 'cqa_disposable_postgres_concurrency_check';
const WORKSPACE_PATTERN =
  /^qa-concurrency-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function parseArgs(args) {
  const options = { live: false, envFile: null, out: null };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--live') options.live = true;
    else if (
      ['--database-config', '--out'].includes(argument) &&
      args[index + 1] &&
      !args[index + 1].startsWith('--')
    ) {
      const field = argument === '--database-config' ? 'envFile' : 'out';
      if (options[field]) throw new Error('Repeated argument');
      options[field] = args[++index];
    } else throw new Error('Unknown or incomplete argument');
  }
  if (options.live && !options.envFile) throw new Error('--live requires an explicit --database-config');
  return options;
}

function privateReportPath(file, root = ROOT, inspect = true) {
  const allowed = path.join(root, 'output', 'private');
  const resolved = path.resolve(file);
  const relative = path.relative(allowed, resolved);
  if (
    !relative ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    path.extname(resolved) !== '.json'
  )
    throw new Error('Report must be a JSON file inside output/private');
  if (inspect) {
    const segments = path.relative(root, resolved).split(path.sep);
    for (let index = 1; index <= segments.length; index++) {
      const current = path.join(root, ...segments.slice(0, index));
      try {
        if (fs.lstatSync(current).isSymbolicLink())
          throw new Error('Report path must not contain a symlink or junction');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  return resolved;
}

function writeReport(file, report) {
  const target = privateReportPath(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  privateReportPath(target);
  fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n', {
    encoding: 'utf8',
    flag: 'wx',
  });
}

async function verify(options) {
  assert.ok(options.live && options.envFile, 'Explicit network opt-in required');
  const workspaceId = 'qa-concurrency-' + crypto.randomUUID();
  assert.ok(WORKSPACE_PATTERN.test(workspaceId) && workspaceId !== 'midnight-commit');
  const parsed = parseEnv(fs.readFileSync(path.resolve(options.envFile), 'utf8'));
  const connectionString = parsed.DATABASE_URL || parsed.CQA_DATABASE_URL || parsed.POSTGRES_URL;
  for (const key of Object.keys(parsed)) delete parsed[key];
  assert.ok(typeof connectionString === 'string' && /^postgres(?:ql)?:\/\//.test(connectionString));
  const sourceFiles = [
    'scripts/check-cloud-concurrency.js',
    'src/cloud-store.js',
    'src/cloud-evaluation.js',
    'src/cloud-batch.js',
    'src/store.js',
  ];
  const sourceHashes = Object.fromEntries(
    sourceFiles.map((file) => [
      file,
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(ROOT, file)))
        .digest('hex'),
    ]),
  );
  const configFile = path.join(ROOT, 'src', 'config.js');
  assert.equal(require.cache[configFile], undefined, 'Run this verifier in a separate process');
  process.env.CQA_STORAGE_DRIVER = 'postgres';
  // The production adapter needs a store/config module, but must never load the
  // repository .env or any provider. Supply a minimal synthetic configuration.
  const isolatedConfig = new Module(configFile, module);
  isolatedConfig.filename = configFile;
  isolatedConfig.loaded = true;
  isolatedConfig.exports = {
    ROOT,
    CLOUD_MODE: true,
    DATA_DIR: path.join(ROOT, '.vercel', workspaceId),
    provider: 'mock',
    model: 'synthetic-concurrency-check',
    keys: {},
  };
  require.cache[configFile] = isolatedConfig;
  global.fetch = async () => {
    throw new Error('Provider fetch is forbidden in this verifier');
  };
  const { Pool } = require('pg');
  const store = require('../src/store');
  const { createCloudStore } = require('../src/cloud-store');
  const { createCloudEvaluation } = require('../src/cloud-evaluation');
  const { createCloudBatch } = require('../src/cloud-batch');
  const pool = new Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 10000,
    statement_timeout: 10000,
    query_timeout: 15000,
    idleTimeoutMillis: 1000,
    application_name: 'cqa-disposable-concurrency-check',
  });
  pool.on('error', () => {});
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const defer = () => {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const releases = [],
    pendingWork = [];
  let gate,
    calls = 0,
    phase = 'schema_guard',
    cleanup = false;
  const timings = {};
  async function bounded(promise, ms, label) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(label)), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const run = createCloudStore({ pool, workspaceId });
  const transact = (callback) => run({}, callback);
  const cacheKey = (record, rules) => digest({ record, rules });
  const evaluate = async (record, rules, group, evaluationOptions) => {
    calls++;
    const captured = gate;
    captured.entered.resolve();
    await captured.release.promise;
    return {
      id: 'qa-result-' + crypto.randomUUID(),
      group_id: group,
      conversation_id: record.conversation_id,
      status: 'ok',
      cache_key: cacheKey(record, rules),
      transcript_hash: digest(record.transcript).slice(0, 16),
      record_snapshot: clone(record),
      checklist_snapshot: clone(rules),
      checklist: { id: rules.id, version: rules.version },
      language: record.language,
      channel: record.channel,
      created_at: new Date().toISOString(),
      cost_usd: 0,
      duration_ms: 0,
      appeals: [],
      operation_id: evaluationOptions.operation_id,
    };
  };
  const dependencies = { store, transact, cacheKey, evaluate, pendingResults: new Map() };
  const records = [0, 1].map((index) => ({
    conversation_id: 'disposable-' + index,
    language: 'RU',
    channel: 'agent chat',
    transcript: [
      { speaker: 'client', timestamp: '00:00', text: 'Synthetic concurrency fixture ' + index },
    ],
  }));
  try {
    const schema = await pool.query(
      "SELECT format_type(a.atttypid, a.atttypmod) AS payload_type FROM pg_attribute AS a WHERE a.attrelid = 'cqa_workspaces'::regclass AND a.attname = 'payload' AND NOT a.attisdropped",
    );
    assert.equal(
      schema.rows[0]?.payload_type,
      'json',
      'The verifier must not migrate a shared schema',
    );
    phase = 'seed_disposable_workspace';
    await transact(() => store.write('datasets', 'QA_ONLY', { group_id: 'QA_ONLY', records }));
    phase = 'external_evaluation_without_lock';
    gate = { entered: defer(), release: defer() };
    releases.push(gate.release);
    const service = createCloudEvaluation(dependencies);
    const work = service.perform({
      group_id: 'QA_ONLY',
      conversation_id: records[0].conversation_id,
      force: true,
      request_id: crypto.randomUUID(),
    });
    work.catch(() => {});
    pendingWork.push(work);
    await bounded(gate.entered.promise, 10000, 'model entry timeout');
    const started = Date.now();
    await bounded(
      transact(() =>
        store.write('jobs', 'qa-concurrent-edit', {
          id: 'qa-concurrent-edit',
          value: 'committed while model waits',
        }),
      ),
      4000,
      'mutation blocked by model',
    );
    timings.mutation_while_model_waits_ms = Date.now() - started;
    gate.release.resolve();
    const result = await work;
    await run({ readOnly: true }, () => {
      assert.equal(store.read('jobs', 'qa-concurrent-edit').value, 'committed while model waits');
      assert.ok(store.read('evaluations', result.id));
    });
    phase = 'cancel_during_model_wait';
    gate = { entered: defer(), release: defer() };
    releases.push(gate.release);
    const batch = createCloudBatch(dependencies);
    const job = await transact(() => batch.createBatch({ group_id: 'QA_ONLY', force: true }));
    const step = batch.stepBatch(job.id);
    step.catch(() => {});
    pendingWork.push(step);
    await bounded(gate.entered.promise, 10000, 'batch model entry timeout');
    const cancelStarted = Date.now();
    const cancelled = await bounded(
      transact(() => batch.cancelBatch(job.id)),
      4000,
      'cancel blocked by model',
    );
    timings.cancel_while_model_waits_ms = Date.now() - cancelStarted;
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.counts.cancelled, 1);
    gate.release.resolve();
    const completed = await step;
    assert.equal(completed.status, 'cancelled');
    assert.equal(completed.counts.done, 1);
    assert.equal(completed.counts.cancelled, 1);
    const before = calls;
    await batch.stepBatch(job.id);
    assert.equal(calls, before);
    assert.equal(calls, 2);
    assert.equal(require.cache[path.join(ROOT, 'src', 'evaluator.js')], undefined);
    assert.equal(require.cache[path.join(ROOT, 'src', 'llm.js')], undefined);
    phase = 'verified';
  } catch (_) {
    // Database diagnostics may contain hostnames or credentials. Only a fixed
    // phase and sanitized counters leave this verifier, including on failure.
  } finally {
    for (const release of releases) release.resolve();
    await Promise.allSettled(pendingWork);
    assert.ok(WORKSPACE_PATTERN.test(workspaceId) && workspaceId !== 'midnight-commit');
    try {
      await pool.query("DELETE FROM cqa_workspaces WHERE id = $1 AND id LIKE 'qa-concurrency-%'", [
        workspaceId,
      ]);
      const remaining = await pool.query(
        'SELECT count(*)::int AS count FROM cqa_workspaces WHERE id = $1',
        [workspaceId],
      );
      cleanup = remaining.rows[0].count === 0;
    } catch (_) {
      /* Report cleanup failure without leaking driver diagnostics. */
    }
    await pool.end();
  }
  return {
    kind: KIND,
    schema_version: '1.0',
    generated_at: new Date().toISOString(),
    mode: 'live',
    ok: phase === 'verified' && cleanup,
    phase,
    real_postgres: true,
    provider_requests: 0,
    synthetic_evaluations: calls,
    ...timings,
    disposable_workspace_removed: cleanup,
    source_hashes: sourceHashes,
    limitations: [
      'Uses synthetic deferred evaluation; provider latency, billing and model quality are not tested.',
      'Checks one disposable workspace; production conversations and scores are not modified.',
    ],
  };
}

async function main(args = process.argv.slice(2)) {
  try {
    const options = parseArgs(args);
    if (options.out) privateReportPath(options.out, ROOT, false);
    if (!options.live) {
      console.log(
        JSON.stringify({
          kind: KIND,
          mode: 'dry_run',
          database_contacted: false,
          credentials_read: false,
          provider_requests: 0,
          required_to_run: ['--live', '--database-config <private-env-file>'],
          optional_report: '--out output/private/<report>.json',
        }),
      );
      return 0;
    }
    if (options.out) privateReportPath(options.out);
    const report = await verify(options);
    if (options.out) writeReport(options.out, report);
    console.log(JSON.stringify(report));
    return report.ok ? 0 : 1;
  } catch (_) {
    console.error(
      JSON.stringify({
        kind: KIND,
        ok: false,
        phase: 'arguments_or_private_io',
        provider_requests: 0,
        message:
          'Check explicit arguments, private paths, credentials file and database access. Details are intentionally withheld.',
      }),
    );
    return 2;
  }
}

if (require.main === module)
  main().then((code) => {
    process.exitCode = code;
  });
module.exports = { main, parseArgs, privateReportPath };

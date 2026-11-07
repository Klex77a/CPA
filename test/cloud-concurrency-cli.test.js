'use strict';
// Safety gates only. This suite never reads credentials or contacts PostgreSQL.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { parseArgs, privateReportPath } = require('../scripts/check-cloud-concurrency');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-concurrency-cli-'));
try {
  assert.deepEqual(parseArgs([]), { live: false, envFile: null, out: null });
  for (const args of [['--live'], ['--database-config'], ['--workspace', 'midnight-commit'], ['--database-config', 'one', '--database-config', 'two'], ['--unknown']]) assert.throws(() => parseArgs(args));
  assert.equal(parseArgs(['--live', '--database-config', 'explicit-private.env']).live, true);
  const preload = path.join(temporary, 'forbid-network.cjs');
  fs.writeFileSync(preload, "const Module=require('node:module');const load=Module._load;Module._load=function(id,...args){if(id==='pg'||/src[\\\\/](?:config|evaluator|llm)(?:\\.js)?$/.test(id))throw new Error('Network/config import forbidden in a dry run');return load.call(this,id,...args);};");
  const invoke = (args) => spawnSync(process.execPath, ['--require', preload, 'scripts/check-cloud-concurrency.js', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, CQA_DATABASE_URL: 'invalid-never-contact', LLM_PROVIDER: 'mock' } });
  const nonexistent = path.join(temporary, 'missing-credentials.env');
  for (const args of [[], ['--database-config', nonexistent]]) {
    const result = invoke(args);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'dry_run'); assert.equal(report.credentials_read, false); assert.equal(report.database_contacted, false); assert.equal(report.provider_requests, 0);
  }
  for (const args of [['--live'], ['--live', '--database-config', nonexistent], ['--out', 'results/prod/results.json'], ['--out', path.join(temporary, 'outside.json')]]) {
    const result = invoke(args);
    assert.equal(result.status, 2);
    assert.ok(!result.stderr.includes('invalid-never-contact'));
    assert.equal(JSON.parse(result.stderr).provider_requests, 0);
  }
  const fakeRoot = path.join(temporary, 'workspace');
  const allowed = path.join(fakeRoot, 'output', 'private', 'proof.json');
  assert.equal(privateReportPath(allowed, fakeRoot), allowed);
  assert.throws(() => privateReportPath(path.join(fakeRoot, 'output', 'private', '..', 'public.json'), fakeRoot));
  assert.throws(() => privateReportPath(path.join(fakeRoot, 'output', 'private', 'proof.txt'), fakeRoot));
  fs.mkdirSync(path.join(fakeRoot, 'output'), { recursive: true });
  const elsewhere = path.join(temporary, 'elsewhere'); fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(fakeRoot, 'output', 'private'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => privateReportPath(allowed, fakeRoot), /symlink|junction/);
  console.log('cloud-concurrency-cli: dry-run network gates, explicit credentials and private report paths — PASS');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }

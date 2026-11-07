'use strict';
// Deployment contract: every public URL reaches authentication, and private
// local artifacts cannot accidentally enter the upload allowlist.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
assert.equal(config.framework, null);
assert.equal(config.buildCommand, 'npm run build', 'the deployment must compile the React application');
assert.equal(config.outputDirectory, 'dist');
assert.ok(config.functions['api/index.js'].includeFiles.includes('dist/**'), 'the protected function must contain the compiled assets');
assert.ok(config.functions['api/index.js'].maxDuration <= 180);
assert.ok(!config.routes.some((route) => route.handle === 'filesystem'), 'static files must not bypass the protected handler');
for (const url of ['/', '/index.html', '/assets/index-example.mjs', '/assets/index-example.css', '/assets/freedom-mark.svg', '/demo-sample.json', '/api/config', '/api/batch/job/step', '/results/dev/results.json', '/.env']) {
  const route = config.routes.find((item) => item.src && new RegExp('^(?:' + item.src + ')$').test(url));
  assert.equal(route?.dest, '/api/index', url + ' must pass through the same authenticated handler');
}
const clientModules = fs.readdirSync(path.join(root, 'dist', 'assets')).filter((name) => /\.m?js$/.test(name));
assert.ok(clientModules.length > 0, 'run npm run build before the deployment checks');
assert.ok(clientModules.every((name) => name.endsWith('.mjs')), 'browser modules must use .mjs to avoid the Node builder CommonJS transform');

const handler = () => {};
const exported = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'api', 'index.js'), 'utf8'), {
  module: exported,
  require: (name) => { assert.equal(name, '../server'); return { handler }; },
});
assert.equal(exported.exports, handler, 'the function entry must delegate to the shared handler without starting a listener');

// Vercel documents gitignore-compatible rules. Exercise those rules using Git's
// parser in a separate temporary repository, never the user's index or data.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-vercel-package-'));
const git = (...args) => spawnSync('git', ['-c', 'core.excludesFile=', '-c', 'core.ignoreCase=false', ...args], { cwd: sandbox, encoding: 'utf8' });
const initialized = git('init', '--quiet');
assert.equal(initialized.status, 0, initialized.stderr);
fs.writeFileSync(path.join(sandbox, '.gitignore'), fs.readFileSync(path.join(root, '.vercelignore')));
const allowed = [
  'package.json', 'package-lock.json', 'vercel.json', 'vite.config.mts', 'server.js', 'api/index.js',
  'src/config.js', 'src/cloud-store.js', 'public/assets/manrope.css',
  'web/index.html', 'web/tsconfig.json', 'web/src/main.tsx', 'web/src/pages/CardPage.tsx',
  'docs/DEMO_SCRIPT.md', 'docs/benchmark-results/latest.json',
  'test/fixtures/benchmark-cases.json', 'results/dev/results.json', 'results/prod/results.json',
];
// CLI 65's native walker evaluates ancestor directory paths without a trailing
// slash. Git's file-only check below accepted !api/ even when the CLI pruned api.
// Keep explicit path-only negations for every ancestor in this upload allowlist.
const ignoreRules = fs.readFileSync(path.join(root, '.vercelignore'), 'utf8').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
const ancestors = new Set(allowed.flatMap((relative) => {
  const parts = relative.split('/');
  return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join('/'));
}));
for (const directory of ancestors) {
  // Children of wholly allowed runtime trees need no further exception.
  const ignoredByParentRule = ignoreRules.some((rule) => !rule.startsWith('!') && (rule === '/*' && !directory.includes('/') || rule === directory.slice(0, directory.lastIndexOf('/')) + '/*'));
  if (ignoredByParentRule) assert.ok(ignoreRules.includes('!' + directory), directory + ' needs a slashless native-walker allow rule');
}
for (const rule of ignoreRules) assert.ok(!rule.endsWith('/'), 'directory rules must also match native CLI path strings: ' + rule);
const privatePaths = [
  '.env', '.env.production', '.vercel/project.json', '.cache/package.json', '.codex/settings.json',
  'data/datasets/DEV.json', 'data/evaluations/private.json', 'tmp/qa-report.json',
  'output/benchmark/latest.json', 'test-artifacts/screenshot.png',
  'src/.env.local', 'src/state.tmp', 'node_modules/pg/package.json',
  'test/fixtures/unreviewed.json', 'docs/benchmark-results/baseline.json', 'results/dev/private-copy.json',
  'public/node_modules/private.js', 'src/.vercel/auth.json', 'public/.cache/private.json',
  'web/.env.local', 'web/src/.env', 'web/node_modules/private.js', 'web/.cache/private.json',
  'dist/assets/stale-local-build.js',
];
for (const relative of [...allowed, ...privatePaths]) {
  const location = path.join(sandbox, relative);
  fs.mkdirSync(path.dirname(location), { recursive: true });
  fs.writeFileSync(location, 'fixture');
}
const ignored = spawnSync('git', ['-c', 'core.excludesFile=', '-c', 'core.ignoreCase=false', 'check-ignore', '--no-index', '--stdin'], {
  cwd: sandbox, encoding: 'utf8', input: [...allowed, ...privatePaths].join('\n') + '\n',
});
assert.equal(ignored.status, 0, ignored.stderr);
const ignoredPaths = new Set(ignored.stdout.trim().split(/\r?\n/));
for (const relative of allowed) assert.ok(!ignoredPaths.has(relative), relative + ' is required at runtime');
for (const relative of privatePaths) assert.ok(ignoredPaths.has(relative), relative + ' must stay outside the deployment');
console.log('vercel-package: protected routing, shared entry, runtime allowlist and private artifact exclusions — PASS');

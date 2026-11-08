'use strict';
// Default is validation only. A paid run always needs both --live and --out.
const fs = require('fs');
const path = require('path');
const fixtures = { regression: require('../test/fixtures/benchmark-cases.json'), challenge: require('../test/fixtures/benchmark-challenge-cases.json') };
const checklist = require('../src/default-checklist.json');
const { validateBenchmarkCases, buildBenchmarkReport, referenceCoverage, digest } = require('../src/benchmark');
const { openJournal } = require('../src/benchmark-journal');

function parseArgs(args) {
  const options = { live: false, plan: false, out: null, from: null, concurrency: 1, suite: 'regression' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--live') options.live = true;
    else if (arg === '--resume') options.resume = true;
    else if (arg === '--plan') options.plan = true;
    else if (['--out', '--from', '--concurrency', '--suite'].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = args[++i];
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  options.concurrency = Number(options.concurrency);
  if (!Object.hasOwn(fixtures, options.suite)) throw new Error('--suite must be regression or challenge');
  if (![1, 2].includes(options.concurrency)) throw new Error('--concurrency must be 1 or 2');
  if (options.live && options.from) throw new Error('--live and --from are mutually exclusive');
  if (options.plan && (options.live || options.from || options.out)) throw new Error('--plan is read-only and cannot be combined with --live, --from or --out');
  if ((options.live || options.from) && !options.out) throw new Error('--live/--from require --out <report.json>');
  if (options.resume && !options.live) throw new Error('--resume requires --live and the original --out');
  if (!options.live && !options.from && options.out) throw new Error('--out requires --live or --from; dry-run does not create a report');
  return options;
}

function writeReport(file, report) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temp = `${resolved}.${process.pid}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(report, null, 2) + '\n', 'utf8'); fs.renameSync(temp, resolved); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  console.log(`Report saved: ${path.relative(process.cwd(), resolved)}`);
}

function assertOutputTarget(file, fixture) {
  if (!fs.existsSync(file)) return;
  const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (existing.kind === 'engineering_reference_benchmark' && existing.dataset?.digest !== digest(fixture)) throw new Error('Output belongs to a different reference suite/version. Use a separate report path; historical regression evidence must stay readable.');
}

function runPlan(fixture, options) {
  // Only operational config is read; no provider adapter/evaluator or network call is initialized.
  const cfg = require('../src/config');
  const samples = cfg.provider === 'mock' ? 1 : cfg.SAMPLES;
  const base = fixture.cases.length * samples;
  const repaired = base * (cfg.REPAIR_ATTEMPTS + 1);
  const historical = require('../docs/benchmark-results/latest.json').metrics.cost;
  return {
    provider: cfg.provider, model: cfg.model, samples, concurrency: options.concurrency,
    timeout_ms: cfg.LLM_TIMEOUT_MS, max_http_attempts_per_model_call: cfg.LLM_MAX_ATTEMPTS, repair_attempts: cfg.REPAIR_ATTEMPTS,
    base_model_calls: base, max_model_calls_including_repairs: repaired, max_http_attempts_including_retries: repaired * cfg.LLM_MAX_ATTEMPTS,
    configured_prices_usd_per_million: { input: cfg.PRICE_IN_PER_M, output: cfg.PRICE_OUT_PER_M },
    historical_short_regression_reference: { per_dialog_usd: historical.mean_per_observed_case_usd, scaled_to_case_count_usd: historical.mean_per_observed_case_usd * fixture.cases.length, applicability: 'Historical reference only. Long challenge transcripts, current prices, thinking tokens, retries and repairs can cost more. This is not a spending cap or provider quote.' },
    api_calls_performed: 0, paid_run_authorized: false,
  };
}

function printSummary(report) {
  const m = report.metrics;
  console.log(`Engineering reference (not independent expert / DEV accuracy): ${m.criterion_match.matched}/${m.criterion_match.total} exact criterion matches; ${m.cases.failed} failed, ${m.cases.invalid} invalid cases.`);
  const cost = m.cost.total_usd == null ? `known usage ≈ $${(m.cost.known_total_usd || 0).toFixed(6)}; total unknown` : `observed ≈ $${m.cost.total_usd.toFixed(6)}`;
  console.log(`Critical: TP=${m.critical.tp}, FP=${m.critical.fp}, FN=${m.critical.fn}, unknown=${m.critical.unknown}. Cost coverage ${m.cost.observed_count}/${m.cases.total}, ${cost}.`);
}

function failureCode(error) {
  if (typeof error?.code === 'string' && /^(?:LLM_)?(?:HTTP_[1-5]\d\d|TIMEOUT|NETWORK|INVALID_JSON|EMPTY|EVALUATION_FAILED)$/.test(error.code)) return error.code;
  if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) return `HTTP_${error.status}`;
  return ({ timeout: 'TIMEOUT', network: 'NETWORK', invalid_json: 'INVALID_JSON', empty: 'EMPTY' })[error?.status] || 'EVALUATION_FAILED';
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) { console.log('Validate (no API/config): node scripts/benchmark.js [--suite regression|challenge]\nCost scope (config read, no API): node scripts/benchmark.js --suite challenge --plan [--concurrency 1|2]\nLive: node scripts/benchmark.js --suite challenge --live --out output/benchmark/challenge-latest.json [--concurrency 1|2]\nResume: same live command with --resume (pending cases only, ambiguous dispatches are never retried)\nOffline: node scripts/benchmark.js --suite challenge --from outcomes.json --out output/benchmark/challenge-replay.json'); return 0; }
  const fixture = fixtures[options.suite];
  const errors = validateBenchmarkCases(fixture, checklist);
  if (errors.length) throw new Error(errors.join('\n'));
  if (!options.live && !options.from) {
    console.log(`VALID: ${fixture.cases.length} synthetic engineering reference cases, ${fixture.cases.length * checklist.criteria.length} labels. No API calls. Fixture SHA-256: ${digest(fixture)}`);
    console.log(JSON.stringify({ suite: options.suite, provenance: fixture.provenance, independent_expert_validation: false, coverage: referenceCoverage(fixture, checklist), run_scope: { source_dialogs: fixture.cases.length, calls_per_sample_without_repair_or_retries: fixture.cases.length, concurrency: options.concurrency, labels_fixed_before_live_run: true, cost_status: 'not_measured', cost_note: 'No model run is authorized or performed by validation. Cost depends on token lengths, configured samples, repair and HTTP retries; short-regression observed costs are not a quote for long challenge cases.' }, ...(options.plan ? { configured_run_plan: runPlan(fixture, options) } : {}) }, null, 2));
    return 0;
  }
  const started = new Date().toISOString();
  assertOutputTarget(options.out, fixture);
  let outcomes, metadata;
  if (options.from) {
    const input = JSON.parse(fs.readFileSync(options.from, 'utf8'));
    outcomes = Array.isArray(input) ? input : input.outcomes;
    if (!Array.isArray(outcomes)) throw new Error('--from must contain an outcomes array (case_id + original evaluation or error)');
    const evaluations = outcomes.map((o) => o.evaluation).filter(Boolean);
    const unique = (key) => [...new Set(evaluations.map((ev) => ev[key]).filter(Boolean))];
    metadata = { mode: 'offline', started_at: started, finished_at: new Date().toISOString(), identity_source: 'input_evaluations_unverified', providers: unique('provider'), models: unique('model'), prompt_versions: unique('prompt_version') };
  } else {
    if (!options.resume && fs.existsSync(options.out)) throw new Error('Live output already exists; use a new path for a separately authorized run');
    // Kept below the explicit gate so dry-run/offline do not read credentials or initialize a provider.
    const cfg = require('../src/config');
    if (cfg.provider === 'mock') throw new Error('Live benchmark requires a configured real model; mock results are not quality evidence');
    const { evaluate, PROMPT_VERSION, settingsFingerprint, runtimeFingerprint } = require('../src/evaluator');
    const fingerprint = settingsFingerprint();
    metadata = {
      mode: 'live', started_at: started, provider: cfg.provider, model: cfg.model, prompt_version: PROMPT_VERSION, concurrency: options.concurrency,
      settings_fingerprint: fingerprint,
      runtime_fingerprint: { ...runtimeFingerprint(), execution_mode: 'direct-benchmark', concurrency: options.concurrency },
      runtime_environment_mode: runtimeFingerprint().execution_mode,
      execution_path: 'direct_evaluator_not_deployed_http_workflow',
      runtime_concurrency_source: 'benchmark_driver_override',
      suite: options.suite,
      settings: { samples: cfg.SAMPLES, temperature: cfg.TEMPERATURE, thinking: fingerprint.thinking, structured_output: cfg.STRUCTURED_OUTPUT, repair_attempts: cfg.REPAIR_ATTEMPTS, max_output_tokens: cfg.MAX_OUTPUT_TOKENS, llm_timeout_ms: cfg.LLM_TIMEOUT_MS, llm_max_attempts: cfg.LLM_MAX_ATTEMPTS, price_in_per_m: cfg.PRICE_IN_PER_M, price_out_per_m: cfg.PRICE_OUT_PER_M },
    };
    // Bind recovery to the exact evaluator implementation as well as the rubric
    // and settings. A forgotten version bump must not mix two implementations.
    const sourceFiles = ['evaluator.js', 'evaluation-prompt.js', 'llm.js', 'scoring.js', 'benchmark.js', 'benchmark-journal.js'];
    const identity = { fixture: digest(fixture), checklist: digest(checklist), metadata: { ...metadata, started_at: null }, source: digest([...sourceFiles.map(file => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')), fs.readFileSync(__filename, 'utf8')]) };
    const journal = openJournal(options.out + '.journal.json', { identity, metadata, caseIds: fixture.cases.map(c => c.id), resume: options.resume });
    metadata = journal.metadata;
    const pending = journal.pending().map(id => fixture.cases.find(c => c.id === id));
    let cursor = 0;
    let checkpointFailure = null;
    try {
      const workers = await Promise.allSettled(Array.from({ length: options.concurrency }, async () => {
        try {
          while (!checkpointFailure && cursor < pending.length) {
            const c = pending[cursor++], t0 = Date.now();
            journal.dispatch(c.id);
            let outcome;
            try { outcome = { case_id: c.id, evaluation: await evaluate(c.record, checklist, 'BENCHMARK', { force: true }) }; }
            catch (error) {
              const observed = error.evaluation_metrics || {};
              const status = error.status;
              const safeStatus = (Number.isInteger(status) && status >= 100 && status <= 599) || ['timeout', 'network', 'invalid_json', 'empty'].includes(status);
              const billing = Object.fromEntries(['billing_complete', 'unknown_call_count', 'known_usage', 'known_cost_usd'].filter(key => Object.hasOwn(observed, key)).map(key => [key, observed[key]]));
              outcome = { case_id: c.id, error: { code: failureCode(error), ...(safeStatus ? { status } : {}) }, duration_ms: observed.duration_ms ?? Date.now() - t0, timing: observed.timing || null, usage: observed.usage || null, cost_usd: observed.cost_usd ?? null, ...billing };
              console.log(`FAILED ${c.id}: ${outcome.error.code}`);
            }
            journal.finish(outcome);
          }
        } catch (error) { checkpointFailure = error; throw error; }
      }));
      const failed = workers.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      outcomes = journal.outcomes();
      metadata.finished_at = new Date().toISOString();
    } finally { journal.close(); }
  }
  const report = buildBenchmarkReport(fixture, outcomes, metadata, checklist);
  writeReport(options.out, report);
  printSummary(report);
  return report.metrics.criterion_match.matched === report.metrics.criterion_match.total && !report.metrics.cases.invalid && !report.metrics.cases.failed ? 0 : 1;
}

if (require.main === module) main().then((code) => { process.exitCode = code; }).catch((error) => {
  // Local parse/fixture errors only. Provider failures are captured as safe per-case codes above.
  console.error(`Benchmark: ${error.message}`); process.exitCode = 2;
});
module.exports = { parseArgs, main, runPlan, assertOutputTarget, failureCode };

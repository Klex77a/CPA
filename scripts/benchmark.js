'use strict';
// Default is validation only. A paid run always needs both --live and --out.
const fs = require('fs');
const path = require('path');
const fixture = require('../test/fixtures/benchmark-cases.json');
const checklist = require('../src/default-checklist.json');
const { validateBenchmarkCases, buildBenchmarkReport, digest } = require('../src/benchmark');

function parseArgs(args) {
  const options = { live: false, out: null, from: null, concurrency: 1 };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--live') options.live = true;
    else if (['--out', '--from', '--concurrency'].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = args[++i];
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  options.concurrency = Number(options.concurrency);
  if (![1, 2].includes(options.concurrency)) throw new Error('--concurrency must be 1 or 2');
  if (options.live && options.from) throw new Error('--live and --from are mutually exclusive');
  if ((options.live || options.from) && !options.out) throw new Error('--live/--from require --out <report.json>');
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

function printSummary(report) {
  const m = report.metrics;
  console.log(`Engineering reference (not independent expert / DEV accuracy): ${m.criterion_match.matched}/${m.criterion_match.total} exact criterion matches; ${m.cases.failed} failed, ${m.cases.invalid} invalid cases.`);
  console.log(`Critical: TP=${m.critical.tp}, FP=${m.critical.fp}, FN=${m.critical.fn}, unknown=${m.critical.unknown}. Cost coverage ${m.cost.observed_count}/${m.cases.total}, observed $${m.cost.total_usd.toFixed(6)}.`);
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) { console.log('Validate: node scripts/benchmark.js\nLive: node scripts/benchmark.js --live --out output/benchmark/latest.json [--concurrency 1|2]\nOffline: node scripts/benchmark.js --from outcomes.json --out output/benchmark/replay.json'); return 0; }
  const errors = validateBenchmarkCases(fixture, checklist);
  if (errors.length) throw new Error(errors.join('\n'));
  if (!options.live && !options.from) {
    console.log(`VALID: ${fixture.cases.length} synthetic engineering reference cases, ${fixture.cases.length * checklist.criteria.length} labels, 5 RU / 5 KZ / 5 EN. No API calls. Fixture SHA-256: ${digest(fixture)}`);
    return 0;
  }
  const started = new Date().toISOString();
  let outcomes, metadata;
  if (options.from) {
    const input = JSON.parse(fs.readFileSync(options.from, 'utf8'));
    outcomes = Array.isArray(input) ? input : input.outcomes;
    if (!Array.isArray(outcomes)) throw new Error('--from must contain an outcomes array (case_id + original evaluation or error)');
    const evaluations = outcomes.map((o) => o.evaluation).filter(Boolean);
    const unique = (key) => [...new Set(evaluations.map((ev) => ev[key]).filter(Boolean))];
    metadata = { mode: 'offline', started_at: started, finished_at: new Date().toISOString(), identity_source: 'input_evaluations_unverified', providers: unique('provider'), models: unique('model'), prompt_versions: unique('prompt_version') };
  } else {
    // Kept below the explicit gate so dry-run/offline do not read credentials or initialize a provider.
    const cfg = require('../src/config');
    if (cfg.provider === 'mock') throw new Error('Live benchmark requires a configured real model; mock results are not quality evidence');
    const { evaluate, PROMPT_VERSION, settingsFingerprint } = require('../src/evaluator');
    const fingerprint = settingsFingerprint();
    metadata = {
      mode: 'live', started_at: started, provider: cfg.provider, model: cfg.model, prompt_version: PROMPT_VERSION, concurrency: options.concurrency,
      settings_fingerprint: fingerprint,
      settings: { samples: cfg.SAMPLES, temperature: cfg.TEMPERATURE, thinking: fingerprint.thinking, structured_output: cfg.STRUCTURED_OUTPUT, repair_attempts: cfg.REPAIR_ATTEMPTS, max_output_tokens: cfg.MAX_OUTPUT_TOKENS, llm_timeout_ms: cfg.LLM_TIMEOUT_MS, llm_max_attempts: cfg.LLM_MAX_ATTEMPTS, price_in_per_m: cfg.PRICE_IN_PER_M, price_out_per_m: cfg.PRICE_OUT_PER_M },
    };
    outcomes = new Array(fixture.cases.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: options.concurrency }, async () => {
      while (cursor < fixture.cases.length) {
        const index = cursor++, c = fixture.cases[index], t0 = Date.now();
        try { outcomes[index] = { case_id: c.id, evaluation: await evaluate(c.record, checklist, 'BENCHMARK', { force: true }) }; }
        catch (error) {
          const observed = error.evaluation_metrics || {};
          outcomes[index] = { case_id: c.id, error: { code: String(error.code || 'EVALUATION_FAILED').replace(/[^A-Z0-9_-]/gi, '').slice(0, 80) }, duration_ms: observed.duration_ms ?? Date.now() - t0, timing: observed.timing || null, usage: observed.usage || null, cost_usd: observed.cost_usd ?? null };
          console.log(`FAILED ${c.id}: ${outcomes[index].error.code}`);
        }
      }
    }));
    metadata.finished_at = new Date().toISOString();
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
module.exports = { parseArgs, main };

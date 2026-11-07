'use strict';
const { getReadiness } = require('../src/readiness');
try {
  const report = getReadiness();
  const measured = report.benchmark.state === 'measured';
  console.log(`Контрольные примеры: ${report.benchmark.state} — ${report.benchmark.message}`);
  for (const item of report.submissions) console.log(`${item.split.toUpperCase()}: ${item.state} — ${item.message} (${item.path})`);
  console.log(`План защиты: ${report.demo.steps.reduce((sum, step) => sum + step.seconds, 0)} секунд.`);
  console.log(report.publication.message);
  if (!measured || report.submissions.some((item) => item.state !== 'ready')) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }

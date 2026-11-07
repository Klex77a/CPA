'use strict';
const fs = require('fs');
const { validateSubmission } = require('../src/result-export');

const [file, ...options] = process.argv.slice(2);
if (!file) {
  console.error('Использование: node scripts/validate-results.js results/dev/results.json --split=dev [--source=dataset.json]');
  process.exitCode = 1;
} else {
  try {
    const split = options.find((option) => option.startsWith('--split='))?.slice(8);
    if (!['dev', 'prod'].includes(split)) throw new Error('Для проверки сдачи обязателен --split=dev или --split=prod.');
    const sourceFile = options.find((option) => option.startsWith('--source='))?.slice(9);
    let records;
    if (sourceFile) {
      const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8').replace(/^\uFEFF/, ''));
      records = source.data?.records || source.records || source;
      if (!Array.isArray(records)) throw new Error('В source нет массива records.');
    }
    const output = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const errors = validateSubmission(output, { split, records });
    if (errors.length) throw new Error(errors.join('\n'));
    const failed = output.results.filter((result) => result.status === 'error').length;
    console.log(`JSON корректен: ${output.results.length} диалогов, ошибок обработки: ${failed}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

'use strict';
const { prepareSubmission } = require('../src/submission-service');
const options = process.argv.slice(2);
const value = (name) => options.find((option) => option.startsWith(`--${name}=`))?.slice(name.length + 3);
try {
  const split = value('split');
  const result = prepareSubmission({ split, groupId: value('group') || (split === 'dev' ? 'DEV' : null), teamName: value('team') || 'Midnight Commit', dryRun: options.includes('--dry-run') });
  console.log(`${result.written ? 'Сохранено' : 'Проверено без записи'}: ${result.path} · ${result.total} диалогов · готово ${result.ok} · ошибок обработки ${result.errors}`);
  if (result.errors) console.warn('Файл соответствует формату, но содержит ошибки обработки. Проверьте их перед сдачей.');
  console.log('Локальный файл ещё нужно включить в commit и push до дедлайна.');
} catch (error) { console.error(error.message); process.exitCode = 1; }

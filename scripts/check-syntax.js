'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.join(__dirname, '..');
const files = ['server.js', ...['api', 'src', 'public', 'scripts', 'test'].filter((dir) => fs.existsSync(path.join(root, dir))).flatMap((dir) => fs.readdirSync(path.join(root, dir)).filter((name) => name.endsWith('.js')).map((name) => path.join(dir, name)))];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(result.stderr || result.error?.message || file);
    process.exit(1);
  }
}
console.log(`Синтаксис проверен: ${files.length} JavaScript-файлов.`);

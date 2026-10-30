'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
let count = 0;
function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.terraform'].includes(item.name)) continue;
    const file = path.join(dir, item.name);
    if (item.isDirectory()) walk(file);
    else if (file.endsWith('.cjs')) { execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' }); count++; }
  }
}
walk(path.resolve(__dirname, '..'));
console.log(`Syntax checked ${count} CommonJS files.`);

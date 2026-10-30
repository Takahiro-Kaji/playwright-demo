'use strict';
const fs = require('node:fs');
const template = process.argv[2];
if (!template) throw new Error('Usage: node scripts/render-k8s.cjs <template>');
const allowed = new Set(['APP_IMAGE', 'MOCK_IMAGE', 'RDS_HOST']);
const rendered = fs.readFileSync(template, 'utf8').replace(/\$\{([A-Z_]+)\}/g, (_, key) => {
  if (!allowed.has(key) || !process.env[key]) throw new Error(`Missing/unsupported template variable ${key}`);
  const value = process.env[key];
  if (!/^[a-zA-Z0-9./:_-]+$/.test(value)) throw new Error(`Invalid value for ${key}`);
  return value;
});
if (/\$\{/.test(rendered)) throw new Error('Unresolved template placeholder');
process.stdout.write(rendered);

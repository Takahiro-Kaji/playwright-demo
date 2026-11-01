'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const env = {
  CERTIFICATE_ARN: 'arn:aws:acm:ap-northeast-1:123456789012:certificate/12345678-abcd',
  OPERATOR_CIDR: '198.51.100.20/32',
  USER_POOL_ARN: 'arn:aws:cognito-idp:ap-northeast-1:123456789012:userpool/ap-northeast-1_abc123',
  USER_POOL_CLIENT_ID: 'abc123', USER_POOL_DOMAIN: 'demo-auth', UI_HOST: 'ui.example.com',
};
const run = (overrides) => spawnSync(process.execPath, [path.join(__dirname, '../render-ingress.cjs')], { env: { ...process.env, ...env, ...overrides }, encoding: 'utf8' });
test('renders HTTPS authentication and the protected API route', () => {
  const result = run({});
  assert.equal(result.status, 0);
  assert.match(result.stdout, /auth-on-unauthenticated-request: authenticate/);
  assert.match(result.stdout, /auth-type: cognito/);
  assert.match(result.stdout, /path: \/\n\s+pathType: Prefix/);
  assert.doesNotMatch(result.stdout, /\$\{/);
});
test('rejects open CIDR and injected annotations', () => {
  assert.notEqual(run({ OPERATOR_CIDR: '0.0.0.0/0' }).status, 0);
  assert.notEqual(run({ UI_HOST: "evil.example'\n  injected: yes" }).status, 0);
  assert.notEqual(run({ USER_POOL_ARN: '' }).status, 0);
});

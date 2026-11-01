'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const script = path.join(__dirname, '../sso/render-ingress.cjs');
const values = { CERTIFICATE_ARN: 'arn:aws:acm:ap-northeast-1:123456789012:certificate/abcdef12-1234-1234-1234-abcdef123456', OPERATOR_CIDR: '192.0.2.0/24', USER_POOL_ARN: 'arn:aws:cognito-idp:ap-northeast-1:123456789012:userpool/ap-northeast-1_abcdef', USER_POOL_CLIENT_ID: 'abc123', USER_POOL_DOMAIN: 'demo-domain', UI_HOST: 'sales.example.com' };
const render = (env) => spawnSync(process.execPath, [script], { env: { ...process.env, ...env }, encoding: 'utf8' });
test('HTTPS ingress requires Cognito authentication for the entire application', () => {
  const result = render(values); assert.equal(result.status, 0);
  assert.match(result.stdout, /auth-type: cognito/); assert.match(result.stdout, /auth-on-unauthenticated-request: authenticate/);
  assert.match(result.stdout, /listen-ports: '\[{"HTTPS":443}\]'/); assert.match(result.stdout, /path: \/\n\s+pathType: Prefix/);
  assert.match(result.stdout, /host: 'sales\.example\.com'/); assert.doesNotMatch(result.stdout, /\$\{/);
});
test('rejects malformed host, ARN, CIDR and injection', () => {
  for (const overrides of [{ UI_HOST: 'example.com\nfoo: bar' }, { CERTIFICATE_ARN: 'invalid' }, { OPERATOR_CIDR: '0.0.0.0/0' }, { USER_POOL_DOMAIN: 'a"}' }]) {
    assert.notEqual(render({ ...values, ...overrides }).status, 0);
  }
});

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
const env = {
  CERTIFICATE_ARN:'arn:aws:acm:ap-northeast-1:123456789012:certificate/abcdef01-1234-1234-1234-123456789012',
  OPERATOR_CIDR:'192.0.2.1/32', USER_POOL_ARN:'arn:aws:cognito-idp:ap-northeast-1:123456789012:userpool/ap-northeast-1_example',
  USER_POOL_CLIENT_ID:'abc123', USER_POOL_DOMAIN:'example', UI_HOST:'sales.example.test',
};
function render(runId: string) {
  return spawnSync(process.execPath,['aws/sso/render-ingress.cjs'],{encoding:'utf8',env:{...process.env,...env,SALES_RUN_ID:runId}});
}
test('SSO ingress and app resolve to the same run namespace', () => {
  const id='0123456789abcdef0123456789abcdef';
  const r=render(id);
  assert.equal(r.status,0);
  assert.match(r.stdout,new RegExp(`namespace: sales-test-${id}`));
  assert.match(r.stdout,/name: sales-app/);
  assert.match(r.stdout,/host: 'sales\.example\.test'/);
});
test('SSO ingress preserves the default and rejects invalid identifiers', () => {
  const standard=render('');
  assert.equal(standard.status,0);
  assert.match(standard.stdout,/namespace: integration-demo/);
  assert.notEqual(render('../unsafe').status,0);
});

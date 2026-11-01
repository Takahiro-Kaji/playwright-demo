import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';

const base = {SALES_IMAGE:'123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/sales:latest', DB_HOST:'example.ap-northeast-1.rds.amazonaws.com'};
function render(extra: Record<string,string>) {
  return spawnSync(process.execPath, ['aws/render-sales.cjs'], {env:{...process.env,...base,...extra},encoding:'utf8'});
}
test('生成設定でアプリとバッチを同じ専用スキーマ・名前空間に結び付ける', () => {
  const id = '0123456789abcdef0123456789abcdef';
  const result = render({SALES_RUN_ID:id});
  assert.equal(result.status,0);
  assert.match(result.stdout,new RegExp(`name: sales-test-${id}`));
  assert.equal((result.stdout.match(new RegExp(`namespace: sales-test-${id}`, 'g')) || []).length,6);
  assert.equal((result.stdout.match(new RegExp(`name: DB_NAME, value: sales_test_${id}`, 'g')) || []).length,2);
  assert.match(result.stdout,/activeDeadlineSeconds: 180/);
});
test('設定生成は不正な識別子を拒否し標準の配備設定を維持する', () => {
  assert.notEqual(render({SALES_RUN_ID:'../bad'}).status,0);
  const result = render({SALES_RUN_ID:''});
  assert.equal(result.status,0);
  assert.match(result.stdout,/name: DB_NAME, value: integration_demo/);
});

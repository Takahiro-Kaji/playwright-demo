# 新規ケースを追加する

## 追加前の確認

1. 学習デモか実対象か、接続先・DB・所有範囲を明示する。学習デモは `harness('upstream')` または `harness('mock')` で実行ごとの専用DBを使う。[実装](../../tests/targets/sales/harness.ts)
2. 操作前にケースID、入力、HTTP・画面・DBの期待値、復元後の状態を決める。F1/F2は[7ケース](seven-cases.md)を参照。観測値から期待値を作らない。
3. `test.step` のGiven／When／Then／Afterを読みやすく書く。Afterは `finally` 内で実行し、失敗を握りつぶさない。復元・停止が不明なら環境を保持し後続を止める。
4. `snapshot()` はproducts・inventory・sync_state・ordersの**全列**を同一読取りトランザクションで取得する。変更がない期待ならWhen直前とThenを比較する。`query(sql, ...args)` は対象行の観測、`execute(sql, ...args)` は許可された専用DBの準備・復元に使う。
5. モックを変更する場合は `status()` で元値を退避し `status(503)` で設定、業務GETでも確認する。`settleAfter()` に復元と `cleanup()` を順に渡し、復元失敗後も停止を試みる。[既存例](../../tests/scenarios/ui/sales.spec.ts)
6. 全件照合には `compareCatalog(db, expected)` を使い、削除許容キー・version・同期状態・受注まで期待値を明示する。[実装](../../tests/targets/sales/compare.ts)と[故障注入](../../tests/verification/sales-comparison/compare.test.ts)を参照。表示や観測条件の変更時も、欠落・誤値・誤関連・操作不能などを検出できるか検証する。
7. 認証情報・巨大な応答本文を証跡へ出さず、ケースとAfterの判定を分ける。SSO・実クラスタ・AWSはローカルデモのPASSとは別に確認する。

## 具体例：P002の商品表示を確認する

1. [UIケース](../../tests/scenarios/ui/sales.spec.ts)を参考に `tests/scenarios/ui/p002.spec.ts` を作成し、下の例を記述する。F1同期後に表示するので、期待値は事前固定の「ノート 300円 在庫2受注」。

```ts
import { test, expect } from '@playwright/test';
import { harness } from '../../targets/sales/harness.ts';

test('P002 is displayed', async ({ page }) => {
  const h = await harness('upstream');
  try {
    await test.step('Given: F1を同期', async () => {
      expect(await h.batch()).toBe(0);
      await page.goto(h.app);
    });
    await test.step('When: 商品一覧を表示', async () => {
      await page.getByRole('button', { name: '商品表示' }).click();
    });
    await test.step('Then: P002の表示を確認', async () => {
      await expect(page.locator('#products > div').nth(1))
        .toHaveText('ノート 300円 在庫2受注');
    });
    test.info().annotations.push({ type: 'case-status', description: 'passed' });
  } catch (error) {
    if (test.info().expectedStatus !== 'skipped') {
      test.info().annotations.push({ type: 'case-status', description: 'failed' });
    }
    throw error;
  } finally {
    await test.step('After: プロセスを回収', async () => {
      await h.cleanup();
    });
  }
});
```

2. [ケース一覧](../../test-support/cases.ts)に一意なIDと正確なタイトル `P002 is displayed` を登録する。要約はこの一覧を正本とするため、登録しない試験は集計されない。現在の集計は7件を前提とするため、8件目を正式対象に加える場合は統括と期待範囲を合意し、[レポーター](../../scripts/sales-reporter.ts)の `allSevenSelected` という項目名・集計テスト・教材も同時に更新する。登録だけで既存の7件受入が完了したとは扱わない。
3. `npm run sales:check`、`npm run sales:test:ui` を実行する。要約パスはコマンドが表示する。部分実行の総合は未完了であることと、このケースの結果・Afterを確認する。
4. 意図的に期待文字列を変えてFAILすること、復元が必要なケースならAfter失敗時に後続停止することを検証し、期待値を元に戻す。画面参照のみのこの例ではDBを変更しないが、削除・投入するケースではWhen前の `snapshot()` と復元・再確認を追加する。

## 後処理と結果の読み方

`cleanup()` は終了確認前にDBを消さない。モック復元など複数の後処理は `settleAfter()` で全て試み、エラーがあれば `AggregateError` 等で失敗として返す。`playwright.sales.config.ts` は1 worker・再試行なし・`maxFailures: 1` なので、After失敗後のケースは実行しない。[停止の故障注入](../../tests/verification/support/fail-stop.test.ts)で業務成功・失敗・未確認とAfter失敗の組合せを確認している。

# 販売管理学習デモ 作業管理

状態：契約を統括レビュー中。実装・新規担当ブランチ/worktree・commit・push・PR・mergeは未着手。正本は [共通契約](sales-learning-contract.md)。7件すべて学習デモの必須。過去資料の任意扱いを本デモに限り上書きし、実業務へ一般化しない。

## 分担と依存

下記は実装承認後に `origin/main` と承認済み契約を取り込んだ共通基点から作る独立ブランチ・worktreeの計画。別々の作業ディレクトリで作業し、統括が成果を順に統合する。ここに列挙したブランチ・ディレクトリは未作成。契約変更、共通ファイルの衝突、対象横断の業務判断は統括へ戻す。

| 担当 | ブランチ／worktree案 | 編集範囲 | 完了・依存 |
| --- | --- | --- | --- |
| A アプリ・DB・外部IF | `feature/sales-demo` / `../sales-demo-a` | `demo/sales/`（アプリ、DB、同期、学習用実IF、モック）、`tests/verification/sales-demo/` | 契約のHTTP、SQLite、受注原子性、同期を局所検証。B・C・Dの対象を提供 |
| B 共通基盤 | `feature/sales-test-support` / `../sales-demo-b` | `test-support/`、`tests/verification/support/`、学習専用設定・実行入口 | 接続・プロセス回収・安全な証跡・復元・比較と故障注入。業務期待値を持たない |
| C UI | `feature/sales-ui` / `../sales-demo-c` | `tests/scenarios/ui/`、`tests/targets/sales/ui.ts`、UI固有fixture | A・Bの契約に基づくUI2件 |
| D バッチ | `feature/sales-batch` / `../sales-demo-d` | `tests/scenarios/batch/`、`tests/targets/sales/batch.ts`、`db.ts`、`upstream.ts`、照合規則・fixture、`tests/verification/sales-comparison/` | A・Bに基づくバッチ2件とSQL→復元→故障注入 |
| E 横断 | `feature/sales-cross` / `../sales-demo-e` | `tests/scenarios/cross-feature/`、`tests/targets/sales/cross-prepare.ts`、横断固有fixture | A・B・C・Dの操作を利用し横断3件。ケース間呼出しはしない |
| F SSO | `feature/sales-sso` / `../sales-demo-f` | `test-support/auth/`、`tests/verification/auth/`、SSO固有設定例 | Bの証跡境界と調整。手動実機認証はユーザー操作待ち |

`package.json`、ロックファイル、共通Playwright設定、共通型・共通fixture、READMEと契約・進捗は統括が統合時に所有する。担当は必要な変更を提案し、同一ファイルの独立編集を避ける。`tests/targets/sales/` の共有期待値が必要になった場合も統括が所有者を決める。Aのモック本体とBの管理クライアントはHTTP契約で分離する。テスト基盤からデモ内部モジュールをimportしない。

順序：契約承認 → A・Bの最小経路 → CのUIモック異常を代表経路として完成 → Dの実接続全件照合・検証器評価 → Eの同期中観測。C/D残件とEの他2件も必須。Fは認証状態の安全な取り扱いをBと合意して並行開発可能だが実SSO認証は操作待ち。統合時に7件と故障注入を通し、実行環境別に結果を分ける。

## 実行コマンド計画と受入

以下は実装後に `package.json` 等へ追加する**予定コマンド**であり、現時点では存在・実行を確認していない。既存 `npm run test:unit`、`npm run test:syntax`、`npm run test:integration` は維持する。学習用は専用設定を使い既存CJS試験と混在させない。各コマンドはローカル専用DB・ループバックのみで起動し、共有状態・AWSを使わない。

| コマンド案 | 対象と受入 |
| --- | --- |
| `npm run sales:check` | TypeScript型検査と学習用静的検査が成功 |
| `npm run sales:test:unit` | Aの同期・受注・HTTP、Bの接続・復元・証跡、Fの認証状態管理の局所検証が成功。受注失敗時の全不変とトランザクション競合を含む |
| `npm run sales:test:verification` | SQL取得→復元→比較の一致例PASS、欠落・重複・余剰・値違い・誤関連・削除漏れの各注入を期待どおり検出。cleanup失敗と元の判定も独立保持 |
| `npm run sales:test:ui` | UI実接続正常・UIモック異常の2件が契約の画面・HTTP・DB・復元条件を満たす |
| `npm run sales:test:batch` | バッチ実接続全件・モック異常の2件が契約の終了・全行照合・不変・復元条件を満たす。Chrome不要 |
| `npm run sales:test:cross` | 同期中UI・古い情報受注・不整合情報受注の3件を実施。同期中の重なりを証明できない場合は未確認で、全体PASSにしない |
| `npm run sales:test` | 上記の必要な検査・7件を逐次実行し、各ケースのPASS／FAIL／未確認と復元状態を報告。7件すべてPASSかつ復元確認済みでのみデモ受入PASS |
| `npm run sales:auth:setup` | 実SSO用の手動認証準備。ユーザー操作待ちとし、秘密を記録しない。学習デモの通常実行に実SSOを必須化しない |

各試験は期待値を操作前に固定。学習用実IFへのHTTPを実際に使い、本番外部サービスの受入とは区別する。失敗や未確認を隠さず、試験結果と復元状態を別々に表示する。AWS資源の作成・課金操作は禁止。

## 5つの学習資料

統括が `docs/learning/` の共通構成を所有し、各担当が内容を提案する。いずれも実装と並行して更新し、存在しないAPIを実在として書かない。

1. `api-reverse-lookup.md`：API・HTTP・DB・共通関数から実装とケースへ逆引き。A・B・F担当の内容。
2. `seven-cases.md`：C・D・Eの7件を固定fixture、Given／When／Then／After、判定と復元で読解。
3. `architecture.md`：ローカル実IF／モック、アプリ、DB、Playwright、SSOの関係と実対象との差を図示。A・B・Fの内容。
4. `hands-on.md`：必要環境、専用DB、ローカル起動、各予定コマンド、結果・後片付け、未確認の扱い。A・B・C・D・Eの実行確認後に確定。
5. `new-case-checklist.md`：対象・所有範囲・固定期待・HTTP/UI/DB照合・故障注入・復元・証跡の確認。B・C・D・Eの内容。

## 状況・未確認

- **PASS**：正式originと履歴、契約用ブランチとクリーンな開始状態、調査端末でNode 26.4.0／npm 11.17.0／`node:sqlite` の利用可否を確認。
- **FAIL**：現時点の調査・資料作成で確認した失敗なし。
- **未確認**：統括レビュー、依存導入、SQLite同時実行・トランザクション・復元、7試験、故障注入、学習用実HTTP、Google Chrome実行、実SSO、AWSおよび実外部サービス。コマンドは計画であり実行実績ではない。

## 2026-11-01 実装途中の記録

- 承認契約 `6467af1`。A〜Fと統合ブランチを作成し、write権限内の `/private/tmp/sales-demo-{a,b,c,d,e,f}` を使用。別Codex CLIを `gpt-6.1-terra` / high で3件起動したが、app-server初期化が `Operation not permitted` で失敗したため同一CLIで順次作業。
- 統合ブランチ `integration/sales-learning`。ローカル依存を導入し、型検査・局所5件・SQL照合故障注入・既存回帰10件を実行。Chrome試験は6 PASS、同期中UIは観測不成立で未確認。一括は未確認を含むため非ゼロ。
- ローカルkubectl実行ファイルは存在するが、偽CLIのみで検証し実クラスタは未確認。SSOは認証入口とURL/locator検証を実装、手動ログイン・新context・Chrome再起動後の実認証は未確認。AWS操作は未実施。
- 証跡 `.local/sales-learning-evidence/<runId>/summary.json`。`.local/` のGit除外を確認。デモのPASSは本番外部サービスの実績ではない。
- 残課題：同期中の重なりの成立、実環境の検証と教材の独立レビュー。これらが完了するまで受入完了としない。

追加のレビュー対応：fixture・SQLを `tests/targets/sales/` に移動し、7件の4段階と同期中の区間内観測を実装。捕捉できない場合は未確認として集約終了コード1。モック復元失敗後の回収と複数エラー保持の局所検査を追加。SSOの成功URL・locator検証とheadless再起動を追加したが実認証未実施。削除済み商品に残った非ゼロ在庫も照合器の故障として検出。ローカル一括は型検査・局所6件・照合器故障注入は成功、Chromeは6 PASS／1未確認。後処理と本体失敗の同時故障について、制御用のPlaywright試験で後続停止と別判定を確認。サマリーのみで実環境の復元を保証しない。

追加レビュー対応：削除許容キーを明示し、全件数・キー・値・関連・version・同期状態・受注を照合。inactive余剰と削除済み在庫非ゼロ等の故障注入を検出。証跡は実行ごとのrunIdに保存し、ケースとAfterを分けた。Playwright API逆引きと具体的なFAIL実習を追記。全7件の再実行は6 PASS／同期中未確認、一括は非ゼロ。

独立レビュー追加対応：全7件のID・実行範囲・未実施を要約に含め、部分実行のみで総合PASSにしない。After失敗時は後続停止し業務・After判定を分離。業務成功／失敗それぞれとAfter失敗を組み合わせた故障注入で後続未実施を確認。同期中UIはデータセット1/データセット2の全表示、HTTP・例外・操作可能性、最終DBを確認する。UI異常・不整合受注はWhen前の4表を全列取得し不変を比較。商品名・価格・version・P002等の故障注入を追加。同期中の重なり自体は依然として未確認。

同期中の追加設計判断：ケース専用の固定合成3,000件、最大20試行・試行開始とバッチ待ちの期限12秒・10,000観測で、バッチ／UI／独立DB観測を並行し全試行を記録。厳密にはHTTPリクエスト開始〜応答の同一区間内のSELECT 1→2のみ成立とする。表示確認完了はテスト側の読取り時間を含むため判定終端に使わない。初期の試行では応答後の遷移を誤ってPASS扱いしたため、当該ローカル要約を理由・元判定付きで無効化した。修正後の一括は6 PASS／同期中未確認。古い情報受注はWhen直前と後の4表全列を照合する。

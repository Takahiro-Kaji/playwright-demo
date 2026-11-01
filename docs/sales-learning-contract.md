# 販売管理・結合試験学習デモ 共通契約

状態：統括決定を反映した実装前契約。残る具体案は統括レビュー待ち。対象は専用ローカルデモのみで、既存業務アプリや実業務仕様へ一般化しない。7試験は今回すべて必須。従来資料で任意・候補とされた古い情報／不整合情報による受注も本デモでは必須とする。他の既存必須テーマを満たしたことにはしない。

## 1. 実行境界と技術

- 学習用実接続はローカルの独立した学習用外部IFへの実HTTP通信。制御可能なモックも別プロセスとして同じ業務IFを提供する。いずれも本番外部サービスの検証ではない。実対象・AWS・実SSOの受入は別に記録する。
- 新規実装はTypeScript。既存CJS、既存Playwright設定とコマンドは維持し、学習用入口を分離する。Node.js 26を学習デモの前提とする。2026-11-01の調査端末はNode 26.4.0、npm 11.17.0、標準 `node:sqlite` が使用可能。mysql CLI・mysqld・Dockerコマンドも存在するが、サーバー稼働・Dockerデーモンは未確認。
- DBは `node:sqlite` によるSQLiteファイルを採用し、依存サービスなしのローカル起動とトランザクションを優先する。各実行は `.local/sales-learning/<runId>/sales.sqlite` に専用DBを作り、他実行と共有しない。SQLiteのWAL、foreign_keys、busy_timeoutを全接続で適切に設定し、ローカルファイルのみ許可。DBの排他・同時読取の実動作は実装時に検証する。MySQL互換性やAWSの挙動の証明には使わない。
- 追加開発依存は `typescript`、`tsx`、`@types/node` を予定。既存 `@playwright/test` を使用する。インストールと依存解決は未検証。実装時にバージョン固定・ロックファイル整合性を確認する。Google Chromeが必要なUI以外、特にバッチはブラウザー不要。
- 対象・DBパス・外部IF・モックを明示し、専用ローカルパスとループバックを検証してから変更する。他ユーザー・他実行とDB、モックを共有しない。AWS新規リソース・課金操作は対象外。

## 2. 外部IF・モック

`GET /catalog` はHTTP 200、`Content-Type: application/json`、次の完全なJSONを返す。`catalogVersion` は正の安全整数、商品コードは一意、`price` は0以上、`quantity` は0以上の整数、`active` は真偽値。配列順に意味はない。すべての整数はJavaScript安全整数かつ0〜2,147,483,647（versionは1〜2,147,483,647）。欠落・余分な属性、重複、範囲外、JSON不正、空でないことが確認できない途中切断は取込失敗。空配列は有効な全量として扱う。

```json
{"catalogVersion":1,"products":[{"productCode":"P001","name":"ペン","price":120,"active":true,"quantity":5},{"productCode":"P002","name":"ノート","price":300,"active":true,"quantity":2}]}
```

学習用外部IFのデータは固定fixture。モックは同じGETと、ループバック専用・管理認証必須の `GET /admin/status`、`PUT /admin/status`（`{"status":200}` または `{"status":503}`）を提供する。管理GET/PUTは200で `{"status":200}` 等の現在値を返す。503時の業務GETは503、本文空。業務GETのクエリによる上書きは禁止。実際のGETも確認し、設定値だけで前提成立としない。複数モックを使用するときは各々元値を退避・設定・確認する。

## 3. DBと更新境界

SQLiteの整数は64ビットだが、入力と出力は上記安全な上限を厳格に検証する。外部のversionは同期世代、商品ごとの `version` は表示と受注の競合判定用であり、両者を混同しない。

```sql
CREATE TABLE products (
  product_code TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price BETWEEN 0 AND 2147483647),
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 2147483647)
);
CREATE TABLE inventory (
  product_code TEXT PRIMARY KEY NOT NULL REFERENCES products(product_code),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 0 AND 2147483647)
);
CREATE TABLE orders (
  order_id TEXT PRIMARY KEY NOT NULL,
  product_code TEXT NOT NULL REFERENCES products(product_code),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 2147483647),
  unit_price INTEGER NOT NULL CHECK (unit_price BETWEEN 0 AND 2147483647),
  status TEXT NOT NULL CHECK (status = 'CREATED')
);
CREATE TABLE sync_state (id INTEGER PRIMARY KEY CHECK (id = 1), catalog_version INTEGER NOT NULL);
```

同期はHTTP取得を完全終了しJSON全体を検証してから `BEGIN IMMEDIATE`。商品・在庫の全量を1トランザクションで更新し、存在しなくなった商品は `active=0`・在庫0にする（受注履歴の外部キーを保持）。新規はversion 1、既存は名称・価格・有効状態・在庫のいずれかが変わった場合だけversionを1増やす。オーバーフローは全体失敗。`sync_state` は同じトランザクションで更新して1回だけCOMMIT。エラーは全体ROLLBACK。受注履歴は同期で変更しない。空配列は全商品を無効・在庫0とする。同期と受注はDB書込みを直列化し、各受注はコミット済みの一貫した状態を評価する。

受注は同一 `BEGIN IMMEDIATE` 内で商品・在庫・versionを再読取し、検証後に受注1行追加、在庫を数量分減算し商品versionを1増やしてCOMMIT。どの失敗もROLLBACKし受注・在庫・version不変。受注IDはサーバー発行のUUID。再送による重複防止はこのデモ契約の対象外なので、失敗・タイムアウト後の自動再送は禁止。

## 4. アプリAPIと画面

- `GET /api/products` → 200 `{"products":[{"productCode":"P001","name":"ペン","price":120,"quantity":5,"version":1}]}`。有効商品のみを返す。商品に在庫行がないなど表示に必要な関連が不整合なら409 `{"error":"INCONSISTENT_DATA"}`。画面は商品・価格・在庫・versionを受注操作に保持する。
- `GET /api/availability` → アプリが設定済み外部IFの `GET /catalog` に実HTTP接続し、正常な200なら200 `{"available":true}`。非200・通信失敗・期限切れは502 `{"error":"UPSTREAM_UNAVAILABLE"}`。画面の「外部接続確認」操作が呼び、成功は「接続可能」、障害は「外部システムエラー」を表示する。DB更新はしない。同期のデータ検証は別に行う。
- `POST /api/orders` 入力 `{"productCode":"P001","quantity":1,"version":1}`。余分な属性や不正型・範囲は400 `{"error":"INVALID_REQUEST"}`。成功は201 `{"orderId":"<UUID>","productCode":"P001","quantity":1,"unitPrice":120,"status":"CREATED"}`、画面は「受注しました」。
- 判定優先順は入力検証、商品・在庫関係、version、業務条件。商品なし／在庫行なしは409 `INCONSISTENT_DATA`、表示versionと現在versionの不一致は409 `STALE_VERSION`、無効商品または在庫不足は409 `ORDER_UNAVAILABLE`。エラー本文は `{"error":"コード"}`。対応する画面表示は順に「商品情報に不整合があります」「情報が更新されました。再表示してください」「受注できません」。いずれも受注・在庫・version不変。

## 5. 固定fixtureと7件の受入

初期DBは空。fixture F1は上記catalogVersion 1の2商品。F2はversion 2でP001のquantityのみ3、それ以外F1と同じ。F1同期後はP001=(120,5,version 1)、P002=(300,2,version 1)、受注0件。F2同期後はP001=(120,3,version 2)、P002=(300,2,version 1)。各ケースは独立DBで始め、期待値はWhen以前に宣言する。

1. **UI実接続正常**：学習用実IFへ接続確認200、F1同期後にP001をversion 1・数量1で受注。201、画面成功、受注1行のキー・数量1・単価120・CREATED、P001在庫4・version 2、P002不変。
2. **UIモック異常**：F1同期後モック503、接続確認で502 `UPSTREAM_UNAVAILABLE`、画面に外部エラー。受注0件と商品・在庫の全行不変。
3. **バッチ実接続全件**：F1を実HTTPで完全取得し同期。終了正常に加え商品2件・在庫2件の全キー、名称・価格・有効状態・数量・関連を固定fixtureと照合。余剰・孤立・重複なし。
4. **バッチモック異常**：F1同期後503で再同期。失敗結果と商品・在庫・同期状態・受注の全行不変を確認。
5. **同期中UI**：このケース専用の固定合成3,000件（S0001〜S3000、名称は学習商品＋4桁番号、価格100〜3099、全て有効）を使用。旧データは在庫5・catalogVersion 1・各version 1、新データは在庫3・catalogVersion 2・各version 2。旧を同期した後、新データへ切替えてバッチとUIの継続参照・独立DB観測を並行する。更新コミットとUI参照期間の重なりを下記の条件で証明し、HTTP・全表示・例外・操作可能性と最終DB全3,000件を照合。旧・新のいずれの一貫した表示も許容する。
6. **古い情報受注**：F1のP001 version 1を表示後F2同期、When直前に4表の全列をsnapshotし、旧version 1で受注。409 `STALE_VERSION`、受注0件、F2の在庫3・version 2を含む4表全体がsnapshotと一致。
7. **不整合情報受注**：F1を表示後、専用DBの許可された準備としてP001の在庫行を削除し、version 1・数量1で受注。409 `INCONSISTENT_DATA`、受注0件、商品と残存在庫はWhen直前から不変。Afterで在庫行を復元・照合。

同期中の成立証拠は、他の書込み主体がない専用DBで、**同一の正常なUI参照**のリクエスト開始からHTTP応答までの区間に、独立接続のSELECTがversion 1、続くSELECTがversion 2をそれぞれ完全に観測したこと。各SELECTの開始・終了、各UI試行のリクエスト開始・応答・表示確認完了を単調時計で記録する。表示確認時刻には試験側の読取り時間も含まれるため、成立判定の終端には使わない。バッチ起動・独立SELECT監視と逐次UI参照を並行し、試行開始とバッチ完了待ちの期限は12秒、UI操作の個別timeoutは3秒、全ケースtimeoutは30秒、上限20試行・観測最大10,000件を固定する。開始済みの操作は各timeout内で回収する。各試行と観測をGit対象外へ保存し、欠測や上限到達も記録する。プロセス存命のみ、区間外の変化、異なる試行間の前後観測では成立しない。捕捉できなければ未確認。単一COMMITなので途中の部分更新を見たとは主張しない。業務アプリへの遅延・観測用改修は行わない。

## 6. 照合・復元・証跡・SSO

ケースごとにGiven／When／Then／Afterを記述し、期待を先に固定。取得した外部JSONを一時保存して転送・解析成功を確認し、DBを独立SELECTで全行取得してキー・件数・値・関連・有効／削除状態を比較する。重複や孤立をJOINやMapで消さない。照合器の正常fixtureと、欠落・重複・余剰・値違い・誤関連・削除漏れを1つずつ注入したfixtureを、SQL取得から復元・比較まで通し期待する差分を検出する。実HTTPと本番外部サービスの区別、スナップショットとバッチ入力の同一性の限界を記録する。

`finally` で起動プロセスの終了を確認し、モックを各開始時設定へ戻して管理GETと業務GETで確認。変更したDBは専用DBの事前定義した状態へ復元しSELECTで確認。終了未確認や復元失敗では後続を停止し、元の試験判定と復元状態を別々に記録する。強制終了時はfinallyが保証されないためrunId、DB位置、最後の状態と復旧手順を残す。証跡は期待、結果、差分種別・件数、時系列、未確認範囲、復元状態の要約とし、秘密値・Cookie・トークン・認証URL・巨大応答本文を含めない。生データはGit対象外に一時保存し、復旧確認後に削除する。

実SSOは業務試験前提。Playwright起動Chromeでユーザーが手動認証し、ローカルのstorageStateを新コンテキストで再利用できるか検証する。未認証・失効は未確認、認証後の変更操作は自動再送しない。認証情報を記録しない。方式・代替・記録制限は [SSO合意記録](local-ui-sso-authentication.md) に従い、SSOとAWS実環境は未検証のまま。

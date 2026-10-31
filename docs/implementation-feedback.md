# 初回実装フィードバック（2026-10-31 JST）

## 対象と結論

`ee76bb44fc4eb65f28e08d556f8ecaae183052c8` を基点とする `codex/test-foundation-handoff` の作業差分で、既存CommonJSデモのUIモック異常経路を改善した。レビュー指摘SOL-C01〜C04への対応と、隔離ローカル環境でのUI 503経路1ケースの実証までを今回の範囲とする。目標ディレクトリへの移行や代表3ケース全体の検証は完了していない。元の `/Users/takahirokaji/play-right-demo` は変更せず、新たな公開AWS資源も作成していない。

## レビュー指摘への対応

- **C01 後続停止**：逐次・再試行なしに加え、Playwrightの `maxFailures: 1` を設定した。復元失敗だけでなく業務上のFAILでも後続を止める保守的な設定である。
- **C02 他者変更の保護**：設定・復元とも、状態のregion・status・version・instanceIdを条件とする比較更新をモックの単一ハンドラー内で原子的に行う。競合・再起動を検出したら上書きしない。応答喪失などで変更の所有状態を確定できない場合も復元PUTを行わず、要確認として残す。これはモック単一プロセス内の比較更新であり、分散leaseや共有環境の排他保証ではない。並行利用の運用管理は引き続き必要。
- **C03 後処理の時間**：ケース本体とは別のfixture終了処理に60秒を割り当て、各対象の復元を試み、証跡を添付する。通常のケース期限切れでは終了処理を検証したが、端末停止、強制終了（SIGKILL）や実行プロセス中断などで完了を保証するものではない。
- **C04 復元証跡**：対象ごとの変更前・変更後・復元後状態、実応答、結果、失敗段階とエラーを記録する。業務失敗と復元失敗は両方残す。

## 2026-10-31 JSTの実行結果

Macローカルで Node.js 26.4.0、MySQL 9.2.0、Google Chrome 156.0.8078.48、Playwright 1.64.1を使用した。ルートとデモアプリの依存をインストールした。

- `npm run test:unit`：19件成功。モックの競合・再起動・応答喪失、復元処理、実HTTP／curlなどを含む。ループバック通信を許可した実行で確認した。
- `npm run test:syntax`：28 CommonJSファイル成功。`npm run test:list`：通常の依存で9ケースを列挙。
- `npm run test:verification`：実Playwright runnerで前提失敗、ケース期限切れ、復元失敗、業務失敗と復元失敗の同時発生を注入。各条件で両対象への復元試行、証跡、後続sentinelの未実行を確認した。
- `node scripts/local-e2e.cjs --grep 'a / both-unavailable' --timeout 30000`：実Chrome、専用一時MySQL、2モック、2デモアプリで1件成功。両モックを200から503へ変更し、アプリHTTP 502、UIの「外部システムエラー」とアクセシビリティ属性、DB前後の空結果を確認。両モックを200へ戻し、復元後の実応答200も確認した。DB非更新の観測は2秒間に限る。
- 追加レビューを受けMySQL Xプロトコルを無効化し、専用MySQLのTCP待受が `127.0.0.1` の1件のみであることを確認。runner起動時のENOENTを注入し、失敗終了と専用一時ディレクトリの削除を確認した。起動・停止の対象はハーネス自身の子プロセスである。

最初のChrome実行は、未使用のレスポンス本文を `response.text()` で採取する箇所で30秒の期限切れとなった。本文採取を除き、必要なHTTPステータス・ヘッダー、UI、DBで判定して再実行した結果が上記の成功である。本文取得の問題自体は解決・原因特定していない。

実行時のJSON証跡は `test-results/local-e2e-report.json`、失敗時のスクリーンショット等は `test-results/` に保存される。これらはGit対象外であり、次回実行で上書き・削除され得る。認証情報や生データをコミットしない。

## 未確認と次の単位

今回のPASSはローカル代役の固定A・503ケースに限る。残り8ケース、AWS/EKS/RDSでの実接続、Terraformやコンテナ構築、実対向データの認証・取得は未確認。同期バッチの全件照合と同期中UIの観測は未実装であり、3代表ケースによる配置設計の評価は未完了。次はUI異常経路の残る環境条件を確認しつつ、同期バッチの全件照合、その後に同期中UIの観測と回収を実装する。

## 引き継いだクラウド作業の履歴

先行するLinux上の初回パッチでは、単体13件と構文23ファイルが成功した。通常依存・Chrome・MySQL CLI等が利用できず、一覧9件は一時アダプターによる特殊条件であり、実E2Eは未実施だった。これらは上記のMacでの検証結果とは別の履歴である。

## 毎時実装の手動実行：同期バッチ代表経路（2026-10-31 JST）

04:18ごろ開始、04:31時点の作業結果。基点は `c9fe2e05ee8364ea505a353b26e15698948cf8a4`、この追加分は記録時点で未コミット。CJSのまま、目標配置の `tests/scenarios/batch`、`tests/targets/demo-reference`、`test-support`、`mocks/reference-source`、`demo/reference-sync` に、専用MySQL・合成上流・別Node同期プロセス・親子全件照合の小さな代表経路を追加した。バッチ専用Playwright設定ではブラウザーを要求しない。UI入口は既存9ケースに限定し、検証入口と分離した。

- `node scripts/local-batch.cjs`：小データで上流の完全取得、固定期待、同期、両テーブルの全行照合、証跡と後処理を実行。実SQLで欠落・重複・余剰・誤所属・孤立関連・値・削除漏れ・NULL・BIGINTの差をそれぞれ注入し、期待キーと差分種別を検出。転送切断、不正JSON、同期コマンド失敗も誤PASSにしなかった。検出試験のPASSと注入された業務上のFAILは別記する。
- `node scripts/verify-batch-failure.cjs`：実runnerで本体期限切れと業務・cleanupの同時失敗を別々に注入。元失敗と終了処理の証跡、同期子の停止、非成功終了を確認。別途SIGTERMで実行器・同期子・専用MySQLのPIDが残らず、専用MySQL一時dirを削除することを確認。Playwright共通変換cacheは残る。
- `BATCH_SIZE=30000 node scripts/local-batch.cjs`：親15,000・子15,000行、入力2,257,781 bytes。同期5,349ms、照合まで5,437ms、Playwright workerの観測RSS 174,440,448 bytes。RSSはピーク測定ではなく、同期子・上流サーバー・MySQLを含まない。
- `node scripts/local-e2e.cjs --grep 'a / both-unavailable' --timeout 30000`：MySQL寿命共通化後も既存の実Chrome 503ケース1件成功。`npm run test:list` は従来のUI9件のみ、`npm run test:syntax` は38ファイル成功。先行の単体19件・UI fault4条件は前節の検証結果であり、この単位での再実行結果ではない。

独立レビューで、初版が終了処理を本体内に置き直しC03を再発させていた点と、中断時の子プロセス回収を指摘された。終了処理を専用fixture・60秒予算に移し、同期子を終了確認してからDBと入力を片付ける。runnerは専用プロセス群を所有して停止・回収する。強制終了や端末停止まで保証しない。

上流取得のハッシュは保存スナップショットの識別であり、別プロセスの再取得と同一入力であった証明ではない。生入力は `.local` に一時保存後に削除し、Playwright表示用の `test-results/batch-report.json` は別suiteで削除され得るため、実行ごとの非秘密要約をGit対象外の `.local/runs/<runId>/case-summary.json` に確定する。入力・コードのハッシュ、範囲、バッチ、差分、判定、後処理と測定を保持する。専用DB全体を所有するデモであり、実対向の認証・業務SQL・共有DB復旧、同期中UI、AWSは未確認。次の最小単位は同期中UIの観測と回収である。

### 実行別証跡の保持

前述の3万行の数値は実行固有の記録値である。その後、UI実行によりPlaywright表示用の判定・測定JSONが削除されたため、小データと3万行のレポートをそれぞれ別名で回収した。さらに、後続の実行で上書きされないよう実行ID別の要約保存を追加した。小データを2回実行し、両要約の存続、入力・コードハッシュ、PASSと終了処理状態、認証情報が含まれないことを確認した。この2回は失敗分類・添付状態・runner状態の追加前の差分版であり、最終差分の実行結果ではない。今回の旧版3万行の回収レポートと新しいrunId要約は別の実行記録であり、数値を混同しない。生入力は保存しない。

独立レビュー後、永続要約に秘密を含まない失敗の段階・分類、証跡添付状態、runner終了状態を追加した。故障注入のcleanup条件は成功したが、期限切れ条件の終了処理は同期ストレージからのファイル読込み待ちにより60秒を超過した。添付失敗だけの実行も読込み待ちで中断し、所有プロセスを回収したため、この最終差分での添付失敗の実runner検証は未確認。独立レビューは差分を確認したが、この実行結果の代替ではない。

## 毎時確認：添付失敗の永続証跡（2026-10-31 JST）

05:14ごろ開始、05:17時点の確認。対象はcommit `3c08912b3f01726a6639e80c1721238c0471e79c`、macOS、Node.js 22.19.0、MySQL 9.2.0。前回停止した同期ストレージの状態をメタデータで確認し、datalessだった試験範囲の正本1ファイルを通常の同期機能で実体化した。対象コード・直接確認した依存ファイルも実体化済みだったため、`BATCH_VERIFY_ATTACH=1 node scripts/local-batch.cjs` を1回実行した。

run `8a158966-a12a-4eef-94c2-3e61502e38c8` のGit対象外 `.local/runs/<runId>/case-summary.json` で、業務判定PASS、DB等のcleanup completed、添付failed、runner failed、環境cleanup completed、同期子停止を確認した。Playwrightの失敗結果には `injected attachment failure` が元エラーとして保持されている。入力ハッシュと8コードハッシュを確認し、要約に認証情報と生入力が含まれないこと、所有する同期・MySQLプロセスが残らないことも確認した。これは添付失敗検出の確認であり、業務ケースFAILではない。shell終了コードの直接値は取得できておらず、要約のrunner失敗とPlaywrightレポートの失敗を確認した。

前回の期限切れ再実行は今回行っておらず、最終差分での再確認は引き続き未確認。実対向の認証・業務SQL・共有DB復旧、同期中UI、AWSも未確認。次の最小単位は同期中UIの観測と回収である。

## 毎時実装：同期中UIの観測と回収（2026-10-31 JST）

06:15ごろ開始、06:24時点の結果。基点は `a6df6b07da660798abba73087d5bf492696b81f5`。専用MySQLの `parents` を読む小さな参照UIデモとcross-feature専用の実Chromeケースを追加した。既存 `reference-sync` は変更せず、専用DBで唯一の書込み主体とする。UIは親の現在件数を表示し、旧・途中の件数でも正常に表示されれば許容する。この許容は実業務の仕様を決めるものではない。

- `node scripts/local-cross.cjs`：修正後のrun `3cf4d65e-5506-4fc5-bd2c-7e71304adc7a` は実Chromeの対象HTTPリクエスト開始〜応答完了の区間内に、完全に収まる2回の別接続SELECTで親数36→37のコミット済み変化を確認。UI HTTP 200・表示、同期終了後の親子全件照合、最終UIの15000件、所有プロセスと専用DBの回収はいずれも成功。最初のUI参照で成立した。入力・7ソースのハッシュ、時刻、件数、判定と後処理はGit対象外の `.local/runs/<runId>/case-summary.json` に記録。秘密情報・生入力は要約に含めない。
- `node scripts/verify-cross-no-overlap.cjs`：run `928b0e8a-5a99-4b77-a23c-15dc0024f879` ではUI参照を同期開始前に終えた。重なりは `unconfirmed`、理由は `overlap-unconfirmed`、runnerの終了値は1。UI自体・同期終了後の照合・後処理は成功しており、別の障害を未成立の検出成功へ混同していない。
- `npm run test:syntax` は45 CommonJSファイル成功、`npm run test:list` は既存UI9ケースのみ。以前の単体19件やUI503実行は今回再実行していない。前回の期限切れ最終差分再検証も未確認。

独立レビューで、当初のclick関数呼出し前後の時間幅には操作待ちが含まれ、実参照との重なりを誤認し得ると分かった。ブラウザのrequestStart〜responseEndをepochミリ秒に正規化し、同じ端末の観測時刻を比較する方式へ修正した。両端に1msの内向き余裕を設け、時刻分解能による境界上の誤成立を抑える。これは時計の急変や任意のクロック差を保証するものではない。実リクエストが短く必要な2観測が得られなければ未確認・非成功とし、process存命やclick前後へfallbackしない。同期の遅延・ロックは追加していない。修正前の正常runはこの最終判定の根拠に使わない。

この結果は専用のローカルデモに限り、単一SQLの未コミット書込み瞬間やUIが途中状態を必ず実見した保証ではない。実対向認証・本番業務SQL・共有DBの復旧・AWSは未確認。3代表経路の小さな試行は得られたが、必須テーマ全体の実施や配置案の最終評価を意味しない。

次の最小課題は、最終差分版のバッチ期限切れ故障注入を、読込み環境が整った状態で再検証することである。

## 毎時確認：バッチ本体の期限切れ後処理（2026-10-31 JST）

07:23ごろ開始、07:25時点の確認。対象はcommit `b19b75e284d76f820baec284d3550eda37600d51`、macOS、Node.js 22.19.0、MySQL 9.2.0。対象ソースと直接確認した依存ファイルは実体化済みで、`BATCH_VERIFY_TIMEOUT=1 node scripts/local-batch.cjs` を1回実行した。

run `0f1dff65-11e4-4f65-8655-cd1aa3540c22` では、Givenの入力取得後、Whenで設定されたテスト本体の1,000ms期限切れをPlaywrightが記録し、外側コマンドの終了値は1だった。期限切れと、終了処理による同期子へのSIGTERMは元のレポートにそれぞれ残った。Git対象外の `.local/runs/<runId>/case-summary.json` では `when`／`timeout`、業務判定FAIL、runner failed、同期子停止、独立したfixture cleanup completed、環境cleanup completedを確認した。入力ハッシュと8ソースハッシュが一致し、要約に認証情報・生入力を含まないこと、専用の一時入力と所有同期子・MySQLが残らないことも確認した。外側の証拠検証は成功であり、意図的に失敗させた業務・runnerをPASSにしたものではない。

テストは待機を注入する環境変数を同期子へ渡し、子を起動したことは終了時のSIGTERM記録で確認した。ただし同期子の待機分岐には到達マーカーがなく、トップレベルの依存読込み後にその分岐へ実際に到達したかは未確認である。したがって、子起動遅延と注入待機を区別した証明はしていない。独立レビューは、本体期限切れ後の子停止・独立cleanup・永続証跡・非成功という確認範囲を承認した。過去の同期ストレージ読込み待ちによるfixture期限切れは別の履歴として保持する。

実対向認証・業務SQL・共有DB復旧・AWS、その他必須テーマと目標配置全体の評価は未確認。次の最小課題は既存UI503代表経路を `tests/scenarios/ui` と `tests/targets` へ段階移行し、ケースの意味と9ケースの重複検出防止を保ちながら、固定A・実Chrome／MySQL・復元証跡で回帰確認することである。

## 毎時実装：UI503ケースの段階移行（2026-10-31 JST）

08:18ごろ開始、08:27時点の結果。基点は `40a9d145ec96e61912c825a5bfa3034bff1d0c1e`。既存9ケースのうち固定A・`both-unavailable` だけを `tests/scenarios/ui` に移し、対象固有の画面操作、SQLと固定期待値を `tests/targets/demo-items` に配置した。共有fixtureの所有状態照合・独立した復元時間・失敗後停止を維持し、旧ケース定義から同じ1組だけを除外した。移行前後の9つのroute／scenarioタイトルと対応する固定期待値を比較し、重複なく一致した。残り8ケースの実装は移していない。

- 初回の移行後正常run `e490f780-0421-482f-b931-a19e3ef11efe` は実Chrome／専用MySQL・2モックで成功。その後、永続要約の応答ヘッダーを必要項目だけに絞り、環境cleanup失敗を非成功へ反映する修正を行ったため、このrunを最終版の結果とは扱わない。
- 故障注入の最初の試行はiCloudの依存ファイル読込みで専用DB・ケースの起動前に停止し、所有プロセスを終了した（exit 137）。ケースが実行された結果ではない。作業履歴から復元したscenarioは初回正常runの保存済みSHA-256と一致した。
- iCloudの再オフロードを避けるため `/private/tmp/play-right-ui-verify` に検証用コピーを作成し、22のソース・設定・lockをSHA-256で元repoと一致させ、lockから依存を復元した。最終版の正常run `9b694c14-fc7f-411d-b069-0cc6f68147e8` はexit 0。HTTP 502・外部503、固定Aの応答元とモック識別、UI文言と属性、DB前後0件と2秒間の不変、両モックの200→503→200と復元後実probeを確認した。
- 同じコピーで `UI_VERIFY_WRONG_FEEDBACK=1 node scripts/local-e2e.cjs --grep 'a / both-unavailable' --timeout 30000` を1回実行したrun `d1c5d7e7-dcae-457a-b869-7d7ce6cedcd6` は、HTTP 502・外部503を維持したままUI文言不一致を検出しexit 1。両モックは200に復元され実probeも成功した。UI assertionで止まったため、この故障runのDB事後結果は未確認。期待文言を待つ15秒はassertionの待機時間であり、テスト本体の期限切れとは区別する。
- 共有fixtureに関わる既存の前提失敗・本体timeout・復元失敗・両者同時失敗の実runner故障注入4条件も、検証用コピーで成功。検証用の3ファイルも元repoとSHA-256一致を確認した。

両最終runの非秘密要約はGit対象外の `.local/runs/<runId>/case-summary.json` に、コピー元とSHA-256一致で保存した。固定期待値の入力ハッシュと生成キーの識別ハッシュを分け、9ソースハッシュ、HTTP・UI・DB・モック復元・fixture／環境cleanup・runner判定を記録する。注入成功は誤表示の検出を意味し、意図的な業務FAILをPASSにしたものではない。

今回のデモ応答に秘密ヘッダーはなかった。永続要約はprobeの必要な識別・ステータス項目だけを保存するが、従来のPlaywright attachment／traceで任意の実環境ヘッダーから秘密が除外される保証は未確認であり、実非本番への接続受入前に確認が必要。実対向・AWS、残る旧8ケースの新配置への移行、必須テーマ全体の検証は未完了。

次の最小課題は固定A・`both-ok` 1件を新UI／target配置に移し、外部200・アプリ201・成功UI・DB事前0件／事後1件（UUIDキーとCREATED）を旧契約どおり回帰確認すること。旧ループから同じ1件だけを除外し、全9ケースの一意性と残り7ケースを維持する。

## 毎時実装：UI正常ケースの段階移行（2026-10-31 JST）

09:21ごろ開始、09:27時点の結果。基点は `10e0eed0e8bb25cc254a33bfa8384fcb7caf55d0`。固定Aの `both-ok` 1件を `tests/scenarios/ui` へ移し、既存 `tests/targets/demo-items` の画面操作・SQL・事前固定期待値と共通復元fixtureを再利用した。旧ループから同じ1組だけを除外し、旧7＋新2のroute／scenarioタイトル9件が一意で、各固定期待値が移行前と一致することを確認した。既存503ケースの契約は変えていない。

- iCloud読込みの阻害を避けるため、前回作成した `/private/tmp/play-right-ui-verify` の固定依存を使い、最終版のsource・設定・lock 23ファイルが元repoとSHA-256一致することを確認した。移行前の一覧も同じ基点と一致するコピーで取得した。
- 実Chrome・専用MySQL・2モックの正常run `60a5bd4a-da6c-43ec-abb7-b606c25a7b7a` はexit 0。外部200、アプリ201、成功文言とrole/state/live、UUID限定DB事前0件・事後1件・差分1件、キー一致・status CREATED・ID文字列、両モック復元と実probeを確認。
- `UI_VERIFY_DB_STATUS=1 node scripts/local-e2e.cjs --grep 'a / both-ok' --timeout 30000` のrun `598b18d6-6da7-4b41-8c7a-8caf9d528ebf` は隔離local harnessのDB adapterだけで登録statusを故障値に変えた。実MySQLに1件、同じUUID、外部200・アプリ201・成功UIを保ったまま、固定期待CREATEDとの不一致を `db-status-mismatch` として検出しexit 1。両モック復元とprobe、環境cleanupは成功。これは故障検出の成功であり、意図した業務FAILをPASSにしたものではない。
- 共通fixtureの既存4条件（前提失敗、本体timeout、復元失敗、両者同時失敗）も同じfixture版で成功。暫定run `0ef58a3e-64d6-4936-9574-b1fe268f835c`／`110cc1ef-b1ca-4061-9fa1-0ca6c2157710` は要約がDB status実値を含む修正前であり、最終証拠に使わない。

最終2runの非秘密要約をGit対象外 `.local/runs/<runId>/case-summary.json` にコピーしSHA-256一致を確認した。事前期待値とUUIDの識別ハッシュ、11ソースのハッシュ、HTTP・UI・DB件数とキー／status一致真偽、モック復元、fixture・環境cleanupとrunner結果を分け、DB実値や認証情報を永続要約に含めない。作成行の回収は専用デモDBの破棄によるもので、共有DBにおける行復元を実証したものではない。

既存7ケースの新配置移行、実非本番のattachment／traceの秘密除外、実対向・AWS、必須テーマ全体と配置案全体の評価は未確認。

次の最小課題は、隔離ローカル環境で両モックの開始状態をA=200・B=429とし、両方を503へ変更した後にUI文言の不一致を注入して、元のUI失敗を保持しながら各モックをそれぞれの開始状態へ条件付き復元し、実HTTP応答・証跡・cleanupを確認することである。これにより一律200への復元では検出できない誤りを検証する。既存9ケースの意味は変更しない。

## Java / Gradle 移行中の確認（2026-10-31 JST）

作業ブランチ `codex/test-foundation-handoff` の基点 `8bc7fbd6240730b314424866f85998a543601257` から、Java 17 / Gradle 8.14.2 の単一モジュールへ移行中。以下は個々の実行時点のソースハッシュで識別される途中結果であり、後続の変更を含む最終版の一括合格を意味しない。実行にはソース・設定の固定コピー `/private/tmp/play-right-java-check` を使用し、非秘密のrun別要約を `.local/runs/<runId>/case-summary.json` に回収した。既存 Gradle cache では native 初期化に失敗し、原因を特定せず別の `/private/tmp` cache で実行した。

- UIの誤文言故障 `45fe5d5b-3ead-4616-8eeb-9b8b24046729` は実Chrome・専用MySQLで業務FAIL・終了1。初期mock A200/B429を503へ設定後、A200/B429へ各々条件付き復元し実probeを確認。DB事後観測は文言assert停止により未確認。後続のUIコード変更前の版。
- DB状態故障 `476b4a22-24cd-4b90-a2c1-d554dbfde215` は専用DBのtriggerで誤値を注入し業務FAIL・終了1、両mock復元とprobe、環境回収を確認。前の試行 `bc86a4cb-9ade-42a2-b2ee-0fe860e37684` はtrigger権限不足でGiven前に停止。専用MySQLだけでbinary logを無効にして再試行した。
- バッチ `aab23167-0ada-4dcc-82b6-3d2304c6e77f` は親15,000・子15,000行、入力1,968,929 bytes、同期3,367ms、9 SQL故障確認を含む照合まで3,761ms。観測時JVM heap 67,354,224 bytesはピークではなく同期子・MySQLを含まない。完全取得スナップショットのhashは、別プロセスが取得した入力との同一性の証明ではない。
- cross `a5cd022e-721c-4a7c-9aee-453ff779e274` は実HTTP要求開始〜応答終了の内部に完全に収まる2 SQL観測で親数62→63、両端1ms内向余裕、同期後全行と最終UIを確認。SQLは同一端末のepochミリ秒を直接記録し、時計急変は排除できない。旧run `9e44b88b-2506-4d70-b124-af33747e6bd9` は時刻校正の不確実性が判明し成立根拠から除外。no-overlap `63cfd57c-7e5c-4fd7-8baa-1ab1ac88a05a` は未確認・終了1であり、同期後の全件比較・最終UI・環境回収は成功した。
- 復元失敗 `fdab9935-6346-4500-946d-397da00aaf15` はGradle failFastだけで同一class内の後続が止まらない事実を踏まえ、明示ガードを追加した版で業務PASS・復元失敗・runner非成功。後続メソッドは開始前ガードで拒否されsentinel本体は動かなかった。詳細証拠と変更後の再確認は後続の結果を参照。

これらのデータベースはローカルの専用破棄可能DBであり、共有DBの行復元を保証しない。実AWS・EKS・RDS・実TLS接続、実対向認証と業務SQLは未確認。ローカルのrandomは従来どおりA固定の代役であり、実ロードバランサーや `x-routed-region` は検証していない。旧JavaScriptのPASSをJavaのPASSに流用しない。

### Java版の後続固定コピー検証

`gradle test localUiTest` は通常13件、UIのroute/scenario 9件が成功、skip 0。UIの固定A成功は `1e656613-5ec1-4da4-a661-f83278afbd65`、固定A・503は `09fd3e36-e3c9-4f32-8d71-c594955521f7`。両件とも専用DB・実Chrome・両mockを使用し、前者はHTTP 201・表示・DB 0→1/キー/CREATED、後者はHTTP 502・外部503・表示・2秒間DB不変を確認。mockの元状態と各probe、実行元の対象ソースhashは各要約に残る。

同じUIソース版の故障注入では、誤文言 `05a73676-6c40-4469-a67a-3e7b5f2c1e22` は業務FAIL・終了1でA200/B429へ各復元probe成功、DB誤status `d757dc09-6660-44bf-8d3f-8199fc91915e` は不一致を検出し終了1・両mock復元probe成功。前者は表示assertで終了しDB事後結果は未確認。復元競合 `7240ce07-8861-4d66-a9c2-2761ea027750` は競合後A429/version2を上書きせず、Bを元200へ復元。GradleのfailFastは同一JUnit classの次メソッドを防げなかったため、開始前の停止ガードを追加し、実runnerで後続sentinel本体が動かないことを確認した。ガードは単一worker内の仕組みで、別プロセス・別端末の排他ではない。

実browser生成後のwatchdog期限切れ `d1e23f38-559f-4d2d-af2e-ed7b4f66ef83` は元のinterruptをcauseとして終了1、timeout FAIL、両mock復元probeと専用環境回収を記録。業務失敗と復元失敗の同時注入 `6b79a0ed-a2ff-4fa0-96e9-984ca1bcf522` は文言不一致のcauseとCAS409のsuppressed例外を保持し、後続sentinelを拒否。添付先への実filesystem書込み失敗 `226ad2e5-912a-4e3f-8374-f05f6bd1ce03` は業務PASS・復元／環境回収completed・attachment failed・runner failedを分けた。これらは意図的な業務またはrunnerの非成功である。外側の全体強制期限と、停止しない外部処理に対するcleanup時間の完全な上限は未証明。

後処理に単調時計の独立60秒予算を追加し、body watchdog停止後、同一threadでbrowser／Playwright終了、mockの条件付き復元とprobe、所有MySQLの停止確認へ残時間を渡す。`cdffa846-6132-4660-9948-c1489d48845f` はbrowser起動後の本体期限切れに対し、元interrupt・非成功を維持し、browser・両mock・環境を予算内に回収。`ca5cb259-66f1-4d91-9c82-ce0fe3ed3398` は本体の誤文言に加えてcleanup予算を1msへ短縮した故障で、元causeを維持し、予算超過・browser／mock／環境回収失敗・終了1を記録した。停止確認できない専用DBのdirは自動削除せず、実行後に対象mysqldが残っていないことを確認してそのdirだけを手動回収した。非協調なOS／driverのhard hangや強制終了を完全回収する保証ではない。これらも後続のexternal adapter抽出前のソース版である。

### 統合候補の確認台帳

Javaの共通UI進行を `UiCaseRunner`、demo-items固有adapterを `targets/demoitems`、バッチ／cross共通の専用環境を `targets/reference` に整理した固定コピーで、通常契約20件・借用環境1件・UI9件が成功（skip 0）。UI9件後に要約へ生成キーのhashを1行追加し、その版の固定A成功 `34558be4-3a05-49a5-aebf-96e37b8ff77f` と503 `f2ca56f8-40bf-4329-b514-69a1bcafe049` を再実行し両方成功。借用環境は共通ケースの成功後に試験行と外部所有サーバーが残ることをローカル代役で確認した。C02のregion/version/instanceId不一致は実HTTP契約試験で個別に409・状態不変を確認した。

最終UIソース版の故障は、復元競合 `5ef8af41-303e-4f5c-9710-b5866883b3ba`（業務PASS・復元失敗・後続sentinel本体不実行）、本体timeout `dc2d979d-7380-43f5-9580-1096a4e12060`（元interrupt・browser/mock/環境を独立予算内に回収）、cleanup予算超過 `826a64f1-c488-455a-9cf9-050de55f9d74`（業務FAILとcleanup失敗を保持、未確認の専用DB dirはプロセス終了確認後に手動回収）、誤文言 `422b6f89-f0ad-4f07-b25d-eb45cbcf4fb6`（A200/B429へ復元probe）、DB誤status `d24336bf-b4b1-429d-b410-19f11f925ad5`、業務と復元の同時失敗 `a7d5247a-17ed-4185-98be-95c88713cc0a`（元causeとCAS409 suppressed・sentinel不在）、添付失敗 `84051a95-43d2-4c81-9b7e-85cab1454885`。各runは意図した非成功であり、実行結果と復元を要約で区別する。

reference helper切出し後の小バッチ `64d7750e-af90-42a9-a006-5846fc32d6d6` は全table比較と9 SQL故障のキー／種別検出を含み成功。cross `df711d74-bf0e-4da3-a213-f9410c0dadc2` は実HTTP区間内に完全包含する2 SQLで137→138を観測し、最終全行比較とUI、環境回収が成功。no-overlap `518c682e-2c1d-4897-8667-a2973bb082af` は未確認・終了1、同期後比較と最終UI・環境回収は成功した。前記3万行測定 `aab23167-0ada-4dcc-82b6-3d2304c6e77f` はhelper切出し前の別ソース版であり、数値をこの小バッチrunへ流用しない。

固定コピーと作業元のsource/config/resource 61ファイルはSHA-256一致し、対象runの要約22件は作業元へコピー後にSHA-256一致と0600を確認した。`./gradlew --version` は公式SHA-256付きWrapperでGradle 8.14.2 / Temurin Java 17を起動、`./gradlew installDist` は成功。外部環境の設定・非所有closeはfakeで確認したが、実AWS、実TLS、Docker buildは未実施。共有DBに作られる試験行は旧契約どおり保持し、要約の生成キーを手掛かりに片付けが必要である。


### 代表3ケースによる設計確認

目的は設計方針を小さく検証することであり、本番品質や各パターンの網羅を完成とするものではない。UI・同期バッチ・同期中UIの代表経路を Java 17 / Gradle で通し、ケース進行、対象固有adapter、共通の所有プロセス・後処理・証跡を分ける配置が、このデモの範囲で機能することを確認した。

試行で方針を具体化した点は、Gradle failFastだけに依存せず後続開始を明示的に止めること、bodyと独立したcleanup予算を設けること、同期中UIの成立を実HTTP区間内のコミット済みDB変化に限ること、共有環境のDB行と非所有資源を専用DBの破棄と区別すること。実対象の認証・AWS・実TLS、共有DBの片付け方、時刻や強制停止の限界は保留として残す。追加の網羅性を今回の完了条件にはしない。

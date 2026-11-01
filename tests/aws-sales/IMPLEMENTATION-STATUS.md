# AWS業務試験の実装状況

現時点ではAWS業務7ケースを実行できない。`aws-sales:test` はSSO試験だけを列挙する。固定fixtureとMySQLの全件比較、ロック部品はあるが、専用環境の所有確認、初期化、ケース実行、JobとPodの停止確認、復元、証跡は未接続。

`SALES_RUN_ID` に32文字の小文字16進数を指定すると `aws/render-sales.cjs` は `sales-test-<ID>` namespace と `sales_test_<ID>` DB名を生成する。名前だけでは専用DBの所有・隔離は証明できず、この出力を既存環境へ適用して試験を開始してはならない。SSO Ingressの描画にも同じIDを渡すと同じnamespaceの `sales-app` を指す。ただしDNS・ALB・認証先・DBが同一実行に属する検証は未実装。Jobには180秒の実行期限を付けているが、Job起動やタイムアウト後の所有確認・停止確認は未実装。通常の学習用IFは本番外部サービスではない。

## ローカルMySQLの照合検証

`aws/tests/mysql-isolated.test.ts` は**破棄可能なローカルMySQL**のUNIXソケットを明示した場合のみ実行する。rootで接続し `sales_qa_` と乱数から作った専用DBをCREATEし、終了時にDROPする。既存DBやAWSには使用しない。

```sh
TEST_MYSQL_SOCKET=/tmp/LOCAL_MYSQL_SOCKET node --test aws/tests/mysql-isolated.test.ts
```

この試験はMySQLの同期、照合、在庫欠落・値不正・余剰行の検出、不正入力時のDB不変、在庫復元と受注を検証する。AWSのTLS経路、Kubernetes、SSO、7ケースの実行や復旧を検証したことにはならない。

`aws/tests/mysql-tls.test.ts` は、明示したローカルMySQLソケットとCAファイルを使い、証明書の名前一致・不一致を確認する。サーバー証明書のSANは `mysql-test.local` が必要。実RDSへの到達経路やTLSの実機確認ではない。

## private RDSへの接続部品

`tests/aws-sales/mysql-tunnel.ts` は `kubectl exec -i` で試験用アプリPod内のNodeを起動し、PodからRDSへのTCP通信を中継する。ローカルPCからprivate RDSへ直接接続する必要はなく、追加の有料中継サービスも不要。DB名は実行IDから決め、mysql2はRDSのホスト名でCAと証明書名を検証する。対象PodへexecできるKubernetes RBACとPodからRDSへの経路、CAとDB認証情報が必要。

この部品はまだ業務試験に接続されていない。呼び出し前にアカウント・context・namespace・Pod所有者、PodのDB_HOSTとDB_NAME、Ingress・ALB・DNSを検証する処理も未実装であり、この部品だけで安全な隔離は成立しない。実AWS・実Kubernetesでの動作は未確認。ローカルの `aws/tests/mysql-tunnel.test.ts` は模擬kubectlと実MySQLを使い、SQLとTLS名不一致を確認する。

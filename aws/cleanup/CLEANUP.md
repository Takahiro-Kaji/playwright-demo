# AWS削除と残存確認

この手順は、**専用の検証環境**でこの販売管理デモの3つのTerraform stateに登録されたリソースと、このデモが作る `sales-sso` Ingressを対象にする。AWSは未構築であり、この手順の実AWS検証・削除は未実施。EC2、EBS、RDS、ECRイメージ等が削除され、デモDBは復元できない（最終スナップショットなし）。外部DNS、ACM証明書、IdP、Load Balancer ControllerやそのIAMロールなど、別途用意したものは自動削除しない。

## 構築前の準備

1. 実行ごとに一意な `project_name` と、専用AWSアカウントまたは厳密に分離した環境を選ぶ。Terraformのinfraと両リージョンのSSOは**別々のstate**にする。作成コマンドと同じディレクトリ、workspace、backend、tfvars、AWSプロファイルを片付け時にも使う。state、backend、プロバイダーロック、設定と識別子を最後まで保持する。SSOを同一ディレクトリで使う場合はリージョン別workspaceが必要。stateを手動削除しない。
2. [config.example.json](config.example.json) を `.local/cleanup-config.json` にコピーし、実際のAWSアカウントID、primary/secondaryリージョンの順番、両kubectl context、3 stateのディレクトリ・workspace・tfvars絶対パスを設定する。各ディレクトリを同じbackendで `terraform init` し、実際に使うworkspaceを作成済みとする。AWS CLIの認証情報とTerraformの認証情報は同一にする。例: `export AWS_PROFILE=YOUR_PROFILE`。使用前に `aws sts get-caller-identity`、各stateの中身と `kubectl config` を確認する。
3. `aws/sso/ingress.yaml.tpl` の所有ラベルを保持する。IngressはコントローラーによりALBが作られる。作成したDNS名、証明書、コントローラーの追加リソース、マネージド以外のリソースを手元で記録する。これらはTerraform stateだけでは追跡できない。

## 一括削除と確認

構築が完了または中断した後、削除前に次を実行する。inventoryは識別子・stateハッシュを含むので `.local/` 内に保持し、コミットしない。既存ファイルは上書きしない。実行時は毎回新しいファイル名を指定する。

```sh
mkdir -p .local
python3 aws/cleanup/cleanup.py inventory .local/cleanup-config.json --output .local/cleanup-inventory.json
```

記録内容を確認し、表示されたアカウント・対象・stateが今回作成したものだけであることを確かめる。検証環境内のVPCに他のALB、EC2等があればinventoryにも含まれ得る。確認結果は手動で精査する。削除コマンドはEKS contextの接続先とAWSアカウントを検証し、ラベル付きの `sales-sso` Ingressだけを削除する。ControllerがALBとターゲットグループを削除するまで待ってから再実行する。未削除ならTerraform破棄に進まない。

```sh
python3 aws/cleanup/cleanup.py destroy .local/cleanup-inventory.json
python3 aws/cleanup/cleanup.py verify .local/cleanup-inventory.json
```

`destroy` は両Ingressの削除後、SSOの2 state、最後にインフラstateの順で `terraform destroy -var-file=...` を実行する。Terraformは各stateのplanを表示し承認を求める。`-auto-approve`、`-target`、stateの手動変更は使わない。Terraformが途中で止まれば後続へ進まない。stateがinventory後に変わった場合も止まる。stateを正しく管理していないリソースはTerraformでは削除されない。処理開始後に権限が変わった場合も操作を中断する。

`verify` は記録したstateが空であることと、削除前に記録したVPC内のEC2、接続中またはEKSタグ付きEBS、NAT、NATのEIP、ALB、ターゲットグループ、VPC、state上のRDS・ECR・EKS・Cognito・IAMロールをAWS APIから確認する。削除中のNATは残存扱い、`deleted` は削除済み扱いにする。APIエラーや権限不足は `UNCONFIRMED`・終了コード2、残存または未確認は終了コード1。削除が非同期のため、時間を置いて同じinventoryで再確認する。`verify` 成功は記録した対象の不在であり、AWSアカウント全体に課金対象がないことの証明ではない。

## 構築途中で失敗した場合

- 作成済みstateがあれば破棄せず、そのstate・workspaceを上記configへ登録してinventoryから実行する。stateの一部しか作られていなくても、記録されている範囲を扱う。通常の破棄も中断したら、既存inventoryを保持したまま**新しい名前で再inventory**してから `destroy` を再実行し、最後は元と新しい両方のinventoryで `verify` する。
- 実際に一度も着手していないstateだけは、該当stateのエントリーに `"not_started": true` を設定できる。残りは削除できるが、その範囲の存在確認は自動ではできず、verifyは `UNCONFIRMED` を返す。stateを紛失した・書き込み失敗の可能性がある場合は `not_started` と決めつけず、Terraformのバックアップ、backend、AWS側のタグ・CloudTrail等からリソースを特定する。所有者とIDが確定するまで削除しない。
- クラスター自体が消えた、controllerが停止した、Ingress finalizerが残る等で停止する場合、コマンドを繰り返すだけでなく、AWS上のALB・ターゲットグループのIDと所有関係を確認する。コントローラーを復旧するか、当該リソースだけをAWS側で適切に片付けた後、再inventoryする。finalizerを無条件に除去しない。SSO stateやインフラstateの破棄に進む前にALBを確認する。
- エラー、stateの欠落、確認権限不足、対象を一意に決められない場合は「未確認」として残す。stateから外れたリソースを名前だけで自動削除しない。

## 手動で追加確認する範囲

両リージョンのコンソール・CLIで、記録しきれなかった孤立EBS、未関連付けEIP、ENI、セキュリティグループ、DBスナップショット、自動生成Secrets Managerシークレット、CloudWatch Logs、IAMロール・OIDC provider、未追跡のLB・ターゲットグループ、Route 53・ACM・IdP等を確認する。特にstate書込み前に作成されたリソース、タグがないもの、後から追加したサービス、Controllerが別途作成したものは自動確認の対象外。関連リソースの所有関係を確認してから個別に片付ける。Kubernetes Secret・ローカル認証ファイルや、許可されていないログも必要に応じて削除する。

参考: [EKS削除時のIngressとLB](https://docs.aws.amazon.com/eks/latest/userguide/delete-cluster.html)、[NAT削除とEIP](https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateway-working-with.html)、[Terraform destroy](https://developer.hashicorp.com/terraform/cli/commands/destroy)。

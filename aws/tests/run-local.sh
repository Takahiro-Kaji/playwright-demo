#!/usr/bin/env bash
# 専用の使い捨てローカルkindとMySQL 8.4を使用する。AWS CLIは呼び出さない。
set -euo pipefail
cd "$(dirname "$0")/../.."
cluster=sales-pr9-qa
if kind get clusters 2>/dev/null | rg -qx "$cluster"; then
  echo 'LOCAL_CLUSTER_ALREADY_EXISTS: reuse it explicitly or clean up its owner run first' >&2
  exit 1
fi
qa_id="pr9-$(date +%s)-$$"
qa_dir="$PWD/.local/aws-sales-qa/$qa_id"
mkdir -p "$qa_dir"
chmod 700 "$qa_dir"
export AWS_SALES_LOCAL_JOURNAL="$qa_dir/journal.json"
export TEST_MYSQL_CA="$qa_dir/ca.pem"
export AWS_SALES_ADMIN_USER=root
export AWS_SALES_ADMIN_PASSWORD=local-only
mysql_name="sales-qa-mysql-$qa_id"
original_context=$(kubectl config current-context 2>/dev/null || true)
made_cluster=0
made_mysql=0
finish() {
  local status=$?
  trap - EXIT
  if [[ -f "$AWS_SALES_LOCAL_JOURNAL" ]]; then
    if ! node aws/tests/local-manage.ts cleanup; then
      echo "LOCAL_RECOVERY_REQUIRED: $AWS_SALES_LOCAL_JOURNAL (cluster and MySQL retained)" >&2
      exit 1
    fi
  fi
  if [[ "$made_cluster" == 1 ]]; then kind delete cluster --name "$cluster"; fi
  if [[ "$made_mysql" == 1 ]]; then
    [[ $(docker inspect --format '{{index .Config.Labels "sales-business-qa"}}' "$mysql_name") == "$qa_id" ]]
    docker rm -f "$mysql_name" >/dev/null
  fi
  if [[ -n "$original_context" ]]; then kubectl config use-context "$original_context" >/dev/null; fi
  exit "$status"
}
trap finish EXIT
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1 \
  -subj '/CN=db.region.rds.amazonaws.com' -addext 'subjectAltName=DNS:db.region.rds.amazonaws.com' \
  -keyout "$qa_dir/key.pem" -out "$TEST_MYSQL_CA" >/dev/null 2>&1
chmod 644 "$qa_dir/key.pem" # synthetic test key, readable by container MySQL UID
kind create cluster --name "$cluster" --image kindest/node:v1.29.0 --wait 60s
made_cluster=1
docker run -d --name "$mysql_name" --label "sales-business-qa=$qa_id" --network kind \
  --network-alias db.region.rds.amazonaws.com -e MYSQL_ROOT_PASSWORD=local-only -e MYSQL_ROOT_HOST=% \
  -v "$qa_dir:/certs:ro" mysql:8.4.5 --ssl-ca=/certs/ca.pem --ssl-cert=/certs/ca.pem --ssl-key=/certs/key.pem >/dev/null
made_mysql=1
image=123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/sales:qa
docker build -f aws/sales/Dockerfile -t "$image" .
kind load docker-image --name "$cluster" "$image"
node aws/tests/local-manage.ts prepare
set +e
npm run aws-sales:local -- "$@"
suite_code=$?
set -e
node --test aws/tests/local-sql.test.ts
echo "LOCAL_BUSINESS_EXIT=$suite_code (Cognito/ALB are simulated)"
exit "$suite_code"

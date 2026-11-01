#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/aws-common.sh"
if [[ -e "$ROOT/.env" ]]; then echo 'Back up/remove the old .env first; refusing to overwrite.' >&2; exit 2; fi
umask 077
cat > "$ROOT/.env" <<EOF
TEST_ENV=staging
BASE_URL=http://127.0.0.1:18080
REGION_A=$(output region)
REGION_B=$(output secondary_region)
KUBE_CONTEXT_A=$(output cluster_name)
KUBE_CONTEXT_B=$(output secondary_cluster_name)
KUBE_NAMESPACE=integration-demo
APP_URL_A=http://127.0.0.1:18081
APP_URL_B=http://127.0.0.1:18082
MOCK_URL_A=http://127.0.0.1:19081
MOCK_URL_B=http://127.0.0.1:19082
MOCK_ADMIN_URL_A=http://127.0.0.1:19181
MOCK_ADMIN_URL_B=http://127.0.0.1:19182
MOCK_CURL_CONFIG=$HOME/.config/play-right-demo/mock-curl.conf
MYSQL_HOST=127.0.0.1
MYSQL_PORT=13306
MYSQL_DATABASE=integration_demo
MYSQL_USER=integration_ro
MYSQL_OPTIONS_FILE=$HOME/.config/play-right-demo/mysql-readonly.cnf
EOF
echo 'Created two-region .env (no passwords).'

#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/aws-common.sh"
TARGET="$ROOT/.env"
if [[ -e "$TARGET" ]]; then
  echo ".env already exists; refusing to overwrite. Back up or edit it manually." >&2; exit 2
fi
umask 077
cat > "$TARGET" <<EOF
TEST_ENV=staging
BASE_URL=http://127.0.0.1:18080
KUBE_CONTEXT=$CONTEXT
KUBE_NAMESPACE=integration-demo
KUBE_DEPLOYMENT=demo-app
MOCK_DEPLOYMENT=status-mock
MYSQL_HOST=127.0.0.1
MYSQL_PORT=13306
MYSQL_DATABASE=integration_demo
MYSQL_USER=integration_ro
MYSQL_OPTIONS_FILE=$HOME/.config/play-right-demo/mysql-readonly.cnf
EOF
echo 'Created .env for local Chrome + kubectl port-forwards (no passwords).'

#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/aws-common.sh"
kubectl --context "$CONTEXT" -n integration-demo delete deployment/db-tunnel service/db-tunnel --ignore-not-found=true
echo 'DB tunnel removed. Re-run scripts/deploy.sh core before another integration test.'

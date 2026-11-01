#!/usr/bin/env bash
set -euo pipefail
if [[ -z "${SLOT:-}" ]]; then
  SLOT=a bash "$0" "${1:-}"
  SLOT=b bash "$0" "${1:-}"
  exit
fi
source "$(dirname "$0")/aws-common.sh"
PHASE="${1:-}"
if [[ "$PHASE" != "core" && "$PHASE" != "app" ]]; then
  echo 'Usage: scripts/deploy.sh core|app' >&2; exit 2
fi
if [[ ! -f "$ROOT/.deploy-$SLOT.env" ]]; then
  echo 'Build/push images first: scripts/build-push.sh' >&2; exit 2
fi
# Shell file is generated locally by build-push.sh and ignored by Git.
source "$ROOT/.deploy-$SLOT.env"
RDS_HOST="$(output database_host)"
APP_REGION="$REGION"
export APP_IMAGE MOCK_IMAGE RDS_HOST APP_REGION
kubectl --context "$CONTEXT" apply -f "$ROOT/k8s/namespace.yaml"
if [[ "$PHASE" == "core" ]]; then
  kubectl --context "$CONTEXT" -n integration-demo get secret mock-admin >/dev/null
  node "$ROOT/scripts/render-k8s.cjs" "$ROOT/k8s/status-mock.yaml.tpl" | kubectl --context "$CONTEXT" apply -f -
  if [[ "$SLOT" == a ]]; then
    node "$ROOT/scripts/render-k8s.cjs" "$ROOT/k8s/db-tunnel.yaml.tpl" | kubectl --context "$CONTEXT" apply -f -
    kubectl --context "$CONTEXT" -n integration-demo rollout status deployment/db-tunnel --timeout=180s
  fi
  kubectl --context "$CONTEXT" -n integration-demo rollout status deployment/status-mock --timeout=180s
else
  kubectl --context "$CONTEXT" -n integration-demo get secret app-db >/dev/null
  kubectl --context "$CONTEXT" -n integration-demo get configmap rds-ca >/dev/null
  node "$ROOT/scripts/render-k8s.cjs" "$ROOT/k8s/demo-app.yaml.tpl" | kubectl --context "$CONTEXT" apply -f -
  kubectl --context "$CONTEXT" -n integration-demo rollout status deployment/demo-app --timeout=180s
fi

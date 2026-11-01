#!/usr/bin/env bash
set -euo pipefail
if [[ -z "${SLOT:-}" ]]; then
  SLOT=a bash "$0"
  SLOT=b bash "$0"
  exit
fi
source "$(dirname "$0")/aws-common.sh"
aws eks update-kubeconfig --region "$REGION" --name "$CLUSTER" --alias "$CONTEXT"
kubectl --context "$CONTEXT" get nodes

#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/aws-common.sh"
aws eks update-kubeconfig --region "$REGION" --name "$CLUSTER" --alias "$CONTEXT"
kubectl --context "$CONTEXT" get nodes

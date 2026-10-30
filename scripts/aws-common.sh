#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output() { terraform -chdir="$ROOT/infra" output -raw "$1"; }
REGION="$(output region)"
CLUSTER="$(output cluster_name)"
CONTEXT="$CLUSTER"

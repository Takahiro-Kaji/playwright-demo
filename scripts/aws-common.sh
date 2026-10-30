#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output() { terraform -chdir="$ROOT/infra" output -raw "$1"; }
SLOT="${SLOT:-a}"
PREFIX=""
if [[ "$SLOT" == b ]]; then PREFIX=secondary_; elif [[ "$SLOT" != a ]]; then echo 'SLOT must be a or b' >&2; exit 2; fi
REGION="$(output "${PREFIX}region")"
CLUSTER="$(output "${PREFIX}cluster_name")"
CONTEXT="$CLUSTER"

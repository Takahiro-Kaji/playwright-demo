#!/usr/bin/env bash
set -euo pipefail
if [[ -z "${SLOT:-}" ]]; then
  SLOT=a bash "$0"
  SLOT=b bash "$0"
  exit
fi
source "$(dirname "$0")/aws-common.sh"
APP_REPO="$(output "${PREFIX}app_ecr_url")"
MOCK_REPO="$(output "${PREFIX}mock_ecr_url")"
REGISTRY="${APP_REPO%%/*}"
TAG="$(date -u +%Y%m%d%H%M%S)-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo demo)"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
docker build --platform linux/amd64 -t "$APP_REPO:$TAG" -f "$ROOT/services/demo-app/Dockerfile" "$ROOT"
docker build --platform linux/amd64 -t "$MOCK_REPO:$TAG" -f "$ROOT/services/status-mock/Dockerfile" "$ROOT"
docker push "$APP_REPO:$TAG"
docker push "$MOCK_REPO:$TAG"
umask 077
printf 'APP_IMAGE=%s\nMOCK_IMAGE=%s\n' "$APP_REPO:$TAG" "$MOCK_REPO:$TAG" > "$ROOT/.deploy-$SLOT.env"
printf 'Published two images to ECR. Image references recorded per region in .deploy-a.env / .deploy-b.env (gitignored).\n'

#!/usr/bin/env bash
# swarm-os — manual image publish to GHCR.
#
# Fallback for the GitHub Actions workflow (.github/workflows/release-image.yml)
# when you want to publish from your own machine.
#
# Prereqs:
#   - docker login ghcr.io   (with a PAT that has write:packages)
#   - run from anywhere; the script cd's to the repo root
#
# Usage:
#   scripts/push-image.sh v0.1.0                 # builds + pushes :0.1.0 and :latest
#   IMAGE=ghcr.io/luminis1986/swarm-os scripts/push-image.sh v0.1.0
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

IMAGE="${IMAGE:-ghcr.io/luminis1986/swarm-os}"
VERSION="${1:?usage: scripts/push-image.sh <version>   e.g. v0.1.0}"
TAG="${VERSION#v}"   # strip a leading "v" → 0.1.0

# Same build args the CI workflow passes. Without them the server reports
# version "dev" on /info and the OCI version/revision labels are empty — i.e.
# an image indistinguishable from a local scratch build. We already cd'd to
# REPO_ROOT above, so rev-parse resolves against this repo.
GIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo '')"

echo "==> Building ${IMAGE}:${TAG} (+ :latest)  [commit ${GIT_SHA:-unknown}]"
docker build \
  --build-arg "APP_VERSION=${TAG}" \
  --build-arg "GIT_SHA=${GIT_SHA}" \
  -t "${IMAGE}:${TAG}" -t "${IMAGE}:latest" .

echo "==> Pushing ${IMAGE}:${TAG}"
docker push "${IMAGE}:${TAG}"
echo "==> Pushing ${IMAGE}:latest"
docker push "${IMAGE}:latest"

echo "==> Done. Consumers pull with:  docker pull ${IMAGE}:${TAG}"

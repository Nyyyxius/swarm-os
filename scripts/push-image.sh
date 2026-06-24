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

echo "==> Building ${IMAGE}:${TAG} (+ :latest)"
docker build -t "${IMAGE}:${TAG}" -t "${IMAGE}:latest" .

echo "==> Pushing ${IMAGE}:${TAG}"
docker push "${IMAGE}:${TAG}"
echo "==> Pushing ${IMAGE}:latest"
docker push "${IMAGE}:latest"

echo "==> Done. Consumers pull with:  docker pull ${IMAGE}:${TAG}"

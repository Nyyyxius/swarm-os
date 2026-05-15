#!/usr/bin/env bash
# Phase 7 — Docker smoke test (MANUAL).
#
# Builds the swarm-os image, brings it up against an isolated tmp workspace,
# waits for /health, hits a few REST endpoints, then tears down.
#
# Why it's MANUAL (not part of `pnpm test`):
#   - Docker build takes ~minutes on a cold cache (npm install of the claude
#     CLI alone is ~30 MB).
#   - Requires a working Docker daemon and a free local port.
#
# Run from repo root:
#   bash scripts/smoke-docker.sh
#
# Exit codes: 0 PASS / 1 FAIL / 2 prerequisites missing.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

IMAGE_TAG="swarm-os:smoke-$$"
CONTAINER_NAME="swarm-os-smoke-$$"
SMOKE_DIR="$REPO_ROOT/.smoke"
WORKSPACE_DIR="$SMOKE_DIR/workspace"
CLAUDE_SOURCE_DIR="$SMOKE_DIR/claude-source"
DATA_DIR="$SMOKE_DIR/data"
HOST_PORT=18799

PASS=0
FAIL=0

pass() { echo "[PASS] $*"; PASS=$((PASS + 1)); }
fail() { echo "[FAIL] $*"; FAIL=$((FAIL + 1)); }

cleanup() {
  echo "--- tearing down container/image ---"
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker rmi -f "$IMAGE_TAG" >/dev/null 2>&1 || true
  rm -rf "$SMOKE_DIR"
}
trap cleanup EXIT

echo "--- prerequisites ---"
if ! command -v docker >/dev/null 2>&1; then
  echo "[SKIP] docker not installed — set MANUAL marker"
  exit 2
fi
if ! docker info >/dev/null 2>&1; then
  echo "[SKIP] docker daemon not reachable — set MANUAL marker"
  exit 2
fi

echo "--- building image $IMAGE_TAG ---"
if ! docker build -t "$IMAGE_TAG" . ; then
  fail "docker build"
  exit 1
fi
pass "docker build"

echo "--- preparing tmp dirs ---"
rm -rf "$SMOKE_DIR"
mkdir -p "$WORKSPACE_DIR" "$CLAUDE_SOURCE_DIR" "$DATA_DIR"
echo "smoke" > "$WORKSPACE_DIR/README.md"
pass "tmp dirs ready"

echo "--- starting container on host port $HOST_PORT ---"
if ! docker run -d \
  --name "$CONTAINER_NAME" \
  --init \
  -p "127.0.0.1:${HOST_PORT}:8787" \
  -v "${WORKSPACE_DIR}:/workspace" \
  -v "${CLAUDE_SOURCE_DIR}:/claude-source:ro" \
  -v "${DATA_DIR}:/data" \
  -e "SWARM_OS_PROJECT_NAME=smoke" \
  -e "SWARM_OS_TOKEN=smoke-token" \
  -e "HOOK_TOKEN=smoke-hook" \
  -e "SWARM_OS_LOG_LEVEL=warn" \
  "$IMAGE_TAG" >/dev/null; then
  fail "docker run"
  exit 1
fi
pass "docker run"

echo "--- waiting for /health (up to 30s) ---"
HEALTH_OK=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${HOST_PORT}/health" >/dev/null 2>&1; then
    HEALTH_OK=1
    break
  fi
  sleep 1
done
if [[ "$HEALTH_OK" != "1" ]]; then
  fail "/health did not come up — container logs follow"
  docker logs "$CONTAINER_NAME" | tail -50
  exit 1
fi
pass "/health responded"

echo "--- /info ---"
INFO=$(curl -fsS "http://127.0.0.1:${HOST_PORT}/info")
echo "$INFO"
if echo "$INFO" | grep -q '"project_name":"smoke"'; then
  pass "/info reports project_name=smoke"
else
  fail "/info missing project_name"
fi

echo "--- GET /orchestrators (with token) ---"
ORCH_LIST=$(curl -fsS -H "X-Auth-Token: smoke-token" "http://127.0.0.1:${HOST_PORT}/orchestrators")
echo "$ORCH_LIST"
if echo "$ORCH_LIST" | grep -q '"orchestrators":'; then
  pass "GET /orchestrators returns the orchestrators array"
else
  fail "GET /orchestrators unexpected payload"
fi

echo "--- GET /orchestrators (no token) → 401 ---"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${HOST_PORT}/orchestrators")
if [[ "$STATUS" == "401" ]]; then
  pass "GET /orchestrators (no token) → 401"
else
  fail "GET /orchestrators (no token) → $STATUS (expected 401)"
fi

echo ""
echo "----------------------------------------"
echo "PASS: $PASS"
echo "FAIL: $FAIL"
echo "----------------------------------------"
if [[ "$FAIL" -gt 0 ]]; then
  echo "smoke FAILED"
  exit 1
fi
echo "smoke PASS"
exit 0

#!/usr/bin/env bash
# swarm-os — one-shot installer / updater for a third-party deployment.
#
# What it does:
#   1. checks Docker + Docker Compose v2 are available
#   2. creates .env from .env.example on first run (then stops for you to edit)
#   3. checks you have authenticated Claude Code credentials on the host
#   4. pulls the image from the registry (logging in if needed)
#   5. brings the container up and waits for /health
#   6. prints the access token + URL
#
# Safe to re-run after editing .env or to update to a newer image tag.
#
# Usage:  ./install.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

COMPOSE_FILE="examples/docker-compose.dist.yml"
ENV_FILE=".env"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n'  "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n'  "$*" >&2; exit 1; }

# ── 1. Docker + Compose ───────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 \
  || die "Docker is not installed. See https://docs.docker.com/engine/install/"
docker info >/dev/null 2>&1 \
  || die "Docker daemon not reachable. Is it running? (you may need the docker group)"
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  die "Docker Compose v2 not found. See https://docs.docker.com/compose/install/"
fi
say "Docker OK"

# ── 2. .env (first-run bootstrap) ─────────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  cp .env.example "$ENV_FILE"
  warn "Created $ENV_FILE from .env.example."
  warn "Edit it (SWARM_OS_IMAGE, WORKSPACE_PATH, DATA_PATH, CLAUDE_DIR ...),"
  warn "then run ./install.sh again."
  exit 0
fi
# `source` so ${HOME} in paths is expanded by the shell, then export for compose.
set -a; . "./$ENV_FILE"; set +a
say "Loaded $ENV_FILE"

: "${SWARM_OS_IMAGE:?SWARM_OS_IMAGE is empty — set it in .env}"
: "${CLAUDE_DIR:=$HOME/.claude}"
: "${SWARM_OS_CONTAINER_NAME:=swarm-os}"
: "${SWARM_OS_PORT:=8787}"

# ── 3. Claude credentials (the critical prerequisite) ─────────────────────────
if [[ ! -f "$CLAUDE_DIR/.credentials.json" ]]; then
  warn "No Claude Code credentials at $CLAUDE_DIR/.credentials.json"
  warn "Agents CANNOT start without them. Install the Claude Code CLI and log in:"
  warn "    npm i -g @anthropic-ai/claude-code"
  warn "    claude        # complete the OAuth login once"
  die  "Claude credentials missing — log in, then re-run ./install.sh."
fi
say "Claude credentials found at $CLAUDE_DIR"

# ── 4. Validate host paths ────────────────────────────────────────────────────
[[ -n "${WORKSPACE_PATH:-}" ]] || die "WORKSPACE_PATH is empty in .env"
[[ -d "$WORKSPACE_PATH" ]]     || die "WORKSPACE_PATH does not exist: $WORKSPACE_PATH"
[[ -n "${DATA_PATH:-}" ]]      || die "DATA_PATH is empty in .env"
mkdir -p "$DATA_PATH"

# ── 5. Pull image ─────────────────────────────────────────────────────────────
registry="${SWARM_OS_IMAGE%%/*}"
say "Pulling $SWARM_OS_IMAGE"
if ! docker pull "$SWARM_OS_IMAGE"; then
  warn "Pull failed. If this is a private registry, log in first:"
  warn "    echo <YOUR_GITHUB_PAT> | docker login ${registry} -u <github-user> --password-stdin"
  warn "(the PAT needs the read:packages scope)"
  die  "Could not pull the image."
fi

# ── 6. Up + wait for health ───────────────────────────────────────────────────
say "Starting container ${SWARM_OS_CONTAINER_NAME}..."
"${COMPOSE[@]}" -f "$COMPOSE_FILE" up -d

say "Waiting for /health on http://127.0.0.1:${SWARM_OS_PORT} ..."
ok=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${SWARM_OS_PORT}/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [[ "$ok" != 1 ]]; then
  warn "Server did not become healthy in time. Recent logs:"
  "${COMPOSE[@]}" -f "$COMPOSE_FILE" logs --tail 40 || true
  die "Startup failed."
fi
say "Server is healthy."

# ── 7. Token + URL ────────────────────────────────────────────────────────────
token=""
for _ in $(seq 1 10); do
  token="$(docker exec "$SWARM_OS_CONTAINER_NAME" cat /data/token 2>/dev/null || true)"
  [[ -n "$token" ]] && break
  sleep 1
done

echo
say "swarm-os is up."
echo "  URL:   http://127.0.0.1:${SWARM_OS_PORT}"
if [[ -n "$token" ]]; then
  echo "  Token: $token"
  echo "  → paste it into the Token panel of the web UI."
else
  warn "Could not read the token automatically. Get it with:"
  echo "  docker exec $SWARM_OS_CONTAINER_NAME cat /data/token"
fi
echo
echo "Remote access (Tailscale / reverse proxy / SSH tunnel) → docs/deploy/install.en.md"
echo "Usage guide → docs/deploy/usage.en.md (FR: usage.fr.md)"

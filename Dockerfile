# syntax=docker/dockerfile:1.6
#
# swarm-os — Phase 5 multi-stage Dockerfile.
#
# Layers:
#   builder  → installs full pnpm workspace + native build toolchain, runs
#              `pnpm -r build`, then `pnpm deploy --prod` to flatten the
#              server's runtime tree into a self-contained directory.
#   runtime  → minimal node:24-bookworm-slim + claude CLI + curl + tini,
#              runs as USER node, exposes only port 8787.
#
# Build:    docker build -t swarm-os:phase5 .
# Run:      see examples/docker-compose.{single,multi}.yml
#
# Plan refs: §6 (Phase 5), §13 (containerisation + env table), §14 (security).

# ---------------------------------------------------------------------------
# Stage 1 — builder
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS builder

# Native deps for node-pty + better-sqlite3 (compiled at install time).
# git is needed because some npm packages reference git URLs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
      git \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# pnpm via corepack (pinned via packageManager in package.json).
ENV CI=1
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

WORKDIR /build

# Copy lockfile + workspace manifests first to maximise layer cache.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/

# Resolve & install full graph (including devDeps) — needed for tsc + vite.
# `--frozen-lockfile` guarantees reproducibility; CI envs MUST not regenerate.
RUN pnpm install --frozen-lockfile

# Now copy source and build. tsconfigs + source code change less often than
# manifests in practice, so this keeps the install layer warm across rebuilds.
COPY tsconfig*.json ./
COPY eslint.config.js ./
COPY packages/server/tsconfig.json packages/server/
COPY packages/server/src packages/server/src
COPY packages/server/scripts packages/server/scripts
COPY packages/web/tsconfig.json packages/web/tsconfig.app.json packages/web/tsconfig.node.json packages/web/vite.config.ts packages/web/index.html packages/web/
COPY packages/web/src packages/web/src
# Phase 6: Vite copies packages/web/public/* verbatim into dist/ at build
# time. Holds: manifest.webmanifest, sw.js, icon-{192,512,maskable-512}.png,
# apple-touch-icon.png. Without this COPY the static file middleware in the
# server still serves index.html + assets/* but the PWA install + SW fail.
COPY packages/web/public packages/web/public

RUN pnpm -r build

# tsc doesn't copy non-.ts assets — replicate the src/preambles tree under
# dist/ so `preamble.ts`'s `__dirname/../preambles/` resolution works at
# runtime. Pre-existing gap exposed by Phase 5 packaging; documented here
# rather than added to the build script so any future bundler/tsc-alternative
# carries a clear breadcrumb.
RUN mkdir -p packages/server/dist/modules/preambles \
 && cp packages/server/src/modules/preambles/*.md packages/server/dist/modules/preambles/

# `pnpm deploy --prod --legacy` produces a self-contained runtime tree at
# /deploy with only production deps. The `--legacy` flag is required since
# pnpm 10: without `inject-workspace-packages=true` in the workspace config,
# the new deploy implementation refuses to run. Legacy is fine for a
# single-package workspace target.
# This avoids shipping the symlink farm of pnpm-store and the devDependencies
# (typescript, vite, eslint, …).
# We deploy *just the server* — the web is a static bundle the server doesn't
# even need at runtime today, but we copy it across separately so it ships
# next to the server (Phase 6 will likely wire express.static).
RUN pnpm --filter=server deploy --prod --legacy /deploy/server

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

# Runtime essentials:
#   - tini   → proper PID 1 / zombie reaper (also `init: true` in compose).
#   - curl   → required by the per-session Notification hook command
#              (see Phase 4 settings.json shellCmd) AND by HEALTHCHECK.
#   - python3 → JSON-escape fallback in the same hook command (Phase 4 §11
#              flagged this as a Phase 5 dependency to add). The plain-`sed`
#              fallback exists but loses unicode fidelity.
#   - git    → some npm post-install scripts call git; harmless to keep.
#              ~14 MB but it's also useful for in-container cwd inspection.
#   - bash   → one of the three interpreters a SCRIPT cron may declare
#              (docs/crons-agents.md §2.5, with python3 and node). Present by
#              Debian inheritance today, pinned here so a future slimmer base
#              cannot silently break every bash cron.
#   - ca-certificates → curl HTTPS + node fetch outbound.
#
# We deliberately do NOT install make / g++ / build-essential in runtime —
# the compiled native modules from the builder are copied verbatim. If a
# host kernel mismatch ever requires a relink, do it in a fresh builder.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini \
      curl \
      python3 \
      git \
      bash \
      ca-certificates \
      openssh-client \
      libatomic1 \
 && rm -rf /var/lib/apt/lists/*

# VS Code web — official Microsoft standalone CLI (`code`). Provides the
# `code serve-web` command the IDE supervisor (modules/ide) launches at runtime.
# The CLI downloads the web-server payload on first run into the serve-web
# `--server-data-dir` (under /data/ide, persisted on the host); the container
# has outbound network, so no build-time pre-warm is required.
#
# Marketplace: the official build uses the Microsoft Marketplace (unlike
# code-server / openvscode-server which use Open VSX).
#
# `latest` resolves to the newest stable; pin VSCODE_CLI_CHANNEL to a specific
# version for reproducible builds. `libatomic1` (installed above) is required
# by the VS Code server on bookworm-slim.
ARG VSCODE_CLI_CHANNEL=latest
ARG TARGETARCH
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) VSARCH=x64 ;; \
      arm64) VSARCH=arm64 ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    mkdir -p /opt/vscode-cli; \
    curl -fsSL "https://update.code.visualstudio.com/${VSCODE_CLI_CHANNEL}/cli-linux-${VSARCH}/stable" -o /tmp/vscode-cli.tar.gz; \
    tar -xzf /tmp/vscode-cli.tar.gz -C /opt/vscode-cli; \
    rm /tmp/vscode-cli.tar.gz; \
    /opt/vscode-cli/code --version

# Claude Code CLI — pinned to the version validated by the spike (§Phase 0 bis,
# H1: "2.1.142 (Claude Code)"). Bumping requires re-running `pnpm verify:claude`
# to confirm the flag contract is unchanged (--effort, --permission-mode,
# --mcp-config, settings.json hooks).
ARG CLAUDE_CODE_VERSION=2.1.142
RUN npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && claude --version

# graphify — code-knowledge-graph CLI (Graphify integration, modules/codegraph).
# Baked in so the server's codegraph janitor can run `graphify update` fully
# offline (tree-sitter grammars ship inside the wheel; AST engine needs no API
# key / no network at runtime). Installed with uv (static binary copied from the
# official image — reproducible, no `curl | sh`). `graphifyy` requires Python
# >=3.10; the runtime already carries Debian 12's python3 (3.11), so we force the
# system interpreter rather than downloading a managed one (keeps the image lean).
# UV_TOOL_BIN_DIR is pointed at /usr/local/bin so the launcher lands on PATH for
# the unprivileged `node` user; the venv lives under /opt/uv (root-owned, world-
# readable → node can execute but not mutate it). Pinned to the P0-validated
# version; bump requires re-checking the `update` CLI contract.
ARG GRAPHIFY_VERSION=0.9.32
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
RUN UV_TOOL_DIR=/opt/uv/tools UV_TOOL_BIN_DIR=/usr/local/bin \
    uv tool install --no-cache --python-preference only-system \
      "graphifyy==${GRAPHIFY_VERSION}" \
 && graphify --version

# Drop privileges. The `node` user is provided by the upstream image
# (uid 1000). Plan §14: container MUST run as non-root.
USER node
WORKDIR /home/node/app

# Copy the deployed server (production deps + dist + package.json) and the
# pre-built web bundle. `chown` so the `node` user owns everything — we
# can't chmod after the fact without root.
COPY --from=builder --chown=node:node /deploy/server/ ./
COPY --from=builder --chown=node:node /build/packages/web/dist/ ./web/

# Mount points. These are declared so Docker creates anon volumes when no
# host bind is provided — but in practice docker-compose always binds them.
#   /workspace      → project source (RW for the agent)
#   /claude-source  → host ~/.claude (RO, copied at boot to /data/.claude-runtime)
#   /data           → state: SQLite, tokens, logs, claude runtime copy
VOLUME ["/workspace", "/claude-source", "/data"]

# Default env. `SWARM_OS_HOST=0.0.0.0` makes the server accept connections
# from outside the container — Docker's port mapping handles the host-side
# binding to 127.0.0.1 (compose: "127.0.0.1:8787:8787"). Plan §14: NEVER
# expose without the loopback bind on the host.
ENV NODE_ENV=production \
    SWARM_OS_HOST=0.0.0.0 \
    SWARM_OS_PORT=8787 \
    SWARM_OS_MCP_PORT=8788 \
    SWARM_OS_DATA_DIR=/data \
    SWARM_OS_WORKSPACE_ROOT=/workspace \
    SWARM_OS_CLAUDE_SOURCE_DIR=/claude-source \
    SWARM_OS_CLAUDE_RUNTIME_DIR=/data/.claude-runtime \
    SWARM_OS_IDE_PORT=8790 \
    SWARM_OS_VSCODE_CLI=/opt/vscode-cli/code

# Build provenance — the single source of truth for "which version is this".
# `SWARM_OS_VERSION` is what config.ts reads at runtime and serves on /info;
# the OCI labels carry the same two values in the registry-visible metadata so
# `docker inspect` / `docker manifest inspect` agree with the running process.
#
# Declared AFTER the COPY layers on purpose: bumping the version then only
# invalidates metadata layers, never the pnpm install / `pnpm -r build` cache.
#
# Left unset (a plain `docker build .`), `ENV SWARM_OS_VERSION=` yields the
# EMPTY STRING, not an absent variable — config.ts treats empty as unset and
# falls back to the monorepo root package.json, then to 'dev'. CI passes both
# via --build-arg (see .github/workflows/release-image.yml).
ARG APP_VERSION=""
ARG GIT_SHA=""
ENV SWARM_OS_VERSION=${APP_VERSION} \
    SWARM_OS_COMMIT=${GIT_SHA}
LABEL org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}"

EXPOSE 8787
# Note: neither 8788 (MCP) nor 8790 (VS Code web `code serve-web`) is exposed.
# Plan §14 — single ingress. The MCP server is intra-container only; the editor
# binds loopback and is reverse-proxied by the main server under SWARM_OS_IDE_
# BASE_PATH (default /ide) on 8787, so it rides on the same port + TLS. Set
# SWARM_OS_IDE_ENABLED=false to disable the editor entirely.

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8787/health > /dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]

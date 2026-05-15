<!-- swarm-os — agent-readable README. Plain Markdown only (no mermaid/HTML). -->
<!-- TODO: choose a license. The repo currently ships without one. -->

# swarm-os

Web platform that orchestrates teams of autonomous Claude Code sessions. One
instance manages one project: a single Spawner runs N **orchestrators**, each
of which is a team of **1 lead + N workers** communicating through an in-memory
mailbox + an MCP HTTP server. Sessions run in `bypassPermissions`; isolation
comes from the Docker container, not the runtime. The web UI lets a single
operator supervise/intervene from a phone via Tailscale; Discord webhooks push
notifications when a session goes idle or an orchestrator ends.

Status: **MVP implementation-complete.** Phases 0–7 implemented (see
`docs/`). The next roadmap items are post-MVP items listed in `plan.md` §16.

---

## Quickstart (Docker — single project)

Edit the host paths to your situation, then run from the repo root:

```sh
docker build -t swarm-os:latest .

docker compose -f examples/docker-compose.single.yml up -d
# UI:    http://127.0.0.1:8787
# Logs:  docker logs -f swarm-fyrel-cc-app
```

First-boot token is auto-generated and persisted at `/data/token` inside the
container. Retrieve it with:

```sh
docker exec swarm-fyrel-cc-app cat /data/token
```

Paste it into the Token panel of the web UI. The container also generates a
separate `HOOK_TOKEN` at `/data/hook-token` (used by Claude's Notification
hook to call the server back); you do not need to handle it manually.

For multi-project deployments (one container per project, distinct ports +
Discord channels), see `examples/docker-compose.multi.yml`.

---

## Local dev

```sh
pnpm install
pnpm dev          # starts server (8787) + Vite (5173) with proxy
```

Env vars worth knowing for local dev (full table in `plan.md` §13):

- `SWARM_OS_DATA_DIR` (default `/data` — override to e.g. `./.dev-data`)
- `SWARM_OS_WORKSPACE_ROOT` (default `/workspace` — override to your project)
- `SWARM_OS_TOKEN` (if unset, generated and written to `<dataDir>/token`)
- `SWARM_OS_DISCORD_WEBHOOK_URL` (optional — no-op when absent)
- `SWARM_OS_PUBLIC_URL` (optional — used for Discord deep-links)

Outside a container, the host `~/.claude` is used directly; `claude-init`
no-ops. See `docs/phase-1-spawner-lead.md` for the full local-dev wiring.

---

## Repo layout

- `packages/server/` — Express + WS + MCP HTTP + SQLite + Notifier
- `packages/web/` — React + Vite + xterm.js UI + PWA shell
- `scripts/` — `verify-claude-code.ts` (spike harness), `gen-icons.ts` (PWA icons)
- `examples/` — `docker-compose.{single,multi}.yml` reference deployments
- `docs/` — phase-by-phase implementation reports (mandatory pre-reading)
- `archives/` — superseded plan revisions (historical, do not edit)
- `plan.md` — canonical specification (sections 1–17)
- `Dockerfile` — multi-stage builder + runtime (claude CLI pinned at 2.1.142)

---

## Tests

Phase 7 ships a Vitest-based suite alongside the spike-style verify scripts.
The two layers serve different purposes:

- **Unit + integration tests (`pnpm test`)** — fast (<10 s), isolated, use
  `FakeAgentProcess` exclusively (never spawn a real `claude`). Covers
  config parsing, mailbox semantics, messaging, preamble templating,
  Discord embed shape, persistence round-trips, REST + MCP end-to-end,
  WebSocket terminal/events, hooks, boot recovery, plus the load-bearing
  web bits.
- **Verify harnesses (`pnpm --filter server verify:phase{2,3,4}`)** —
  spike-style smoke harnesses against the real HTTP/MCP stack. Slower,
  noisier, kept as a sanity gate for live env behaviour.

```sh
pnpm test               # single run (~15s wall, 7s test time)
pnpm test:watch         # vitest in watch mode
pnpm test:coverage      # generates coverage/ + thresholds (50% lines/funcs)
```

| Script | Checks | Coverage |
|---|---|---|
| `pnpm --filter server verify:phase2` | 15 / 15 | MCP HTTP + auth + tools.list + team.whoami/list |
| `pnpm --filter server verify:phase3` | 23 / 23 | Workers, mailbox, send/read/broadcast, signal injection |
| `pnpm --filter server verify:phase4` | 25 / 25 | Notifier, Discord embed, hook auth, persistence, recovery |

Total verify checks: **63 / 63** across phases 2–4. Phase 0 bis (Claude Code
spike) runs separately via `pnpm verify:claude` and produces
`scripts/verify-claude-code.report.md`.

### Docker smoke (MANUAL)

`scripts/smoke-docker.sh` builds the production image, boots a container
against a temp workspace, hits `/health` + a few REST endpoints with the
auth token, and tears down. **Manual** because it needs a working Docker
daemon and the build can take minutes on a cold cache:

```sh
bash scripts/smoke-docker.sh
```

Exit codes: `0` PASS, `1` FAIL, `2` prerequisites missing.

---

## Cross-references

- Specification: `plan.md`
- Phase implementation reports: `docs/phase-*.md` (mandatory pre-reading
  before touching the corresponding code)
- Spike report: `scripts/verify-claude-code.report.md`
- Historical alternates: `archives/`

---

## Security posture (TL;DR)

- All sessions run in `bypassPermissions` — isolation comes from the
  container only. **Never run swarm-os outside a container** unless you fully
  trust every prompt that ever lands in front of an agent.
- Main HTTP port (8787) is bound to `127.0.0.1` of the host; cross-device
  access is via Tailscale.
- MCP HTTP port (8788) is intra-container only — never exposed by Docker.
- `SWARM_OS_TOKEN` (user-facing X-Auth-Token) and `HOOK_TOKEN` (internal,
  Bearer auth on `/hooks/notification`) are distinct, both auto-generated.
- Discord embed deep-links never carry tokens.

Full posture in `plan.md` §14 and `docs/phase-5-containerisation.md` §7.

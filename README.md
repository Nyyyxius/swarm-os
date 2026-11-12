<!-- swarm-os — agent-readable README. Plain Markdown only (no mermaid/HTML). -->
<!-- License: proprietary, all rights reserved — see LICENSE. -->

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

## Deploy (third party / fresh host)

One command on a fresh host — no build toolchain required, nothing cloned first:

```sh
curl -fsSL https://raw.githubusercontent.com/Nyyyxius/swarm-os/master/bootstrap.sh | bash
```

`bootstrap.sh` fetches the deploy kit into `~/swarm-os` (the repo is public: no
token needed) and hands over to the same wizard `./install.sh` runs from a
checkout:

```sh
./install.sh             # guided setup, then deploy
```

On Windows, the PowerShell twin (`install.ps1`) fetches the kit and runs the same
wizard against Docker Desktop — agents on the `local` transport (see
[docs/deploy/install.en.md](docs/deploy/install.en.md#windows-powershell)):

```powershell
irm https://raw.githubusercontent.com/Nyyyxius/swarm-os/master/install.ps1 | iex
```

With no `.env` present it runs a **nine-step wizard**: host prerequisites (it can
install Docker, and it runs the Claude Code OAuth login for you), project name
and paths, image + `docker login ghcr.io`, the agent transport (generating and
authorising an SSH key when you pick `ssh`), the other provider CLIs, remote
access including Tailscale, Discord, update detection — each answer checked
against the host as you give it. It then writes `.env`, deploys, waits for
`boot_complete` and prints the URL, the token and each provider's verdict.
`--reconfigure` re-runs it with your current values as defaults; `--yes` deploys
an existing `.env` with no questions (CI). Full bilingual guide in `docs/deploy/`.

The only token involved is for the **image**, which is a private GHCR package:
a classic GitHub PAT with the `read:packages` scope, on an account the
maintainer has granted access to the package. The wizard asks for it at the
image step (`docker login ghcr.io`).

Prerequisite: an **authenticated Claude Code CLI on the host**
(`~/.claude/.credentials.json` must exist) — agents launch the CLI and inherit
those credentials; the wizard walks you through it if it is missing. Remote
access (Tailscale / reverse proxy / SSH tunnel) and troubleshooting are in
`docs/deploy/install.en.md` (FR: `install.fr.md`). Image distribution is handled
by `.github/workflows/release-image.yml` (push a `vX.Y.Z` tag) or
`scripts/push-image.sh` for a manual publish.

---

## Update

Full guide: `docs/deploy/install.en.md` §7 (FR: `install.fr.md` §7). The short
version:

**Detection needs a token.** `SWARM_OS_GITHUB_TOKEN` is any read-only GitHub
PAT: the repository is public, so no particular scope is required — the
`read:packages` token used by `docker login` works. Put it in the deployment
`.env` **and** make sure the
compose service names it in `environment:` (that block is an explicit
allow-list; all shipped compose files carry
`SWARM_OS_GITHUB_TOKEN: ${SWARM_OS_GITHUB_TOKEN:-}`). Without it the check
status stays `no_token` and no release is ever announced — a healthy state, not
an error.

**One-click update** (SETTINGS ▸ SYSTEM UPDATE) needs the SSH transport and a
registry `SWARM_OS_IMAGE`; otherwise the drawer names the one reason it cannot
(`TRANSPORT IS NOT SSH`, `IMAGE TAG IS HARDCODED`, `IMAGE IS LOCALLY BUILT`, or
a host fact answered by the updater's preflight, which refuses without touching
anything). When it runs, **swarm-os rewrites the `SWARM_OS_IMAGE=` line of the
operator's env file** — that line only, temp-file + rename, with a `<file>.bak`
written first — then recreates the container and verifies it on `/health` up to
`boot_complete`, rolling the line back if that fails. `/data` persists.

**Teams are warned first, for at least 120 s.** The window is 300 s by default
and the server floors it at 120: below that a lead mid-turn cannot reach an idle
boundary, read the notice and wrap up. The countdown names the leads that have
not read it and says *"Applying anyway"*; afterwards the drawer lists the teams
that did not come back, and says of a lead that never read the notice that its
work "was interrupted at an arbitrary point".

**Publishing a release** (maintainer): bump `package.json`, commit, tag, then
`git push origin master --follow-tags`. A tag that stays local publishes
nothing — the `release-image` workflow fires on the pushed tag and cuts the
GitHub Release the checker reads. A manual `workflow_dispatch` publishes
`:<short-sha>` only and never moves `:latest`.

---

## Build from source (dev — single project)

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
- `packages/plugin-sdk/` — types-only SDK for plugin authors (`@swarm-os/plugin-sdk`)
- `scripts/` — `verify-claude-code.ts` (spike harness), `gen-icons.ts` (PWA icons), `push-image.sh` (manual GHCR publish)
- `examples/` — `docker-compose.{single,multi,dist}.yml` reference deployments (`dist` = third-party, `.env`-driven) + `docker-compose.ssh.yml` (overlay for the `ssh` agent transport); `plugins/` — example plugins (`echo`, `slack-bridge`, `discord-agent`, `novelai`)
- `bootstrap.sh` — remote entry point: fetches the kit onto a bare host and starts the installer (`curl … | bash`)
- `install.sh` + `.env.example` — guided installer (wizard + deploy) and the config template it writes
- `install.ps1` — Windows (PowerShell) twin of `install.sh`: Docker Desktop, `local` transport; fetches the kit itself under `irm … | iex`
- `docs/deploy/` — bilingual install + usage guides for shipping to a third party
- `docs/` — phase-by-phase implementation reports (mandatory pre-reading)
- `archives/` — superseded plan revisions (historical, do not edit)
- `plan.md` — canonical specification (sections 1–17)
- `Dockerfile` — multi-stage builder + runtime (claude CLI pinned at 2.1.142)

---

## Agent providers (multi-provider)

An agent is a CLI process driven in a PTY, and that CLI is no longer always
`claude`. Four adapters ship built in — `claude` (Anthropic), `codex` (OpenAI),
`gemini` (Google) and `opencode` (any model reachable through OpenRouter) —
selected **per team and per agent**, so a Claude lead with Gemini workers is a
supported shape. `GET /providers` publishes each one's model catalogue,
capabilities and whether it can run here; the UI greys out an unusable provider
with its reason instead of hiding it, and the verdict is re-probed every 60 s,
so installing a CLI on the host makes it selectable without a restart.

The model lists are live too. Model ids ship far faster than releases, so each
adapter refreshes its catalogue — and its default model — from
[models.dev](https://models.dev) every 6 h, with prices shown next to each entry;
a running instance surfaces a newly released model without a redeploy, and new
teams start on it. Set `SWARM_OS_MODEL_CATALOGUE_URL=off` to freeze everything on
the ids the build shipped with. See [docs/providers.md](docs/providers.md).

Prerequisite for anything but `claude`: the CLI **installed and logged in on
the host** — the image carries only the Claude Code CLI, and under the SSH
transport the agent runs on the host with the host's own credentials — plus an
OpenRouter key in SETTINGS ▸ OPENROUTER for `opencode`. Two accepted
degradations to know before choosing: `gemini` and `opencode` have no
`--effort` equivalent, and `codex`/`gemini`/`opencode` sessions never reach the
`waiting` state (their callbacks fire at every turn boundary, or not at all),
which makes `SWARM_OS_COMPACT_ON_WAITING` a no-op for them. Context is kept
lean by the **context-threshold auto-compact** instead (`docs/auto-compact.md`):
a lead whose context passes its role's threshold (35 % by default,
`SWARM_OS_AUTO_COMPACT_PCT` / per-role `autoCompactPct`, `0` = off) is
`/compact`-ed at its next idle boundary, only with an empty inbox, and any mail
that arrives meanwhile is re-signaled once the compaction is over. Workers have
their own threshold, OFF by default (`SWARM_OS_WORKER_AUTO_COMPACT_PCT` /
per-role `workerAutoCompactPct`). After any server-fired `/compact` the agent
is told to resume the work it had in progress
(`SWARM_OS_CONTINUE_AFTER_COMPACT`, on by default). It works for claude, codex
and opencode; gemini has no context gauge and is never auto-compacted.
The per-call tool overhead is trimmed too (`docs/outils-par-role.md`): claude
sessions keep on-demand tool loading (ToolSearch) except on haiku
(`SWARM_OS_CLAUDE_TOOL_SEARCH=off|on|auto`), a role can pin the exact built-in
tools of its lead and of its workers (`leadTools` / `workerTools`, passed as
`--tools`) and narrow the team-comms tools they see (`leadMcpTools` /
`workerMcpTools`), and workers never see lead-only team-comms tools.

Full reference — per-CLI contract, capabilities, host prerequisites, what the
spikes proved and what they could not: `docs/providers.md`.

---

## Plugins

swarm-os is extensible through **installable plugins**: JavaScript ESM modules
loaded in-process and hot enabled/disabled from the UI (`#/plugins`) with no
server restart and no interruption of running teams. A plugin receives an
injected `SwarmPluginApi` façade — event bus, team/role management, agent
messaging, per-plugin storage, cron scheduling, MCP tools exposed to the
agents, HTTP routes, host command execution over SSH, and channel connectors
(Discord-style bridges) — and can surface its own pages as iframe UI panels in
the SPA. Full authoring guide: `docs/plugins.md`.

### Creating a plugin

A plugin is a directory with a `plugin.json` manifest and an ESM entry point
(JS only — pre-compile TypeScript before packaging; no native modules):

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "main": "index.js",
  "apiVersion": 1,
  "capabilities": ["events", "db-kv", "mcp-tools"]
}
```

```js
export default {
  activate(api) {
    api.events.on('mailbox.message', (ev) => api.log.info({ ev }, 'seen'));
    api.mcp.registerTool({
      name: 'hello', title: 'Hello', description: 'Say hello',
      inputSchema: { name: api.zod.string() },
      handler: ({ name }, ctx) => ({ reply: `hello ${name} from ${ctx.sessionName}` }),
    });
  },
};
```

Drop the directory in `/data/plugins/<name>/`, hit **Scan** on `#/plugins`,
then **Enable**. Everything registered through `api.*` returns a disposable
and is torn down automatically on disable. Agents see MCP tools as
`<name>.<tool>` (here `my-plugin.hello`). Working examples:
`examples/plugins/echo` (events, MCP tool, HTTP route, config schema, UI panel),
`examples/plugins/slack-bridge` (channel connector, npm dependencies),
`examples/plugins/discord-agent` (Discord text + voice bound to a permanent
lead), and `examples/plugins/novelai` (external API behind MCP tools, generated
files written into the workspace with SSH-aware path translation).
Use `packages/plugin-sdk` for typed autocompletion while authoring. A manifest
may also declare `uiPanels` to surface its own pages as full-pane iframes in the
SPA nav (enabled plugins only) — see `docs/plugins.md` §5.

### Capabilities

The manifest **declares** what the plugin wants; the operator **grants** it in
the management page at first enable (editable at any time — the API only
materialises `manifest ∩ granted`). This is a declarative guardrail, **not a
sandbox**: plugins run in-process as trusted code.

| Capability | Grants |
|---|---|
| `events` / `events-emit` | subscribe to the event bus / emit `plugin.<name>.*` events |
| `messaging` | send to sessions/leads, broadcast, read inboxes (`from = plugin:<name>`) |
| `teams` / `roles` | create/destroy teams, spawn/kill workers / role CRUD |
| `mcp-tools` | register MCP tools exposed to agents as `<name>.<tool>` |
| `http-routes` / `http-public` | authed routes under `/plugin-api/<name>/*` / tokenless webhooks under `/public/plugins/<name>/*` (HMAC over `req.rawBody`) |
| `agent-assets` | ship scripts copied to `<workspace>/.swarm-plugins/<name>/` for agents to run |
| `db-kv` / `db-tables` | per-plugin key-value store / own prefixed SQLite tables (`plugin_<name'>_*`, `name'` = name with `-`→`_`) via `defineTable`/`prepare`, confined to that prefix |
| `notify` / `schedule` | push operator notifications (incl. free-form `notify.custom` alerts) / cron expressions + intervals |
| `connectors` | provide channel connector types (Slack/Telegram-style bridges) roles can use |
| `settings-read` | read instance settings |
| `crons` | CRUD on the agent crons (same entity as the `#/crons` screen) — a plugin provisions its own cadences, upserting by `name` |
| `host-exec` | run arbitrary commands on the **host** over SSH — short (`api.host.exec`) or a detached long-running job (`api.host.spawnJob`/`jobStatus`/`killJob`) — the most powerful capability: full trust, `ssh` agent transport only |

### Installing & managing

Four sources, all hot-installable from the **Install** dialog on `#/plugins`
(or `POST /plugins/install`): drop a directory in `/data/plugins` + Scan,
upload a `.tgz` (`npm pack` format, ≤50 MB), install from npm (any spec), or
clone from a git URL — branch/tag `ref`, optional `subdir` for a plugin nested
in a monorepo (the repo must commit compiled JS). The page also covers
enable/disable, the schema-driven config form (`format: "password"` fields are
masked on read and preserved on save), permission grants, upgrade and
uninstall (`?purge=true` also drops the plugin's KV data and tables). Crash
isolation counts sync throws *and* async rejections: a plugin crashing ≥5
times in 60 s is auto-disabled and quarantined (exponential backoff) instead
of taking the server down.

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
- Deployment & update guide: `docs/deploy/` (EN + FR; the update surface is
  §7 of `install.*.md`)
- Agent providers (multi-provider): `docs/providers.md`
- Plugin authoring guide: `docs/plugins.md`
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

---

## License

Proprietary — all rights reserved. See `LICENSE`. The image bundles third-party
tools (Claude Code CLI, VS Code CLI, npm deps), each under its own license.

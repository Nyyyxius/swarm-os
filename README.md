# swarm-os

**Run persistent teams of AI coding agents on your own machine, and supervise them from your phone.**

[![Release](https://img.shields.io/github/v/release/Nyyyxius/swarm-os)](https://github.com/Nyyyxius/swarm-os/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/Nyyyxius/swarm-os/actions/workflows/ci.yml/badge.svg)](https://github.com/Nyyyxius/swarm-os/actions/workflows/ci.yml)
[![Image](https://img.shields.io/badge/image-ghcr.io%2Fnyyyxius%2Fswarm--os-blue)](https://github.com/Nyyyxius/swarm-os/pkgs/container/swarm-os)

[Français](README.fr.md)

swarm-os is a self-hosted web console. It starts the real agent CLIs (Claude Code, Codex, Gemini CLI,
OpenCode) in terminals on your server, groups them into teams of one **lead** and several **workers**
that message each other, and lets you watch, type into and steer every agent from a browser or a phone.

## Why swarm-os

- **Your subscriptions, your machine.** Agents are the official CLIs, logged in with your own accounts.
  swarm-os ships no API key; the model calls go through those CLIs.
- **Teams that keep running.** Teams, roles, messages and schedules live in SQLite and come back after a
  restart. Crons hand scheduled work to running teams; Discord tells you when an agent needs you.
- **Mixed providers.** Pick the CLI per team and per agent: a Claude lead with Codex workers is fine.
- **Supervision from anywhere.** A live terminal for every agent, cost and context gauges, approvals,
  all in a mobile-friendly web app you reach over Tailscale or your own proxy.

It is for developers who already use these CLIs and want several of them working on a project for
hours, without sitting in front of a terminal.

**How it differs.** The CLIs' built-in sub-agents and agent teams live inside one session and end with
it. Agent frameworks (SDK libraries) make you write the agent loop and pay per API token. swarm-os does
neither: it drives the unmodified interactive CLIs, keeps the teams alive as long-running processes, and
puts a supervision UI on top.

## Features

- **Teams and roles** — one lead plus N workers per team; reusable roles hold prompts, model, effort,
  permission mode and budget ([usage guide](docs/deploy/usage.en.md#concepts)).
- **Live terminal** — attach to any agent's PTY (xterm.js) and type directly, desktop or mobile.
- **Agent crons** — scheduled wake-ups per role, paused, edited or run now from `#/crons`; script crons
  too ([usage guide](docs/deploy/usage.en.md#crons), [example](examples/crons/)).
- **Skills** — import Agent Skills (`SKILL.md`) from a directory, an upload, npm or git, and activate
  them per role, team or agent ([example](examples/skills/hello-skill/)).
- **Shared memory** — a wiki-linked knowledge base all agents read and write, browsable at `#/memory`
  ([design notes, FR](docs/memoire-partagee.md)).
- **Task board** — durable per-team cards with assignees and dependencies, driven by the agents
  (`#/board`, [FR](docs/tableau-de-taches.md)).
- **Human approvals** — Claude teams in a non-bypass permission mode can ask you to approve or refuse
  from the web or Discord (`#/approvals`, [FR](docs/garde-fous-approbation.md)).
- **Monitoring** — context usage, messages, inbox and one-click compact/clear per agent; estimated cost
  per team with an optional per-role budget (`#/monitoring`, [FR](docs/monitoring-agents.md)).
- **Context auto-compact** — a lead past a context threshold is compacted when idle
  ([FR](docs/auto-compact.md)).
- **Code graph** — a code knowledge graph of the workspace built offline with Graphify (`#/graph`,
  [FR](docs/graphify-integration.md)).
- **Web IDE** — VS Code in the browser, served under `/ide` on the same port.
- **Plugins** — installable JavaScript modules that add MCP tools, routes, panels and chat bridges
  ([docs/plugins.md](docs/plugins.md)).
- **Built-in features you can switch off** — code graph, monitoring, approvals, board, memory and IDE
  can be disabled or uninstalled at runtime ([FR](docs/builtin-features.md)).
- **Backups and one-click updates** — hot SQLite snapshots every 6 h; self-update from the UI under the
  `ssh` transport.

Several design documents are still in French; English versions are not written yet.

## Quickstart

You need:

- a Linux x86_64 host (arm64 from the release after 0.10.4) with Docker and Compose v2 (the installer can install Docker);
- a Claude Code account with the `claude` CLI logged in on that host (the installer walks you through it);
- roughly 2–4 vCPU and 4–8 GB of RAM per active team.

Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/Nyyyxius/swarm-os/master/bootstrap.sh | bash
```

Windows (PowerShell, Docker Desktop):

```powershell
irm https://raw.githubusercontent.com/Nyyyxius/swarm-os/master/install.ps1 | iex
```

The Linux command downloads the deploy kit into `~/swarm-os` and starts `install.sh`, a nine-step
wizard (prerequisites, project paths, image, agent transport, providers, remote access, notifications,
advanced settings, review). The Windows installer has eight steps: it always uses the `local` transport
and has no provider step. Both write `.env`, start the container and print the URL and the access token.
To read the script before running it, see the [install guide](docs/deploy/install.en.md).

Then open `http://127.0.0.1:8787`, paste the token into the panel that opens, and create a team with
**New Orchestrator**. On a remote server the port is bound to loopback: tunnel it first with
`ssh -L 8787:127.0.0.1:8787 user@host`, or see [Remote access](#remote-access).

Platform status: Linux is the tested path. Windows works through Docker Desktop with Claude only (use
WSL 2 and `install.sh` for the other providers). macOS is not tested. Images up to 0.10.4 are
`linux/amd64` only; later releases also ship `linux/arm64`. Until then, on arm64, build the image from a
clone of this repository.

## How it works

```
 browser / phone ── HTTPS (Tailscale, reverse proxy or SSH tunnel)
        │
        ▼
 ┌─────────────────────── swarm-os container ───────────────────────┐
 │  web UI + REST + WebSocket          127.0.0.1:8787               │
 │  server: teams, roles, crons, mailbox, SQLite in /data           │
 │  MCP server "team-comms"            loopback :8788               │
 │        │ spawns one PTY per agent                                │
 │        ▼                                                         │
 │  local transport: the claude CLI runs here                       │
 └────────┬─────────────────────────────────────────────────────────┘
          │ ssh transport: ssh -tt to the host (MCP port forwarded back)
          ▼
   host account: claude / codex / gemini / opencode, with your own logins
```

Each agent talks to its team through MCP tools (`team.send_message`, `team.read_inbox`,
`team.spawn_worker`, …); the server delivers messages into the recipient's terminal when it is idle.

| Term | Meaning |
|---|---|
| Instance | One container, one project (the `/workspace` mount), one operator. |
| Team | Also called an orchestrator: one lead that plans and decides, plus workers that execute. |
| Role | A reusable team template: prompts, provider, model, effort, budget; crons target a role. |
| Mailbox | The message queue between agents of a team (in memory, written through to SQLite). |
| Transport | Where the agent CLIs run: `local` (in the container) or `ssh` (on the host). |

## Agent providers

| CLI | Auth | Limits |
|---|---|---|
| `claude` (Anthropic) | `claude` OAuth login on the host | Only CLI in the image; works under both transports. |
| `codex` (OpenAI) | `codex login` on the host | `ssh` transport only. |
| `gemini` (Google) | Google login or API key on the host | `ssh` only; no effort setting, no context gauge; never tested against a live model. |
| `opencode` (OpenRouter) | OpenRouter key in SETTINGS ▸ OPENROUTER | `ssh` only; no effort setting; the OpenRouter hop is not proven end to end. |

`codex`, `gemini` and `opencode` never report a "waiting" state. Model lists refresh from
[models.dev](https://models.dev) every 6 h. Details: [docs/providers.md](docs/providers.md).

## Configuration

The installer writes `.env`; you rarely edit it by hand. The variables that matter most:

| Variable | Purpose |
|---|---|
| `SWARM_OS_IMAGE` | Image to run, e.g. `ghcr.io/nyyyxius/swarm-os:latest`. |
| `SWARM_OS_PROJECT_NAME` | Name shown in the UI and notifications. |
| `WORKSPACE_PATH` | Host directory of the project the agents work in. |
| `DATA_PATH` | Host directory for state: database, tokens, logs, backups. |
| `CLAUDE_DIR` | Your logged-in `~/.claude`, mounted read-only. |
| `SWARM_OS_PORT` | Host port of the UI (default `8787`, bound to `127.0.0.1`). |
| `SWARM_OS_AGENT_TRANSPORT` | `local` (the compose default) or `ssh` (what `install.sh` preselects when an SSH server is running). |
| `SWARM_OS_DISCORD_WEBHOOK_URL` | Optional Discord notifications. |

Everything else is documented in [.env.example](.env.example).

## Remote access

The UI listens on `127.0.0.1` only and the container has no TLS. Reach it through Tailscale (recommended
for phones), a reverse proxy that forwards WebSockets, or an SSH tunnel. See
[install guide §6](docs/deploy/install.en.md#6-remote-access).

## Security and trust model

swarm-os gives AI agents a shell. Read [SECURITY.md](SECURITY.md) before exposing it. In short:

- **The access token is full control.** It is one static token with no users or roles; whoever holds it
  can drive agents, install plugins and open the IDE, which amounts to running code on the machine.
- **Agents run without permission prompts by default** (`bypassPermissions` for Claude; Codex, Gemini
  and OpenCode only support that mode). Treat every prompt you give them as code you run.
- **`local` transport:** agents run inside the container as its non-root user. They can read what the
  server can: the workspace, `/data` (including the tokens) and the server's environment variables.
  The container limits what they reach on the host.
- **`ssh` transport:** agents run **on the host, as your user account**, with everything that account can
  do. The container is not a sandbox in this mode. Use a dedicated account if that matters to you.
  The Linux installer preselects `ssh` when an SSH server is running; choose `local` at step 4 if you
  want the container as the boundary.
- **Good defaults:** ports bound to loopback, constant-time token checks, short-lived WebSocket tickets,
  MCP on loopback, non-root container. Plugins are trusted code, not sandboxed.

Report vulnerabilities privately through
[GitHub security advisories](https://github.com/Nyyyxius/swarm-os/security/advisories/new).

## Plugins

Plugins are JavaScript (ESM) modules loaded into the server and enabled or disabled from `#/plugins`
without a restart. They can add MCP tools for agents, HTTP routes and webhooks, UI panels, crons and
chat connectors; the operator grants each declared capability. Install from a directory, a `.tgz`, npm
or git. Examples live in [examples/plugins](examples/plugins/); the guide is [docs/plugins.md](docs/plugins.md).

## Updating

Re-run `./install.sh` in the kit directory: it pulls the image in `.env` and recreates the container;
`/data` persists. Under the `ssh` transport, SETTINGS ▸ SYSTEM UPDATE can do it from the UI, after
warning running teams. See [install guide §7](docs/deploy/install.en.md#7-update).

## Cost

swarm-os itself is free. Agents consume your own subscriptions or API keys, and several agents working
for hours consume them quickly. New teams default to the newest Claude Opus at `xhigh` effort; lower
`SWARM_OS_DEFAULT_MODEL` / `SWARM_OS_DEFAULT_EFFORT` for cheaper runs and set role budgets.

## Troubleshooting

- **The UI loads but is empty, or every call returns 401** — the token is missing or wrong. Get it with
  `docker exec <container> cat /data/token` and paste it again.
- **A team never starts or a session hangs** — Claude is not logged in on the host:
  `~/.claude/.credentials.json` must exist and `CLAUDE_DIR` must point at it.
- **`EACCES` on `/data` or the container keeps restarting** — the data directory is not owned by the
  container's uid (1000 by default).
- **A provider is greyed out** — hover it for the reason. Under `local` only `claude` can run.
- **The IDE or terminal stays blank behind a proxy** — the proxy must forward WebSockets.

More in [install guide §8](docs/deploy/install.en.md#8-troubleshooting).

## Development

```sh
pnpm install
pnpm dev     # server on :8787 + Vite on :5173
pnpm test
```

Node 22+ and pnpm are required. Outside a container, point `SWARM_OS_DATA_DIR` (default `/data`) and
`SWARM_OS_WORKSPACE_ROOT` (default `/workspace`) at writable directories first. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Status

swarm-os is young (version 0.x) and maintained by one person. It runs real workloads around the clock,
but expect rough edges and breaking changes between minor versions. Changes are listed in
[CHANGELOG.md](CHANGELOG.md).

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and the
[code of conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE). The Docker image also contains third-party tools (Claude Code CLI, VS Code CLI,
Graphify, npm dependencies) under their own licenses.

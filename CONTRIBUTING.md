# Contributing to swarm-os

Thanks for your interest. This guide gets you from a fresh clone to a merged
change: prerequisites, dev servers, checks, where code lives, and how releases
are cut. If you are looking for how to *install and run* swarm-os, see the
[README](README.md) and [docs/deploy/](docs/deploy/README.md) instead.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Security issues do **not** go in public issues: see [SECURITY.md](SECURITY.md).

## Prerequisites

- **Node.js 22 or newer** (`engines.node` is `>=22`; the Docker image builds and
  runs on Node 24).
- **pnpm 11.1.2**, the version pinned in `package.json` (`packageManager`).
  The simplest way is `corepack enable`, which picks the pinned version up.
- **A C/C++ toolchain and Python 3**: `node-pty` and `better-sqlite3` compile
  native code at install time (on Debian/Ubuntu: `python3 make g++`).
- **git**.
- Optional: **Docker** to build and smoke-test the image, and an
  authenticated **Claude Code CLI** (or codex / gemini / opencode) if you want
  to run real agents locally. The test suite never needs one.

## Getting started

```sh
git clone https://github.com/Nyyyxius/swarm-os.git
cd swarm-os
pnpm install --frozen-lockfile
```

### Run the dev servers

```sh
SWARM_OS_DATA_DIR="$PWD/.dev-data" \
SWARM_OS_WORKSPACE_ROOT="$PWD" \
SWARM_OS_CLAUDE_SOURCE_DIR="$HOME/.claude" \
pnpm dev
```

`pnpm dev` starts the server (`tsx watch`, port **8787**) and the Vite dev
server (port **5173**) side by side. Open <http://127.0.0.1:5173>: Vite proxies
the API and WebSocket routes to the server.

The defaults (`/data`, `/workspace`) are container paths, hence the two
overrides above; use absolute paths, because the server process runs from
`packages/server/`. Useful variables for local work:

| Variable | Default | Purpose |
|---|---|---|
| `SWARM_OS_DATA_DIR` | `/data` | SQLite database, tokens, plugins, logs |
| `SWARM_OS_WORKSPACE_ROOT` | `/workspace` | Root under which agents may work |
| `SWARM_OS_TOKEN` | generated | UI/API token; if unset it is written to `<dataDir>/token` |
| `SWARM_OS_DISCORD_WEBHOOK_URL` | unset | Discord notifications (no-op when absent) |
| `SWARM_OS_PUBLIC_URL` | unset | Base URL used in Discord deep links |

Paste the token from `<dataDir>/token` into the token panel of the UI. Agents get
their Claude credentials from `SWARM_OS_CLAUDE_SOURCE_DIR` (default
`/claude-source`, the container mount), so point it at your logged-in
`~/.claude` as above. The full list of
variables lives in [`.env.example`](.env.example) and
[docs/deploy/install.en.md](docs/deploy/install.en.md).

`.dev-data/` is scratch state: never commit it.

### Build

```sh
pnpm build        # pnpm -r build: server (tsc), web (tsc -b + vite build), plugin SDK (tsc)
```

To build and try the production image locally, use a tag of your own rather
than `latest`, so you never shadow a real deployment on the same machine:

```sh
docker build -t swarm-os:dev .
bash scripts/smoke-docker.sh   # builds a throwaway image, boots it, probes /health and a few routes, tears down
```

`scripts/smoke-docker.sh` is manual (it needs a Docker daemon and a cold build
can take minutes). Exit codes: `0` pass, `1` fail, `2` prerequisites missing.
To run your image with a compose file, point
[`examples/docker-compose.dist.yml`](examples/docker-compose.dist.yml) at it
with `SWARM_OS_IMAGE=swarm-os:dev`.

## Checks

Run these before opening a pull request. The `CI` workflow
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs lint, typecheck,
tests and build on every pull request; get it green before asking for review.

```sh
pnpm lint                                   # eslint . (flat config in eslint.config.js)
pnpm typecheck                              # tsc --noEmit in server, web and plugin-sdk
pnpm test                                   # every Vitest project, single run
pnpm build
```

Formatting uses Prettier (`pnpm format` rewrites the whole tree). Please format
only the files you touch; a repository-wide reformat is a separate change.

### How tests are organised

Vitest 4 with three projects, enumerated in the root
[`vitest.config.ts`](vitest.config.ts):

| Project | Config | Files | Environment |
|---|---|---|---|
| `server` | `packages/server/vitest.config.ts` | `src/**/*.test.ts` (unit, colocated) and `test/**/*.test.ts` (integration) | Node, one file at a time |
| `web` | `packages/web/vitest.config.ts` | `src/**/*.test.{ts,tsx}` | jsdom + Testing Library |
| `examples` | `examples/vitest.config.ts` | `plugins/*/test/*.test.js` | Node |

Tests never spawn a real agent CLI: the server suite drives `FakeAgentProcess`
and fake providers. Globals are off, so import `describe` / `it` / `expect`
explicitly.

```sh
pnpm test                                           # everything
pnpm exec vitest run --project web --project examples
pnpm exec vitest run --project server packages/server/src/config.test.ts   # one file
pnpm test:watch                                     # watch mode
pnpm test:coverage                                  # coverage/ + thresholds (50 % lines and functions)
```

One pitfall when running locally: **one server run at a time.** Some server
integration tests bind fixed ports, so two `server` project runs on the same
machine (two terminals, two worktrees, an agent running tests next to you)
collide and fail with address-in-use errors. Run a single Vitest invocation of
the `server` project at a time. The `web` and `examples` projects have no such
constraint.

There are also spike-style harnesses that exercise the real HTTP/MCP stack
(`pnpm --filter server verify:phase2` … `verify:phase5`) and probes of the real
agent CLIs (`pnpm verify:claude`, `verify:codex`, `verify:gemini`,
`verify:opencode`, `verify:claude-sessionstart`). The CLI probes need the
corresponding CLI installed and logged in; they are tools for checking a new
CLI release, not part of the regular checks.

## Architecture map

swarm-os is a pnpm monorepo. One running instance manages one project: a
**Spawner** runs N **orchestrators** (teams), each made of **1 lead + N
workers**. Every agent is a real CLI process (`claude`, `codex`, `gemini`,
`opencode`) driven in a PTY; agents talk to each other through a mailbox
(in memory, written through to SQLite) exposed as MCP tools over a loopback HTTP server.

```
packages/
  server/        Node + TypeScript backend (Express 5, ws, MCP SDK, better-sqlite3, node-pty)
    src/index.ts         wiring: builds every module and starts HTTP + MCP listeners
    src/config.ts        all SWARM_OS_* environment parsing
    src/http/            REST routes (routes/), WebSockets (ws/: terminal, events), auth, validation
    src/runtime/         first-boot setup of the agent CLI home (claude-init)
    src/modules/
      spawner/           owns the orchestrators; warn-and-restart logic for updates
      orchestrator/      sessions, PTY injection, mailbox, preambles, context gauges, auto-compact
      providers/         one adapter per agent CLI + live model catalogue
      mcp/               the team-comms MCP server and its tool sets (team, memory, board, skills, codegraph)
      db/                SQLite schema and access layer
      roles/             reusable team templates
      plugins/           plugin host: loader, installer, capability-gated API facades
      skills/            importable skills: sources, trust/review, activation
      crons/             agent crons scheduler and script runner
      memory/            shared knowledge-graph memory
      taskboard/         durable per-team task board
      approvals/         human-in-the-loop approval queue
      codegraph/         code knowledge graph (Graphify indexer)
      metrics/           system, bus, context and cost metrics
      updates/           release detection and one-click update
      notify/, discord/  Discord webhook notifications and bots
      features/          built-in features that can be switched off
      ide/               VS Code web under /ide
      backup/, settings/, ai/, install-core/, preambles/
    test/integration/    end-to-end tests against a fully wired server
    scripts/             verify-phase-* harnesses
  web/           React 19 + Vite + Tailwind + xterm.js single-page app (desktop and mobile shells)
    src/api/             typed client for the server API
    src/controller/      shared state above both shells
    src/components/      pages and dialogs (desktop/, mobile/, plugins/, skills/, …)
  plugin-sdk/    @swarm-os/plugin-sdk: types-only SDK for plugin authors
examples/
  docker-compose.*.yml   reference deployments (dist = the one installers use, ssh = transport overlay)
  plugins/               example plugins (echo, slack-bridge, discord-agent, novelai, gemini-api)
  skills/, crons/        an example skill and an example script cron
scripts/         CLI probes, model catalogue sync, icon generation, image push, smoke test
docs/            user and reference docs (index: docs/README.md)
docs/internal/   historical plans and design notes, mostly in French
install.sh, install.ps1, bootstrap.sh, setup.sh   installers
Dockerfile       multi-stage image: builder (pnpm build) + runtime (Node 24, tini, non-root)
```

Where to start for a given change:

- **A new REST endpoint**: a route file in `packages/server/src/http/routes/`,
  registered in `http/main.ts`, plus the typed call in
  `packages/web/src/api/client.ts`.
- **A new agent tool**: `packages/server/src/modules/mcp/`; tell the agents
  about it in the preambles (`modules/orchestrator/preamble.ts`).
- **A new agent CLI**: a provider adapter in `modules/providers/`; read
  [docs/providers.md](docs/providers.md) first.
- **UI**: `packages/web/src/components/` (desktop and mobile shells share the
  controller in `src/controller/`).
- **A feature that does not need to live in the core**: consider a plugin
  ([docs/plugins.md](docs/plugins.md)) instead.

Reference documentation is indexed in [docs/README.md](docs/README.md). Design
history (the original specification, phase reports, redesign and update-system
plans) lives in [docs/internal/](docs/internal/README.md): useful to understand
*why* something is the way it is, but it describes the past, not necessarily
the current code.

## Language policy

**English** for commit messages, pull request titles and descriptions, issues,
code comments and any new documentation. Much of the existing design history
and some feature docs are in French; they are being migrated gradually. Do not
open pull requests that only translate a document unless a maintainer asked
for it, and do not mix languages within a new document.

## Branches and commits

- Branch from `master` with a type prefix: `feat/<topic>`, `fix/<topic>`,
  `docs/<topic>`, `chore/<topic>`, `ci/<topic>`.
- Commit subjects follow Conventional Commits, as the history does:
  `type(scope): summary`, for example `fix(hooks): route agent hooks to the
  host port under the ssh transport`. Common types: `feat`, `fix`, `docs`,
  `chore`, `ci`, `test`, `refactor`. The scope is usually the server module or
  area (`providers`, `monitoring`, `install`, `web`).
- Keep the subject under about 72 characters and explain the *why* in the body.
- One logical change per commit. Do not commit generated files (`dist/`,
  `coverage/`), local state (`.dev-data/`, `.env`) or personal compose files.

## Proposing a change

1. For anything beyond a small fix, open an issue first (bug report or feature
   request) so the approach can be agreed before you write code.
2. Fork the repository, create a branch, make the change with tests: a bug fix
   comes with a test that fails without it; a feature comes with tests for its
   behaviour.
3. Update the docs the change affects (README, `docs/`, `.env.example` for a
   new variable) and add a line under `Unreleased` in
   [CHANGELOG.md](CHANGELOG.md) if users will notice the change.
4. Run the checks above, push, and open a pull request against `master`. The
   pull request template has a short checklist.
5. A maintainer reviews it. Small, focused pull requests are reviewed fastest.

## Release procedure (maintainers)

Releases are cut from `master` by pushing a `v*` tag; the
[`release-image`](.github/workflows/release-image.yml) workflow does the rest.

1. Move the `Unreleased` entries of [CHANGELOG.md](CHANGELOG.md) under the new
   version, bump `version` in the root `package.json`, and commit
   (`Release: vX.Y.Z — <summary>`).
2. Push `master`, then create and push the tag:

   ```sh
   git push origin master
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

   A tag that stays local publishes nothing.
   Push the tag by name. Do not use `--follow-tags` or `--tags`: a clone can
   hold older tags that were never published, and pushing them would run the
   release workflow on old trees and move `:latest` backwards.
3. On the tag push, `release-image` builds the image (baking the version and
   commit into `/info`), pushes `ghcr.io/nyyyxius/swarm-os:X.Y.Z` and moves
   `:latest`, then creates the GitHub Release with auto-generated notes. That
   release is what running instances' update checker reads.
4. A manual run of the workflow (`workflow_dispatch`) publishes only
   `:sha-<short-sha>` and never moves `:latest`; use it to test an image, not
   to release.

`scripts/push-image.sh` remains for a manual publish from a workstation.

## Reporting security issues

Do not open a public issue. Follow [SECURITY.md](SECURITY.md), which uses
GitHub private vulnerability reporting.

# Changelog

All notable changes to swarm-os are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(while the version is `0.x`, a minor bump may contain breaking changes).

> **Note on older releases.** The repository moved from a personal account to
> `github.com/Nyyyxius/swarm-os` in v0.10.4. Tags up to and including v0.10.3
> reference the old image path `ghcr.io/luminis1986/swarm-os`, which no longer
> exists: their installers and compose files are not installable as-is. Install
> v0.10.4 or later, whose image lives at `ghcr.io/nyyyxius/swarm-os`.

## [Unreleased]

### Added

- MIT license.
- Public container image: `ghcr.io/nyyyxius/swarm-os` can be pulled
  anonymously; installers and docs no longer ask for a GitHub token.
- `linux/arm64` image alongside `linux/amd64`.
- Update detection works without a token (the public GitHub releases API is
  queried anonymously); `SWARM_OS_GITHUB_TOKEN` is now optional and only
  raises the rate limit.
- Windows installer, `install.ps1` (PowerShell, Docker Desktop, `local`
  transport), runnable with `irm … | iex`.
- Continuous integration: lint, typecheck, tests and build on every pull
  request.
- Security policy (`SECURITY.md`) with private vulnerability reporting.
- Contributor documentation: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, this
  changelog, issue and pull request templates, and a documentation index
  (`docs/README.md`).

### Changed

- Installers and the image install Claude Code with its native installer
  instead of `npm`.
- The deploy kit is fetched from the public repository without a token.
- Internal plans, phase reports and design history moved to `docs/internal/`.

## [0.10.4] - 2026-11-09

### Changed

- Repository transferred to `github.com/Nyyyxius/swarm-os`; the image is now
  published as `ghcr.io/nyyyxius/swarm-os`, and the update checker, installers,
  docs and examples point there.
- The Tailscale host name is read from the local `.env`
  (`SWARM_OS_TAILNET_HOST`) instead of being written in the repository.

## [0.10.3] - 2026-09-26

### Added

- Per-call API usage ledger for `claude` agents, with per-call charts in the
  monitoring band and a CALL USAGE panel.

### Fixed

- The context gauge no longer shows the previous context after a
  `/compact` or `/clear`.

## 0.10.2 - 2026-09-26

Released as a version-bump commit only; there is no `v0.10.2` tag.

### Added

- Per-role tool lists: a role can pin the built-in tools of its lead and
  workers (`--tools`) and narrow the team-comms tools they see.
- On-demand tool loading (ToolSearch) for `claude` sessions, except on Haiku,
  which cuts the context used by tool definitions.

### Fixed

- Workers no longer confuse `team.send_message` with Claude Code's native
  `SendMessage` tool.

## [0.10.1] - 2026-09-26

### Added

- After a server-initiated `/compact`, the agent is told to resume the work it
  had in progress (`SWARM_OS_CONTINUE_AFTER_COMPACT`, on by default).
- Separate auto-compact threshold for workers, off by default.

## [0.10.0] - 2026-09-23

### Added

- Built-in features (code graph, monitoring, approvals, board, memory, IDE) can
  be disabled, uninstalled and reinstalled at runtime, without a restart.
- Context-threshold auto-compact: a lead whose context passes its role's
  threshold is compacted at its next idle boundary.
- Model family aliases: new agents follow the latest Opus / Sonnet / Fable
  model automatically.

## [0.9.2] - 2026-09-23

### Added

- Discord: automatic ⏳ acknowledgement on inbound messages, and worker-scoped
  reaction and thread tools.
- `setup.sh`: a full-screen guided installer, including the choice of the host
  account that runs the instance.

### Fixed

- PTY injections no longer start with a carriage return, which Claude Code
  2.1.277 and later treated as an empty submit.

## [0.9.1] - 2026-09-01

### Added

- Plugin API `api.crons.*` (capability `crons`): plugins can manage agent crons.

## [0.9.0] - 2026-09-01

### Added

- First-class agent crons: a dedicated `#/crons` screen to create, edit and
  pause crons, script crons with run history, and migration of the former
  per-role cadence.

## [0.8.1] - 2026-08-31

### Fixed

- Under the `ssh` transport, agent hooks are routed to the deployment's host
  port instead of whatever listens on `127.0.0.1:8787`.

## [0.8.0] - 2026-08-30

### Added

- Agent monitoring: context usage and history, messages handled, inbox depth,
  operator compact/clear, system gauges, cost tracking with budgets and a
  reaper.
- Example plugin `gemini-api`.

## [0.7.0] - 2026-08-26

### Added

- Multi-provider agents: `codex`, `gemini` and `opencode` alongside `claude`,
  selectable per team and per agent, with a live model catalogue.
- Shared knowledge-graph memory for all agents, with typed relations and
  semantic search.
- Durable per-team task board (Kanban), driven by the agents through MCP tools.
- Human-in-the-loop approval queue, resolvable from the web UI or Discord.
- Code knowledge graph (Graphify indexer) with MCP tools and a `#/graph` page.
- Importable skills library: git, npm and marketplace sources, trust levels and
  review, activation per role, team or session, export and packs.
- Command launcher (⌘K) replacing most top-bar buttons.
- Guided installer and one-command bootstrap (`curl … | bash`).
- Example plugin `novelai`.

### Changed

- Each instance gets its own MCP port.

## [0.6.0] - 2026-07-26

### Added

- Update system: detection of new image and plugin releases, a warning to
  running teams, and one-click update from the UI.
- `/info` reports the real version, commit and image.
- Example plugin `discord-agent` (Discord text and voice bound to a lead).

## [0.5.0] - 2026-07-22

### Added

- Plugins: detached long-running host jobs (`spawnJob` / `jobStatus` /
  `killJob`).
- Plugins: install from a subdirectory of a git repository.

## [0.4.0] - 2026-07-16

### Added

- Plugins: free-form notifications (`notify.custom`), host command execution
  over SSH (`host-exec`), iframe UI panels (`uiPanels`) and per-plugin SQLite
  tables (`db-tables`).

### Fixed

- `host-exec` kills the remote process on timeout.

## [0.3.0] - 2026-07-15

### Added

- Installable plugin system: hot-loaded ESM plugins with capability grants,
  npm / git / upload sources, MCP tools, HTTP routes, channel connectors, a
  management page, the `@swarm-os/plugin-sdk` types and the `echo` and
  `slack-bridge` examples.

## [0.2.0] - 2026-07-07

### Added

- Mobile UI with feature parity with the desktop UI.

### Fixed

- Agents freezing under Claude Code 2.1.201.

## [0.1.0] - 2026-06-24

First versioned release: the MVP plus everything built on it until then.

### Added

- Teams of one lead and N workers running the Claude Code CLI in PTYs, with an
  in-memory mailbox exposed over MCP, REST and WebSocket APIs, SQLite
  persistence and boot recovery, Discord notifications, and a Docker image.
- Desktop web UI with live terminals, roles as reusable team templates,
  cross-team messaging between leads, and a bidirectional Discord bot per role.
- `ssh` agent transport (agents run on the host), team restart, per-role cron
  cadence, `/clear` and `/compact` at task boundaries, and VS Code web under
  `/ide`.
- Third-party deployment kit: `install.sh`, `.env`-driven compose file,
  bilingual install and usage guides, and image publishing to GHCR.

[Unreleased]: https://github.com/Nyyyxius/swarm-os/compare/v0.10.4...HEAD
[0.10.4]: https://github.com/Nyyyxius/swarm-os/compare/v0.10.3...v0.10.4
[0.10.3]: https://github.com/Nyyyxius/swarm-os/compare/v0.10.1...v0.10.3
[0.10.1]: https://github.com/Nyyyxius/swarm-os/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/Nyyyxius/swarm-os/compare/v0.9.2...v0.10.0
[0.9.2]: https://github.com/Nyyyxius/swarm-os/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/Nyyyxius/swarm-os/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/Nyyyxius/swarm-os/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/Nyyyxius/swarm-os/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/Nyyyxius/swarm-os/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Nyyyxius/swarm-os/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Nyyyxius/swarm-os/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Nyyyxius/swarm-os/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Nyyyxius/swarm-os/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Nyyyxius/swarm-os/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Nyyyxius/swarm-os/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Nyyyxius/swarm-os/releases/tag/v0.1.0

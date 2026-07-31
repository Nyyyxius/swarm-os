# swarm-os — Usage guide (EN)

How to operate a running instance. For install/remote access see
[install.en.md](install.en.md).

---

## Concepts

- **Instance** — one container, one project (the `/workspace` mount), one operator.
- **Orchestrator (team)** — **1 lead + N workers**. The lead coordinates and makes
  decisions; workers execute tasks and report back through an in-memory mailbox and
  an MCP server. Workers are leaves — they don't spawn sub-teams.
- **Roles** — reusable definitions: the lead/worker system prompts (preambles),
  default model and effort, an optional Discord connector, and an optional cron
  cadence.
- All sessions run in `bypassPermissions`. **Isolation comes from the container,
  not the runtime — never run swarm-os outside Docker.**

---

## The UI at a glance

- **New Orchestrator** — create a team: name, role/preset, model, effort, and the
  initial prompt that kicks off the lead.
- **Supervise** — the desktop lists every team and session. Open a session to
  attach a **live terminal** (xterm) and type directly to that agent.
- **Console / events** — a global activity feed (expandable to a full-screen
  overlay), with toasts / picture-in-picture for notifications.
- **IDE** — a VS Code Web overlay opens the `/workspace` folder right in the
  browser. Toggle it with `SWARM_OS_IDE_ENABLED`.
- **Restart team** — relaunches a dead team **in place** (same id/config). It does
  a fresh start, not a Claude resume.

---

## Notifications (Discord)

Set `SWARM_OS_DISCORD_WEBHOOK_URL` to get a push when a session goes idle (it needs
your input) or an orchestrator ends. Set `SWARM_OS_PUBLIC_URL` so the embed
deep-links point at your reachable URL — **tokens are never embedded**. With no
webhook configured, notifications are simply logged.

---

## Scheduler (cron per role)

A role can carry a cron cadence to wake an agent on a schedule. Controlled by
`SWARM_OS_SCHEDULE_ENABLED` (default on) and `SWARM_OS_SCHEDULE_TZ` (default UTC).

---

## State, backups, restore

All state lives in the `/data` volume (`DATA_PATH` on the host):

- `swarm-os.db` — SQLite (teams, sessions, roles, settings, mailbox).
- `token`, `hook-token`, `ide-token` — auth secrets (mode 0600).
- `logs/` — per-session logs. `backups/` — SQLite snapshots.
- `.claude-runtime/` — the writable copy of your `~/.claude`.

Behaviour:

- **Backups** — hot SQLite snapshots every 6 h, keeping 14
  (`SWARM_OS_BACKUP_INTERVAL_MS`, `SWARM_OS_BACKUP_KEEP`).
- **Auto-resume** — on boot, teams that were running are restored
  (`SWARM_OS_AUTO_RESUME`).
- **Restore** — stop the container, replace `/data/swarm-os.db` with a snapshot
  from `/data/backups/`, then start again.

> Keep the `DATA_PATH` directory — deleting it wipes your teams, history and tokens.

---

## Cost awareness

New teams default to the newest Claude **Opus** at `xhigh` effort — capable but
expensive. The exact id is not frozen in the build: the server refreshes each
provider's model list from models.dev, so a team created today starts on today's
Opus (`GET /providers`, or the model dropdown, tells you which). Lower
`SWARM_OS_DEFAULT_MODEL` and/or `SWARM_OS_DEFAULT_EFFORT` in `.env` for cheaper
runs, then `./install.sh` to apply.

The dropdown shows each model's price per million tokens — worth a glance, since
a same-generation model can cost twice another for a different kind of work.
Existing teams never change model on their own; only newly created ones pick up
a newer default.

---

## Updating

**SETTINGS ▸ SYSTEM UPDATE** shows the running version and, when a
`SWARM_OS_GITHUB_TOKEN` is configured, the newest published release. Without
that token nothing is ever announced — see install.en.md §7.4.

If the deployment qualifies (SSH transport + a registry `SWARM_OS_IMAGE`), the
same panel applies the update itself: it rewrites the `SWARM_OS_IMAGE=` line of
your `.env` (leaving a `.bak`), recreates the container, and verifies the new
one on `/health` up to `boot_complete` — rolling back to the previous line if
that fails. `/data` persists.

**Your teams are interrupted by this, and the UI is explicit about it.** Every
live lead is warned in its own session and the update waits out a window of at
least **120 seconds** (300 by default; the server refuses anything shorter).
The countdown names the leads that have not read the notice and says *"Applying
anyway"*, because the deadline is not a negotiation. Afterwards the panel lists
the teams that did not come back and what the cut did to their work; RESTART
TEAMS is a fresh start in place — nothing is resumed where it stopped.

Full walkthrough, eligibility reasons and troubleshooting:
[install.en.md §7](install.en.md).

---

## Lifecycle commands

```sh
# logs
docker compose -f examples/docker-compose.dist.yml logs -f
# stop (keeps /data)
docker compose -f examples/docker-compose.dist.yml down
# update to a newer image tag (edit .env first), then
./install.sh
```

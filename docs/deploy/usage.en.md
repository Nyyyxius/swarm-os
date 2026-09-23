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
  default model and effort, and an optional Discord connector.
- **Crons** — scheduled wake-ups, targeting a **role**. A role can carry any
  number of them; see [Crons](#crons) below.
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
  browser. Toggle it from the Plugins screen (built-in feature — see
  [../builtin-features.md](../builtin-features.md)); `SWARM_OS_IDE_ENABLED` only
  sets its initial state at the first boot.
- **Restart team** — relaunches a dead team **in place** (same id/config). It does
  a fresh start, not a Claude resume.

---

## Notifications (Discord)

Set `SWARM_OS_DISCORD_WEBHOOK_URL` to get a push when a session goes idle (it needs
your input) or an orchestrator ends. Set `SWARM_OS_PUBLIC_URL` so the embed
deep-links point at your reachable URL — **tokens are never embedded**. With no
webhook configured, notifications are simply logged.

---

## Crons

A **cron** wakes a role on a schedule. It has its own screen — `#/crons`, from
the ⌘K launcher (WORKSPACE ▸ CRONS), the `🕐 N CRONS` badge on a role, or the
CRONS line in an agent's panel. On mobile it is reached from the STATS sheet.

Every cron targets a **role**, not a session: when it fires, it is delivered to
the lead of **every live instance** of that role. No live instance means a
logged `noop` — a cron never restarts a team that is off.

From the screen: **+ NEW CRON**, **PAUSE / RESUME**, edit the cadence or the
action inline, **DELETE**, and **RUN NOW** (allowed even when the cron is
paused, or when scheduling is off instance-wide — it is an explicit operator
gesture). **LAST RUNS** keeps the 20 most recent fires of each cron with their
outcome, exit code, duration and a truncated output excerpt.

Two actions:

- **MESSAGE** — deliver a template into the lead's inbox at each tick. Same
  tokens as before: `{{fire}}`, `{{now}}`, `{{window:6h}}`.
- **SCRIPT** — run a script inside the container; **the script decides** whether
  to wake anyone. The last non-empty line of its stdout must be JSON:
  `{"wake": true, "message": "…"}` delivers that message,
  `{"wake": false}` disturbs nobody. A non-zero exit, an unreadable last line or
  a timeout is recorded as an `error` run and wakes nobody.

Scripts get an explicit, minimal environment (`SWARM_OS_CRON_ID`,
`SWARM_OS_CRON_NAME`, `SWARM_OS_FIRE`, `TZ`, `UV_CACHE_DIR`, proxies — **no
server token, no provider key**), an explicit interpreter (`python3`, `bash` or
`node`), a hard timeout (60 s default, 240 s max) and must live under
`/workspace` or `/data` — **container** paths.

> Prefer `/data/crons/` for anything carrying a secret. Agents write
> `/workspace`, so a script sitting there can be rewritten by the very agents
> the cron wakes — a recurring execution with no session supervision.

Anyone holding the `X-Auth-Token` can therefore run arbitrary code **in the
container**. That is the power the token already grants (a `bypassPermissions`
team on `/workspace` runs arbitrary code too), but it is worth saying out loud.

Worked example, the full output contract and the `uv run --with requests`
variant: [examples/crons/](../../examples/crons/).

`SWARM_OS_SCHEDULE_ENABLED` (default on) and `SWARM_OS_SCHEDULE_TZ` (default
UTC) are unchanged — they are now the master switch and timezone for all crons.
With scheduling off, crons stop ticking (the screen says so) but RUN NOW still
works.

**Migration note.** The per-role cadence is gone: the `schedule` /
`scheduleMessage` fields of a role no longer exist, and the cadence section of
the role editor with them. On the first boot after the upgrade, every role that
carried a cadence is converted into a `message` cron named `<role>-cadence` and
the role columns are cleared — nothing to do by hand, and nothing fires twice.
`POST` / `PATCH /roles` with a **non-null** `schedule` or `scheduleMessage` now
answers **400** (`SCHEDULE_MOVED`); the keys sent at `null` are still accepted,
so existing clients keep working.

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
docker compose --env-file .env -f examples/docker-compose.dist.yml logs -f
# stop (keeps /data)
docker compose --env-file .env -f examples/docker-compose.dist.yml down
# update to a newer image tag (edit .env first), then
./install.sh
# reconfigure (guided setup, current values as defaults)
./install.sh --reconfigure
```

Under the `ssh` transport, add `-f examples/docker-compose.ssh.yml` to the first
two — `install.sh` does it for you, and prints the exact line at the end of every
deploy.

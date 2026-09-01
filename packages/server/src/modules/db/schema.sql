-- swarm-os Phase 4 — SQLite schema (plan §8).
--
-- Two tables only: `orchestrators` and `sessions`. The mailbox lives strictly
-- in memory (plan §11 / §17) so there is intentionally NO `messages` table.
--
-- Pragmas:
--   - journal_mode=WAL: better concurrent reads, durable across crash.
--   - foreign_keys=ON: enforce sessions.orchestrator_id integrity.
--
-- IDs are TEXT (UUID v4 from crypto.randomUUID()). Timestamps are ISO 8601
-- strings (TEXT). Boolean-like values are TEXT enums (e.g. status).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS orchestrators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  role_id TEXT,                         -- nullable FK to roles.id (denormalized: label stays in `role`)
  status TEXT NOT NULL,                 -- starting|running|stopping|stopped|failed|interrupted
  lead_session_id TEXT,
  default_model TEXT NOT NULL,
  default_effort TEXT NOT NULL,
  default_permission_mode TEXT NOT NULL,
  -- Agent provider every session of this team inherits unless it names its own
  -- (multi-provider plan, Lot 2). 'claude' is what every pre-existing row means.
  default_provider TEXT NOT NULL DEFAULT 'claude',
  lead_preamble TEXT,
  worker_preamble TEXT,
  created_at TEXT NOT NULL,             -- ISO
  ended_at TEXT,                        -- ISO, nullable
  hidden_at TEXT,                       -- ISO, nullable: soft-delete from the map
  last_error TEXT,
  stop_reason TEXT,
  last_resumed_at TEXT,                 -- ISO, nullable: last time auto-resume rebuilt this orch
  resume_count INTEGER NOT NULL DEFAULT 0  -- monotonic, incremented on every successful resume
);

CREATE INDEX IF NOT EXISTS idx_orchestrators_status ON orchestrators(status);
CREATE INDEX IF NOT EXISTS idx_orchestrators_ended_at ON orchestrators(ended_at);
-- idx_orchestrators_hidden_at: created lazily in applyMigrations() AFTER the
-- ALTER TABLE that adds hidden_at, so legacy DBs created before this column
-- existed don't try to index a missing column on boot.

-- Roles: reusable templates for orchestrators. Every field except `label` is
-- optional; when present it pre-fills / overrides the corresponding orch field.
-- `connectors_json` is a JSON array of {type, ...config}. Only `type:"discord"`
-- with `webhookUrl` is supported today.
-- `schedule` / `schedule_message` are LEGACY and always NULL on a live
-- instance: cadence moved to the first-class `crons` table (modules/crons),
-- which supports N crons per role and a `script` action. The columns are kept
-- only so the boot-time migration in modules/crons/store.ts can read a cadence
-- written by an older version, convert it into a cron and clear it; RoleStore
-- forces both to NULL on every create/update, so nothing new lands here.
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  lead_prompt TEXT,
  lead_preamble TEXT,
  worker_preamble TEXT,
  worker_count INTEGER,
  default_model TEXT,
  default_effort TEXT,
  default_permission_mode TEXT,
  default_provider TEXT,                -- NULL = inherit the instance default
  connectors_json TEXT,
  schedule TEXT,
  schedule_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roles_label ON roles(label);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  orchestrator_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  type TEXT NOT NULL,                   -- lead|worker
  cwd TEXT NOT NULL,
  initial_prompt TEXT,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  permission_mode TEXT NOT NULL,
  -- Which CLI this agent runs. Resolved at spawn (session > team default);
  -- persisted so auto-resume brings the agent back on ITS provider, not claude.
  provider TEXT NOT NULL DEFAULT 'claude',
  status TEXT NOT NULL,                 -- starting|running|waiting|exited|killed|interrupted|failed
  pid INTEGER,
  started_at TEXT NOT NULL,             -- ISO
  ended_at TEXT,                        -- ISO, nullable
  exit_code INTEGER,
  last_error TEXT,
  stop_reason TEXT,
  log_path TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  hidden_at TEXT,                       -- ISO, nullable: soft-delete from the map
  -- session_secret is intentionally NOT persisted — it's regenerated on
  -- spawn and pivoting it across restarts gives no benefit (the PTY can't
  -- be restored anyway, plan §6 / §14).
  FOREIGN KEY (orchestrator_id) REFERENCES orchestrators(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_orch ON sessions(orchestrator_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_ended_at ON sessions(ended_at);
-- idx_sessions_hidden_at: see comment on idx_orchestrators_hidden_at above.

-- Phase 8 — mailbox persistence (auto-resume foundation).
-- The in-memory mailbox now write-through to this table so that messages
-- queued at restart time survive and get rehydrated on the next boot.
-- `delivered_at` NULL = pending; set when the recipient drains via read_inbox
-- (stamped after MCP response flush, not on Mailbox.read() — see plan §F.1).
CREATE TABLE IF NOT EXISTS mailbox_messages (
  id TEXT PRIMARY KEY,                  -- UUID v4 minted by Mailbox.push
  orchestrator_id TEXT NOT NULL,
  to_session_id TEXT NOT NULL,
  from_id TEXT NOT NULL,                -- session id | 'system' | 'human'
  content TEXT NOT NULL,
  ts TEXT NOT NULL,                     -- ISO 8601
  from_orchestrator_id TEXT,            -- cross-team only
  from_orchestrator_name TEXT,
  from_session_name TEXT,
  delivered_at TEXT,                    -- NULL = pending, ISO when delivered
  FOREIGN KEY (orchestrator_id) REFERENCES orchestrators(id) ON DELETE CASCADE
);
-- Partial index scoped on the typical rehydrate query
-- (WHERE orchestrator_id=? AND delivered_at IS NULL ORDER BY ts).
CREATE INDEX IF NOT EXISTS idx_mailbox_pending_by_orch
  ON mailbox_messages(orchestrator_id, delivered_at, ts)
  WHERE delivered_at IS NULL;

-- Per-instance visual settings (singleton row, id='current'). Lets the operator
-- distinguish multiple swarm-os instances running in parallel via accent color,
-- label, and a few typography knobs. Read by both server (`GET /settings`) and
-- web (applied as CSS vars on `:root`). Defaults live in code (modules/settings)
-- so an empty DB still renders correctly — the row is upserted lazily on first
-- PATCH from the UI.
CREATE TABLE IF NOT EXISTS instance_settings (
  id TEXT PRIMARY KEY,                  -- always 'current'
  instance_label TEXT,                  -- nullable, max 16 chars (UI-enforced)
  accent TEXT NOT NULL,                 -- hex #rrggbb
  bg_tint TEXT NOT NULL,                -- 'warm'|'neutral'|'cool'
  font_size INTEGER NOT NULL,           -- px, 11..16
  density TEXT NOT NULL,                -- 'compact'|'regular'|'comfy'
  dark_mode INTEGER NOT NULL DEFAULT 1, -- 1=dark (v1 only supports dark; toggle is UI stub)
  -- Version tag the operator chose to stop being nagged about (update
  -- detection). Not visual, but this singleton row is already "the operator's
  -- preferences for this instance" and a second one-row table would be worse.
  -- NOTE: also added by SwarmDb.applyMigrations() — an existing DB only gets
  -- the column through the ALTER, since CREATE TABLE IF NOT EXISTS skips.
  dismissed_update_version TEXT,
  -- OpenRouter credential used by the `opencode` provider (multi-provider Lot
  -- 6b). Here rather than in an env var because this deployment runs 24/7 and
  -- is never recreated for a config change: an env var can only be rotated by
  -- replacing the container, a row can be rotated from the UI and takes effect
  -- on the next spawn.
  -- NEVER leaves the server in clear: `SettingsStore.get()` masks it with the
  -- plugin PASSWORD_SENTINEL and only `getOpenRouterApiKey()` returns the
  -- plaintext (see modules/settings/index.ts).
  -- NOTE: also added by SwarmDb.applyMigrations() — an existing DB only gets
  -- the column through the ALTER, since CREATE TABLE IF NOT EXISTS skips.
  openrouter_api_key TEXT,
  updated_at TEXT NOT NULL              -- ISO 8601
);

-- Monitoring Lot 15 (docs/monitoring-agents.md) — DAILY token deltas per agent.
--
-- The long-trend table. `sessions` carries only CUMULATIVE counters, so it can
-- answer "what has this agent cost in total" and nothing else: the shape of a
-- week is not derivable from a running total read once. This table is that
-- history, written hourly by `modules/orchestrator/cost-rollup` and kept for 90
-- days by the boot GC — bounded, and small (one row per agent PER DAY, not per
-- turn).
--
-- Two column groups, and confusing them would silently double-count:
--   * `tokens_*` / `cache_*` are the DELTAS of the day — what the agent billed
--     between the first and the last tick of that UTC day. They are what a chart
--     and the CSV export sum.
--   * `cum_*` is bookkeeping: the LAST cumulative total the rollup observed for
--     this session. The next tick's delta is `cumulative_now - cum_*`, which is
--     what makes the rollup idempotent, restart-proof (the session counters are
--     seeded from the DB on resume) and continuous across midnight.
--
-- `cost_usd` is the ONE price this schema stores besides `sessions.reported_cost_usd`,
-- and for a different reason: it is the delta priced AT THE RATES IN FORCE WHEN
-- IT WAS WRITTEN. Everywhere else swarm-os re-prices tokens at read time so a
-- catalogue correction fixes yesterday; here, historical fidelity is the point —
-- a rate change in September must not silently rewrite what August cost.
-- NULL = the model could not be priced at that moment (never `0`, which would
-- read as "this day was free"), and a NULL that later gains a priceable delta
-- becomes that amount rather than staying NULL.
--
-- NO foreign key, deliberately, unlike `sessions` and `mailbox_messages`: this
-- is an accounting ledger and it must outlive the rows it names. A team hard-
-- deleted (or a session id whose row was dropped by a future cleanup) leaves its
-- spend in the history; the export LEFT JOINs for the names and renders `''`
-- when there is nothing left to join to.
CREATE TABLE IF NOT EXISTS session_token_daily (
  day TEXT NOT NULL,                       -- YYYY-MM-DD, UTC (the rollup's clock)
  session_id TEXT NOT NULL,
  orchestrator_id TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,    -- deltas of THIS day
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,                           -- the day's deltas, priced when written
  cum_in INTEGER NOT NULL DEFAULT 0,       -- last cumulative observed (bookkeeping)
  cum_out INTEGER NOT NULL DEFAULT 0,
  cum_cache_read INTEGER NOT NULL DEFAULT 0,
  cum_cache_write INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, session_id)
);
-- The export scans a date window across every session; the PK's leading column
-- already serves that, but the index is what keeps the 90-day GC
-- (`WHERE day < ?`) from degrading into a full table scan on a large history.
CREATE INDEX IF NOT EXISTS idx_session_token_daily_day ON session_token_daily(day);

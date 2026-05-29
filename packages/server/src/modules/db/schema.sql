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
  connectors_json TEXT,
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
  updated_at TEXT NOT NULL              -- ISO 8601
);

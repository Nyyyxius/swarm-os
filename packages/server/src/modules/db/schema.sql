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
  status TEXT NOT NULL,                 -- starting|running|stopping|stopped|failed
  lead_session_id TEXT,
  default_model TEXT NOT NULL,
  default_effort TEXT NOT NULL,
  default_permission_mode TEXT NOT NULL,
  lead_preamble TEXT,
  worker_preamble TEXT,
  created_at TEXT NOT NULL,             -- ISO
  ended_at TEXT,                        -- ISO, nullable
  last_error TEXT,
  stop_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_orchestrators_status ON orchestrators(status);
CREATE INDEX IF NOT EXISTS idx_orchestrators_ended_at ON orchestrators(ended_at);

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
  -- session_secret is intentionally NOT persisted — it's regenerated on
  -- spawn and pivoting it across restarts gives no benefit (the PTY can't
  -- be restored anyway, plan §6 / §14).
  FOREIGN KEY (orchestrator_id) REFERENCES orchestrators(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_orch ON sessions(orchestrator_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_ended_at ON sessions(ended_at);

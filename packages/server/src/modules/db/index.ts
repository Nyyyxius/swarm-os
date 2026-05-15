/**
 * Phase 4 — SQLite persistence layer (plan §6 Phase 4, §8).
 *
 * Two tables: `orchestrators`, `sessions`. Mailbox is in-memory by design
 * (plan §11/§17) and intentionally NOT persisted.
 *
 * The schema lives in `schema.sql` next to this file and is run idempotently
 * at construction (every CREATE statement is `IF NOT EXISTS`). Pragmas WAL +
 * `foreign_keys=ON` are also applied at construction.
 *
 * Survival semantics (plan §6 Phase 4 + §8 invariant):
 *
 *   At boot, the server calls `markAllNonTerminalAsInterrupted()` BEFORE any
 *   new orchestrator can be created. Every orch/session that was in a non-
 *   terminal state at the time the previous process died is updated to:
 *
 *     orchestrators: status='failed', ended_at=now, stop_reason='server-restart'
 *     sessions:      status='interrupted', ended_at=now, stop_reason='server-restart'
 *
 *   The PTYs themselves are gone forever — we don't try to re-spawn anything
 *   (plan §6 explicitly forbids that). The history just stays consultable.
 *
 * Failure mode (plan §15 / §17 trade-off): every write is wrapped in a
 * try/catch that logs `db.write_failed` at warn level and swallows. The DB
 * is observability state — if SQLite blows up, the orchestrator must keep
 * running on the in-memory model (plan §13 deployment scenarios assume the
 * `/data` volume is healthy, but a single broken write must not cascade).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database, { type Database as Db } from 'better-sqlite3';
import { withModule } from '../../logger.js';

const log = withModule('db');

export type OrchestratorStatusRow =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed';

export type SessionStatusRow =
  | 'starting'
  | 'running'
  | 'waiting'
  | 'exited'
  | 'killed'
  | 'interrupted'
  | 'failed';

export interface OrchestratorRow {
  id: string;
  name: string;
  role: string;
  status: OrchestratorStatusRow;
  lead_session_id: string | null;
  default_model: string;
  default_effort: string;
  default_permission_mode: string;
  lead_preamble: string | null;
  worker_preamble: string | null;
  created_at: string;
  ended_at: string | null;
  last_error: string | null;
  stop_reason: string | null;
}

export interface SessionRow {
  id: string;
  orchestrator_id: string;
  name: string;
  role: string;
  type: 'lead' | 'worker';
  cwd: string;
  initial_prompt: string | null;
  model: string;
  effort: string;
  permission_mode: string;
  status: SessionStatusRow;
  pid: number | null;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  last_error: string | null;
  stop_reason: string | null;
  log_path: string;
  last_activity_at: string;
}

const TERMINAL_ORCH = new Set<OrchestratorStatusRow>(['stopped', 'failed']);
const TERMINAL_SESSION = new Set<SessionStatusRow>([
  'exited',
  'killed',
  'interrupted',
  'failed',
]);

export class SwarmDb {
  readonly db: Db;
  private readonly upsertOrchStmt;
  private readonly upsertSessionStmt;
  private readonly getOrchStmt;
  private readonly listOrchStmt;
  private readonly listOrchByEndedStmt;
  private readonly listSessionsByOrchStmt;
  private readonly markOrchInterruptedStmt;
  private readonly markSessionInterruptedStmt;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, 'swarm-os.db');
    this.db = new Database(dbPath);
    this.applySchema();

    // Prepared statements — bound to `this` for use throughout the module.
    this.upsertOrchStmt = this.db.prepare<OrchestratorRow>(`
      INSERT INTO orchestrators (
        id, name, role, status, lead_session_id, default_model, default_effort,
        default_permission_mode, lead_preamble, worker_preamble, created_at,
        ended_at, last_error, stop_reason
      ) VALUES (
        @id, @name, @role, @status, @lead_session_id, @default_model, @default_effort,
        @default_permission_mode, @lead_preamble, @worker_preamble, @created_at,
        @ended_at, @last_error, @stop_reason
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        role = excluded.role,
        status = excluded.status,
        lead_session_id = excluded.lead_session_id,
        default_model = excluded.default_model,
        default_effort = excluded.default_effort,
        default_permission_mode = excluded.default_permission_mode,
        lead_preamble = excluded.lead_preamble,
        worker_preamble = excluded.worker_preamble,
        ended_at = excluded.ended_at,
        last_error = excluded.last_error,
        stop_reason = excluded.stop_reason
    `);

    this.upsertSessionStmt = this.db.prepare<SessionRow>(`
      INSERT INTO sessions (
        id, orchestrator_id, name, role, type, cwd, initial_prompt, model,
        effort, permission_mode, status, pid, started_at, ended_at, exit_code,
        last_error, stop_reason, log_path, last_activity_at
      ) VALUES (
        @id, @orchestrator_id, @name, @role, @type, @cwd, @initial_prompt, @model,
        @effort, @permission_mode, @status, @pid, @started_at, @ended_at, @exit_code,
        @last_error, @stop_reason, @log_path, @last_activity_at
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        role = excluded.role,
        type = excluded.type,
        cwd = excluded.cwd,
        initial_prompt = excluded.initial_prompt,
        model = excluded.model,
        effort = excluded.effort,
        permission_mode = excluded.permission_mode,
        status = excluded.status,
        pid = excluded.pid,
        ended_at = excluded.ended_at,
        exit_code = excluded.exit_code,
        last_error = excluded.last_error,
        stop_reason = excluded.stop_reason,
        log_path = excluded.log_path,
        last_activity_at = excluded.last_activity_at
    `);

    this.getOrchStmt = this.db.prepare<[string], OrchestratorRow>(
      'SELECT * FROM orchestrators WHERE id = ?',
    );
    this.listOrchStmt = this.db.prepare<[], OrchestratorRow>(
      'SELECT * FROM orchestrators ORDER BY created_at DESC',
    );
    // Recently-ended orchestrators ordered by ended_at desc (NULLs treated
    // as oldest so non-terminated rows fall off the tail).
    this.listOrchByEndedStmt = this.db.prepare<[number], OrchestratorRow>(
      `SELECT * FROM orchestrators
       WHERE status IN ('stopped','failed')
       ORDER BY COALESCE(ended_at, '') DESC
       LIMIT ?`,
    );
    this.listSessionsByOrchStmt = this.db.prepare<[string], SessionRow>(
      'SELECT * FROM sessions WHERE orchestrator_id = ? ORDER BY started_at ASC',
    );

    this.markOrchInterruptedStmt = this.db.prepare(`
      UPDATE orchestrators
      SET status = 'failed',
          ended_at = ?,
          stop_reason = 'server-restart',
          last_error = COALESCE(last_error, 'server-restart')
      WHERE status NOT IN ('stopped','failed')
    `);
    this.markSessionInterruptedStmt = this.db.prepare(`
      UPDATE sessions
      SET status = 'interrupted',
          ended_at = ?,
          stop_reason = 'server-restart'
      WHERE status NOT IN ('exited','killed','interrupted','failed')
    `);
  }

  private applySchema(): void {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // tsx executes the .ts source directly, while compiled `dist/` reads .js
    // — schema.sql sits next to both, so just look in __dirname.
    const schemaPath = path.join(here, 'schema.sql');
    let schema: string;
    try {
      schema = fs.readFileSync(schemaPath, 'utf8');
    } catch {
      // Fallback for compiled paths where the .sql wasn't copied. Inline a
      // copy as a safety net so tests can still bring up the DB.
      schema = INLINE_SCHEMA;
    }
    this.db.exec(schema);
  }

  // --- Public API --------------------------------------------------------

  upsertOrchestrator(row: OrchestratorRow): void {
    try {
      this.upsertOrchStmt.run(row);
    } catch (err) {
      log.warn({
        event: 'db.write_failed',
        op: 'upsertOrchestrator',
        orchId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  upsertSession(row: SessionRow): void {
    try {
      this.upsertSessionStmt.run(row);
    } catch (err) {
      log.warn({
        event: 'db.write_failed',
        op: 'upsertSession',
        sessionId: row.id,
        orchId: row.orchestrator_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  getOrchestrator(id: string): OrchestratorRow | null {
    try {
      const row = this.getOrchStmt.get(id);
      return row ?? null;
    } catch (err) {
      log.warn({ event: 'db.read_failed', op: 'getOrchestrator', error: String(err) });
      return null;
    }
  }

  listOrchestrators(): OrchestratorRow[] {
    try {
      return this.listOrchStmt.all();
    } catch (err) {
      log.warn({ event: 'db.read_failed', op: 'listOrchestrators', error: String(err) });
      return [];
    }
  }

  listRecentlyTerminatedOrchestrators(limit: number): OrchestratorRow[] {
    try {
      return this.listOrchByEndedStmt.all(limit);
    } catch (err) {
      log.warn({
        event: 'db.read_failed',
        op: 'listRecentlyTerminatedOrchestrators',
        error: String(err),
      });
      return [];
    }
  }

  listSessions(orchId: string): SessionRow[] {
    try {
      return this.listSessionsByOrchStmt.all(orchId);
    } catch (err) {
      log.warn({ event: 'db.read_failed', op: 'listSessions', error: String(err) });
      return [];
    }
  }

  /**
   * Mark every non-terminal orch/session as interrupted. Used at boot to
   * record that the previous server restart wiped their PTYs (plan §6
   * Phase 4 + §8). Returns the row counts for both tables.
   */
  markAllNonTerminalAsInterrupted(): { orchestrators: number; sessions: number } {
    const now = new Date().toISOString();
    let orchs = 0;
    let sessions = 0;
    try {
      const oRes = this.markOrchInterruptedStmt.run(now);
      orchs = oRes.changes;
      const sRes = this.markSessionInterruptedStmt.run(now);
      sessions = sRes.changes;
    } catch (err) {
      log.warn({
        event: 'db.write_failed',
        op: 'markAllNonTerminalAsInterrupted',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { orchestrators: orchs, sessions };
  }

  /** Helper for tests / verify scripts — both predicates exposed. */
  static isTerminalOrch(s: OrchestratorStatusRow): boolean {
    return TERMINAL_ORCH.has(s);
  }
  static isTerminalSession(s: SessionStatusRow): boolean {
    return TERMINAL_SESSION.has(s);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* best-effort */
    }
  }
}

// Fallback in-source schema for environments where reading schema.sql fails
// (e.g. compiled runtime where the .sql wasn't copied). Kept in sync with
// schema.sql by hand — if you change the SQL there, mirror it here.
const INLINE_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS orchestrators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  lead_session_id TEXT,
  default_model TEXT NOT NULL,
  default_effort TEXT NOT NULL,
  default_permission_mode TEXT NOT NULL,
  lead_preamble TEXT,
  worker_preamble TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT,
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
  type TEXT NOT NULL,
  cwd TEXT NOT NULL,
  initial_prompt TEXT,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  permission_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  pid INTEGER,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER,
  last_error TEXT,
  stop_reason TEXT,
  log_path TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  FOREIGN KEY (orchestrator_id) REFERENCES orchestrators(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_orch ON sessions(orchestrator_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_ended_at ON sessions(ended_at);
`;

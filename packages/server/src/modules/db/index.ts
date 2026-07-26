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
  | 'failed'
  // Phase 8 — non-resumable status used by the atomic guard in loadResumableState():
  // a row flipped to 'interrupted' just before respawn so that a crash mid-resume
  // can't lead to a double-spawn at the next boot.
  | 'interrupted';

export type SessionStatusRow =
  | 'starting'
  | 'running'
  // S5 — operator-paused via SIGSTOP. Non-terminal: counted as in-flight by
  // `markAllNonTerminalAsInterrupted` (the `NOT IN (terminal-set)` query
  // already sweeps it without an explicit branch).
  | 'paused'
  | 'waiting'
  | 'exited'
  | 'killed'
  | 'interrupted'
  | 'failed';

export interface OrchestratorRow {
  id: string;
  name: string;
  role: string;
  role_id: string | null;
  status: OrchestratorStatusRow;
  lead_session_id: string | null;
  default_model: string;
  default_effort: string;
  default_permission_mode: string;
  lead_preamble: string | null;
  worker_preamble: string | null;
  created_at: string;
  ended_at: string | null;
  hidden_at: string | null;
  last_error: string | null;
  stop_reason: string | null;
  // Phase 8 — auto-resume audit (visible in UI via OrchestratorView).
  last_resumed_at: string | null;
  resume_count: number;
}

/**
 * Phase 8 — persisted mailbox row. Mirrors the in-memory Message struct,
 * plus an `orchestrator_id` foreign key and a `delivered_at` lifecycle column.
 */
export interface MailboxMessageRow {
  id: string;
  orchestrator_id: string;
  to_session_id: string;
  from_id: string;
  content: string;
  ts: string;
  from_orchestrator_id: string | null;
  from_orchestrator_name: string | null;
  from_session_name: string | null;
  delivered_at: string | null;
  source_kind: string | null;
  source_message_id: string | null;
  thread_id: string | null;
  thread_name: string | null;
}

/**
 * Roles: reusable orchestrator templates. The `connectors_json` column carries
 * a JSON-serialized array of {type, ...config} entries — see modules/roles
 * for the parsed types.
 */
export interface RoleRow {
  id: string;
  label: string;
  lead_prompt: string | null;
  lead_preamble: string | null;
  worker_preamble: string | null;
  worker_count: number | null;
  default_model: string | null;
  default_effort: string | null;
  default_permission_mode: string | null;
  connectors_json: string | null;
  schedule: string | null;
  schedule_message: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Per-instance operator preferences. Singleton row (`id='current'`). The
 * defaults are seeded in code by the SettingsStore the first time `update` is
 * called, not at schema-create time — read methods return `null` when the row
 * is absent and the module layer substitutes hard-coded defaults.
 *
 * Mostly visual, with one exception: `dismissed_update_version` (see below).
 */
export interface InstanceSettingsRow {
  id: string;
  instance_label: string | null;
  accent: string;
  bg_tint: string;
  font_size: number;
  density: string;
  dark_mode: number;
  /**
   * Release tag the operator explicitly chose to ignore. Without it, an
   * operator who decides to stay on the current version pins a badge on their
   * UI forever, and the only way to make it stop is to take the update — which
   * is not a choice.
   */
  dismissed_update_version: string | null;
  updated_at: string;
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
  hidden_at: string | null;
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
  private readonly getSessionStmt;
  private readonly markOrchInterruptedStmt;
  private readonly markSessionInterruptedStmt;
  private readonly hideOrchStmt;
  private readonly hideSessionStmt;
  private readonly hideSessionsOfOrchStmt;
  private readonly insertRoleStmt;
  private readonly updateRoleStmt;
  private readonly getRoleStmt;
  private readonly listRolesStmt;
  private readonly deleteRoleStmt;
  private readonly getInstanceSettingsStmt;
  private readonly upsertInstanceSettingsStmt;
  // Phase 8 — auto-resume + persisted mailbox.
  private readonly markOrchInterruptedByIdStmt;
  private readonly markSessionsInterruptedByOrchIdStmt;
  private readonly listResumableOrchsStmt;
  private readonly listStoppingOrchsStmt;
  private readonly insertMessageStmt;
  private readonly insertMessageOrIgnoreStmt;
  private readonly selectPendingMessagesForOrchStmt;
  private readonly deleteOldDeliveredMessagesStmt;
  private readonly insertMessagesBatchFn;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, 'swarm-os.db');
    this.db = new Database(dbPath);
    this.applySchema();
    this.applyMigrations();

    // Prepared statements — bound to `this` for use throughout the module.
    this.upsertOrchStmt = this.db.prepare<OrchestratorRow>(`
      INSERT INTO orchestrators (
        id, name, role, role_id, status, lead_session_id, default_model, default_effort,
        default_permission_mode, lead_preamble, worker_preamble, created_at,
        ended_at, hidden_at, last_error, stop_reason, last_resumed_at, resume_count
      ) VALUES (
        @id, @name, @role, @role_id, @status, @lead_session_id, @default_model, @default_effort,
        @default_permission_mode, @lead_preamble, @worker_preamble, @created_at,
        @ended_at, @hidden_at, @last_error, @stop_reason, @last_resumed_at, @resume_count
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        role = excluded.role,
        role_id = excluded.role_id,
        status = excluded.status,
        lead_session_id = excluded.lead_session_id,
        default_model = excluded.default_model,
        default_effort = excluded.default_effort,
        default_permission_mode = excluded.default_permission_mode,
        lead_preamble = excluded.lead_preamble,
        worker_preamble = excluded.worker_preamble,
        ended_at = excluded.ended_at,
        last_error = excluded.last_error,
        stop_reason = excluded.stop_reason,
        last_resumed_at = excluded.last_resumed_at,
        resume_count = excluded.resume_count
        -- hidden_at intentionally NOT overwritten: once hidden, stays hidden
    `);

    this.upsertSessionStmt = this.db.prepare<SessionRow>(`
      INSERT INTO sessions (
        id, orchestrator_id, name, role, type, cwd, initial_prompt, model,
        effort, permission_mode, status, pid, started_at, ended_at, exit_code,
        last_error, stop_reason, log_path, last_activity_at, hidden_at
      ) VALUES (
        @id, @orchestrator_id, @name, @role, @type, @cwd, @initial_prompt, @model,
        @effort, @permission_mode, @status, @pid, @started_at, @ended_at, @exit_code,
        @last_error, @stop_reason, @log_path, @last_activity_at, @hidden_at
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
        -- hidden_at intentionally NOT overwritten: once hidden, stays hidden
    `);

    this.getOrchStmt = this.db.prepare<[string], OrchestratorRow>(
      'SELECT * FROM orchestrators WHERE id = ? AND hidden_at IS NULL',
    );
    this.listOrchStmt = this.db.prepare<[], OrchestratorRow>(
      'SELECT * FROM orchestrators WHERE hidden_at IS NULL ORDER BY created_at DESC',
    );
    // Recently-ended orchestrators ordered by ended_at desc (NULLs treated
    // as oldest so non-terminated rows fall off the tail). Hidden rows are
    // excluded — they were soft-deleted by the user.
    this.listOrchByEndedStmt = this.db.prepare<[number], OrchestratorRow>(
      `SELECT * FROM orchestrators
       WHERE status IN ('stopped','failed') AND hidden_at IS NULL
       ORDER BY COALESCE(ended_at, '') DESC
       LIMIT ?`,
    );
    this.listSessionsByOrchStmt = this.db.prepare<[string], SessionRow>(
      `SELECT * FROM sessions
       WHERE orchestrator_id = ? AND hidden_at IS NULL
       ORDER BY started_at ASC`,
    );
    this.getSessionStmt = this.db.prepare<[string], SessionRow>(
      'SELECT * FROM sessions WHERE id = ? AND hidden_at IS NULL',
    );
    this.hideOrchStmt = this.db.prepare<[string, string]>(
      'UPDATE orchestrators SET hidden_at = ? WHERE id = ? AND hidden_at IS NULL',
    );
    this.hideSessionStmt = this.db.prepare<[string, string]>(
      'UPDATE sessions SET hidden_at = ? WHERE id = ? AND hidden_at IS NULL',
    );
    this.hideSessionsOfOrchStmt = this.db.prepare<[string, string]>(
      'UPDATE sessions SET hidden_at = ? WHERE orchestrator_id = ? AND hidden_at IS NULL',
    );

    // Legacy/fallback path (SWARM_OS_AUTO_RESUME=false): mark every
    // non-terminal orch + session as interrupted. Excludes rows already in
    // `interrupted` so the atomic-guard flip in loadResumableState() isn't
    // clobbered if both helpers run.
    this.markOrchInterruptedStmt = this.db.prepare(`
      UPDATE orchestrators
      SET status = 'failed',
          ended_at = ?,
          stop_reason = COALESCE(stop_reason, 'server-restart'),
          last_error = COALESCE(last_error, 'server-restart')
      WHERE status NOT IN ('stopped','failed','interrupted')
    `);
    this.markSessionInterruptedStmt = this.db.prepare(`
      UPDATE sessions
      SET status = 'interrupted',
          ended_at = ?,
          stop_reason = COALESCE(stop_reason, 'server-restart')
      WHERE status NOT IN ('exited','killed','interrupted','failed')
    `);

    // Phase 8 — atomic guard helpers. We flip a single orch row to
    // `interrupted` BEFORE respawning it, so a crash mid-resume doesn't lead
    // to a double-spawn at the next boot.
    this.markOrchInterruptedByIdStmt = this.db.prepare<[string, string, string]>(`
      UPDATE orchestrators
      SET status = 'interrupted',
          stop_reason = ?,
          last_error = COALESCE(last_error, ?)
      WHERE id = ? AND status NOT IN ('stopped','failed','interrupted')
    `);
    this.markSessionsInterruptedByOrchIdStmt = this.db.prepare<[string, string, string]>(`
      UPDATE sessions
      SET status = 'interrupted',
          ended_at = ?,
          stop_reason = ?
      WHERE orchestrator_id = ?
        AND status NOT IN ('exited','killed','interrupted','failed')
    `);
    // Resumable candidates: non-terminal, non-hidden orchestrators that the
    // operator hasn't explicitly asked to stop.
    this.listResumableOrchsStmt = this.db.prepare<[], OrchestratorRow>(`
      SELECT * FROM orchestrators
      WHERE status IN ('starting','running')
        AND hidden_at IS NULL
      ORDER BY created_at ASC
    `);
    this.listStoppingOrchsStmt = this.db.prepare<[], OrchestratorRow>(`
      SELECT * FROM orchestrators
      WHERE status = 'stopping' AND hidden_at IS NULL
    `);

    // Phase 8 — mailbox persistence statements.
    this.insertMessageStmt = this.db.prepare<MailboxMessageRow>(`
      INSERT INTO mailbox_messages (
        id, orchestrator_id, to_session_id, from_id, content, ts,
        from_orchestrator_id, from_orchestrator_name, from_session_name, delivered_at,
        source_kind, source_message_id, thread_id, thread_name
      ) VALUES (
        @id, @orchestrator_id, @to_session_id, @from_id, @content, @ts,
        @from_orchestrator_id, @from_orchestrator_name, @from_session_name, @delivered_at,
        @source_kind, @source_message_id, @thread_id, @thread_name
      )
    `);
    this.insertMessageOrIgnoreStmt = this.db.prepare<MailboxMessageRow>(`
      INSERT OR IGNORE INTO mailbox_messages (
        id, orchestrator_id, to_session_id, from_id, content, ts,
        from_orchestrator_id, from_orchestrator_name, from_session_name, delivered_at,
        source_kind, source_message_id, thread_id, thread_name
      ) VALUES (
        @id, @orchestrator_id, @to_session_id, @from_id, @content, @ts,
        @from_orchestrator_id, @from_orchestrator_name, @from_session_name, @delivered_at,
        @source_kind, @source_message_id, @thread_id, @thread_name
      )
    `);
    this.selectPendingMessagesForOrchStmt = this.db.prepare<[string], MailboxMessageRow>(`
      SELECT * FROM mailbox_messages
      WHERE orchestrator_id = ? AND delivered_at IS NULL
      ORDER BY ts ASC
    `);
    this.deleteOldDeliveredMessagesStmt = this.db.prepare<[string]>(`
      DELETE FROM mailbox_messages
      WHERE delivered_at IS NOT NULL AND delivered_at < ?
    `);
    // markMessagesDelivered uses a freshly-built statement per call (variadic
    // IN clause) — better-sqlite3 doesn't support array-spread placeholders.

    // Batch insert helper — wrapped in a transaction so a 50-recipient
    // broadcast is one fsync instead of fifty (plan §F.2).
    this.insertMessagesBatchFn = this.db.transaction((rows: MailboxMessageRow[]) => {
      for (const row of rows) this.insertMessageStmt.run(row);
    });

    this.insertRoleStmt = this.db.prepare<RoleRow>(`
      INSERT INTO roles (
        id, label, lead_prompt, lead_preamble, worker_preamble, worker_count,
        default_model, default_effort, default_permission_mode, connectors_json,
        schedule, schedule_message,
        created_at, updated_at
      ) VALUES (
        @id, @label, @lead_prompt, @lead_preamble, @worker_preamble, @worker_count,
        @default_model, @default_effort, @default_permission_mode, @connectors_json,
        @schedule, @schedule_message,
        @created_at, @updated_at
      )
    `);
    this.updateRoleStmt = this.db.prepare<RoleRow>(`
      UPDATE roles SET
        label = @label,
        lead_prompt = @lead_prompt,
        lead_preamble = @lead_preamble,
        worker_preamble = @worker_preamble,
        worker_count = @worker_count,
        default_model = @default_model,
        default_effort = @default_effort,
        default_permission_mode = @default_permission_mode,
        connectors_json = @connectors_json,
        schedule = @schedule,
        schedule_message = @schedule_message,
        updated_at = @updated_at
      WHERE id = @id
    `);
    this.getRoleStmt = this.db.prepare<[string], RoleRow>(
      'SELECT * FROM roles WHERE id = ?',
    );
    this.listRolesStmt = this.db.prepare<[], RoleRow>(
      'SELECT * FROM roles ORDER BY label ASC',
    );
    this.deleteRoleStmt = this.db.prepare<[string]>(
      'DELETE FROM roles WHERE id = ?',
    );

    this.getInstanceSettingsStmt = this.db.prepare<[string], InstanceSettingsRow>(
      'SELECT * FROM instance_settings WHERE id = ?',
    );
    this.upsertInstanceSettingsStmt = this.db.prepare<InstanceSettingsRow>(`
      INSERT INTO instance_settings (
        id, instance_label, accent, bg_tint, font_size, density, dark_mode,
        dismissed_update_version, updated_at
      ) VALUES (
        @id, @instance_label, @accent, @bg_tint, @font_size, @density, @dark_mode,
        @dismissed_update_version, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        instance_label = excluded.instance_label,
        accent = excluded.accent,
        bg_tint = excluded.bg_tint,
        font_size = excluded.font_size,
        density = excluded.density,
        dark_mode = excluded.dark_mode,
        dismissed_update_version = excluded.dismissed_update_version,
        updated_at = excluded.updated_at
    `);
  }

  /**
   * Idempotent column-additions for upgrades. SQLite's `CREATE TABLE IF NOT
   * EXISTS` skips the table entirely if it already exists, so a fresh
   * column on an existing table needs an explicit `ALTER TABLE`. We swallow
   * the duplicate-column error so this stays safe to run on every boot.
   */
  private applyMigrations(): void {
    const additions: Array<{ table: string; column: string; ddl: string }> = [
      { table: 'orchestrators', column: 'role_id', ddl: 'ALTER TABLE orchestrators ADD COLUMN role_id TEXT' },
      { table: 'orchestrators', column: 'hidden_at', ddl: 'ALTER TABLE orchestrators ADD COLUMN hidden_at TEXT' },
      { table: 'sessions',      column: 'hidden_at', ddl: 'ALTER TABLE sessions ADD COLUMN hidden_at TEXT' },
      // Phase 8 — auto-resume audit columns.
      { table: 'orchestrators', column: 'last_resumed_at', ddl: 'ALTER TABLE orchestrators ADD COLUMN last_resumed_at TEXT' },
      { table: 'orchestrators', column: 'resume_count', ddl: 'ALTER TABLE orchestrators ADD COLUMN resume_count INTEGER NOT NULL DEFAULT 0' },
      // Discord thread / reply support — additive nullable columns. `source_kind`
      // lets us extend to other bridges (Slack, Telegram) without another migration.
      { table: 'mailbox_messages', column: 'source_kind',       ddl: 'ALTER TABLE mailbox_messages ADD COLUMN source_kind TEXT' },
      { table: 'mailbox_messages', column: 'source_message_id', ddl: 'ALTER TABLE mailbox_messages ADD COLUMN source_message_id TEXT' },
      { table: 'mailbox_messages', column: 'thread_id',         ddl: 'ALTER TABLE mailbox_messages ADD COLUMN thread_id TEXT' },
      { table: 'mailbox_messages', column: 'thread_name',       ddl: 'ALTER TABLE mailbox_messages ADD COLUMN thread_name TEXT' },
      // Per-role cadence (modules/schedule) — additive nullable columns.
      { table: 'roles', column: 'schedule',         ddl: 'ALTER TABLE roles ADD COLUMN schedule TEXT' },
      { table: 'roles', column: 'schedule_message', ddl: 'ALTER TABLE roles ADD COLUMN schedule_message TEXT' },
      // Update detection — the version the operator chose to ignore. Declared
      // in schema.sql AND in INLINE_SCHEMA AND here: the first two only ever
      // run on a FRESH database (CREATE TABLE IF NOT EXISTS skips an existing
      // table wholesale), so every already-deployed instance gets the column
      // exclusively through this ALTER.
      { table: 'instance_settings', column: 'dismissed_update_version', ddl: 'ALTER TABLE instance_settings ADD COLUMN dismissed_update_version TEXT' },
    ];
    for (const a of additions) {
      try {
        this.db.exec(a.ddl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/duplicate column name/i.test(msg)) {
          log.warn({ event: 'db.migration_failed', table: a.table, column: a.column, error: msg });
        }
      }
    }
    // Idempotent index creation for the new columns (not in older schema.sql
    // exports). Same swallow-if-exists pattern.
    try {
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_orchestrators_hidden_at ON orchestrators(hidden_at)');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_hidden_at ON sessions(hidden_at)');
    } catch (err) {
      log.warn({ event: 'db.migration_failed', op: 'hidden_at_indexes', error: String(err) });
    }
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

  /** Single session by id (history fallback for `GET /sessions/:id`). */
  getSession(id: string): SessionRow | null {
    try {
      return this.getSessionStmt.get(id) ?? null;
    } catch (err) {
      log.warn({ event: 'db.read_failed', op: 'getSession', error: String(err) });
      return null;
    }
  }

  /**
   * Soft-delete a single session from the map. The row stays in the DB for
   * audit; subsequent SELECTs filter `WHERE hidden_at IS NULL`. Returns true
   * if a row was hidden (false if already hidden or absent).
   */
  hideSession(id: string): boolean {
    try {
      const res = this.hideSessionStmt.run(new Date().toISOString(), id);
      return res.changes > 0;
    } catch (err) {
      log.warn({
        event: 'db.write_failed',
        op: 'hideSession',
        sessionId: id,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Soft-delete an orchestrator AND cascade-hide all of its sessions. Returns
   * true if the orchestrator row was hidden (false if already hidden / absent).
   * The cascade runs unconditionally so any half-hidden state from a prior
   * partial run gets cleaned up.
   */
  hideOrchestrator(id: string): boolean {
    const now = new Date().toISOString();
    try {
      const res = this.hideOrchStmt.run(now, id);
      // Cascade always — covers the case where someone hid the orch row but
      // not the sessions in a prior call (defensive idempotence).
      this.hideSessionsOfOrchStmt.run(now, id);
      return res.changes > 0;
    } catch (err) {
      log.warn({
        event: 'db.write_failed',
        op: 'hideOrchestrator',
        orchId: id,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Mark every non-terminal orch/session as interrupted. Used at boot in the
   * legacy `SWARM_OS_AUTO_RESUME=false` path to record that the previous
   * server restart wiped their PTYs (plan §6 Phase 4 + §8). Rows already in
   * 'interrupted' state (flipped earlier by the atomic guard in
   * `loadResumableState`) are intentionally left alone.
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

  /**
   * Phase 8 — atomic guard for a single orchestrator. Flips its status to
   * 'interrupted' with the given `stopReason`. Also marks all of its
   * non-terminal sessions as 'interrupted'. Runs in a single transaction so
   * a crash between the two UPDATEs cannot leave the pair inconsistent.
   *
   * Used by `loadResumableState`: rows are flipped to 'interrupted'
   * BEFORE the spawner attempts to respawn them. If the resume succeeds,
   * `orch.resume()` UPSERTs the row back to 'running'. If the process dies
   * mid-resume, the next boot finds 'interrupted' (not resumable) — no
   * double-spawn.
   *
   * @returns true if the orchestrator row was actually flipped.
   */
  markOrchAndSessionsInterrupted(orchId: string, stopReason: string): boolean {
    try {
      const now = new Date().toISOString();
      let flipped = false;
      this.db.transaction(() => {
        const oRes = this.markOrchInterruptedByIdStmt.run(stopReason, stopReason, orchId);
        flipped = oRes.changes > 0;
        this.markSessionsInterruptedByOrchIdStmt.run(now, stopReason, orchId);
      })();
      return flipped;
    } catch (err) {
      log.warn({
        event: 'db.write_failed',
        op: 'markOrchAndSessionsInterrupted',
        orchId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** Phase 8 — list orch rows in resumable status (starting|running). */
  listResumableOrchestrators(): OrchestratorRow[] {
    try {
      return this.listResumableOrchsStmt.all();
    } catch (err) {
      log.warn({ event: 'db.read_failed', op: 'listResumableOrchestrators', error: String(err) });
      return [];
    }
  }

  /** Phase 8 — list orch rows in 'stopping' status (reaped, not resumed). */
  listStoppingOrchestrators(): OrchestratorRow[] {
    try {
      return this.listStoppingOrchsStmt.all();
    } catch (err) {
      log.warn({ event: 'db.read_failed', op: 'listStoppingOrchestrators', error: String(err) });
      return [];
    }
  }

  // --- Phase 8: Mailbox persistence -------------------------------------

  /**
   * INSERT a single mailbox message. Throws on PK collision (a bug elsewhere
   * — silent IGNORE would mask the issue; see plan §F.3 for the rationale).
   * The rehydrate path uses `insertMessageOrIgnore` instead.
   */
  insertMailboxMessage(row: MailboxMessageRow): void {
    try {
      this.insertMessageStmt.run(row);
    } catch (err) {
      log.warn({
        event: 'db.write_failed',
        op: 'insertMailboxMessage',
        msgId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Batch INSERT wrapped in a transaction. One fsync for the whole batch
   * (better-sqlite3 `db.transaction`), avoiding the N-fsyncs blow-up of a
   * 50-recipient broadcast.
   */
  insertMailboxMessagesBatch(rows: MailboxMessageRow[]): void {
    if (rows.length === 0) return;
    try {
      this.insertMessagesBatchFn(rows);
    } catch (err) {
      log.warn({
        event: 'db.write_failed',
        op: 'insertMailboxMessagesBatch',
        count: rows.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Defensive INSERT OR IGNORE — used only if a row needs to be re-inserted idempotently. */
  insertMailboxMessageOrIgnore(row: MailboxMessageRow): void {
    try {
      this.insertMessageOrIgnoreStmt.run(row);
    } catch (err) {
      log.warn({
        event: 'db.write_failed',
        op: 'insertMailboxMessageOrIgnore',
        msgId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Mark a set of messages as delivered (`delivered_at = now`). Variadic IN
   * clause built per-call since better-sqlite3 doesn't spread arrays into
   * placeholders.
   */
  markMailboxMessagesDelivered(ids: string[]): void {
    if (ids.length === 0) return;
    try {
      const placeholders = ids.map(() => '?').join(',');
      const stmt = this.db.prepare(
        `UPDATE mailbox_messages SET delivered_at = ? WHERE id IN (${placeholders})`,
      );
      stmt.run(new Date().toISOString(), ...ids);
    } catch (err) {
      log.warn({
        event: 'db.write_failed',
        op: 'markMailboxMessagesDelivered',
        count: ids.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Pending (delivered_at IS NULL) messages for one orch, sorted by ts ASC. */
  selectPendingMailboxMessagesForOrch(orchId: string): MailboxMessageRow[] {
    try {
      return this.selectPendingMessagesForOrchStmt.all(orchId);
    } catch (err) {
      log.warn({
        event: 'db.read_failed',
        op: 'selectPendingMailboxMessagesForOrch',
        orchId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * GC: delete delivered messages older than the given ISO threshold.
   * Returns the number of rows removed. Called once at boot.
   */
  deleteOldDeliveredMailboxMessages(olderThanIso: string): number {
    try {
      const res = this.deleteOldDeliveredMessagesStmt.run(olderThanIso);
      return res.changes;
    } catch (err) {
      log.warn({
        event: 'db.write_failed',
        op: 'deleteOldDeliveredMailboxMessages',
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  // --- Roles -------------------------------------------------------------

  insertRole(row: RoleRow): void {
    try {
      this.insertRoleStmt.run(row);
    } catch (err) {
      log.warn({
        event: 'db.write_failed',
        op: 'insertRole',
        roleId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  updateRole(row: RoleRow): void {
    try {
      this.updateRoleStmt.run(row);
    } catch (err) {
      log.warn({
        event: 'db.write_failed',
        op: 'updateRole',
        roleId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  getRole(id: string): RoleRow | null {
    try {
      const row = this.getRoleStmt.get(id);
      return row ?? null;
    } catch (err) {
      log.warn({ event: 'db.read_failed', op: 'getRole', error: String(err) });
      return null;
    }
  }

  listRoles(): RoleRow[] {
    try {
      return this.listRolesStmt.all();
    } catch (err) {
      log.warn({ event: 'db.read_failed', op: 'listRoles', error: String(err) });
      return [];
    }
  }

  deleteRole(id: string): boolean {
    try {
      const res = this.deleteRoleStmt.run(id);
      return res.changes > 0;
    } catch (err) {
      log.warn({
        event: 'db.write_failed',
        op: 'deleteRole',
        roleId: id,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  // --- Instance settings --------------------------------------------------

  /**
   * Read the singleton instance settings row (`id='current'`). Returns null
   * if the row hasn't been seeded yet — caller substitutes hard-coded
   * defaults from `modules/settings` rather than us touching the DB on read.
   */
  getInstanceSettings(): InstanceSettingsRow | null {
    try {
      return this.getInstanceSettingsStmt.get('current') ?? null;
    } catch (err) {
      log.warn({ event: 'db.read_failed', op: 'getInstanceSettings', error: String(err) });
      return null;
    }
  }

  upsertInstanceSettings(row: InstanceSettingsRow): void {
    try {
      this.upsertInstanceSettingsStmt.run(row);
    } catch (err) {
      log.warn({
        event: 'db.write_failed',
        op: 'upsertInstanceSettings',
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
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
  role_id TEXT,
  status TEXT NOT NULL,
  lead_session_id TEXT,
  default_model TEXT NOT NULL,
  default_effort TEXT NOT NULL,
  default_permission_mode TEXT NOT NULL,
  lead_preamble TEXT,
  worker_preamble TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT,
  hidden_at TEXT,
  last_error TEXT,
  stop_reason TEXT,
  last_resumed_at TEXT,
  resume_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_orchestrators_status ON orchestrators(status);
CREATE INDEX IF NOT EXISTS idx_orchestrators_ended_at ON orchestrators(ended_at);

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
  hidden_at TEXT,
  FOREIGN KEY (orchestrator_id) REFERENCES orchestrators(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_orch ON sessions(orchestrator_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_ended_at ON sessions(ended_at);

CREATE TABLE IF NOT EXISTS mailbox_messages (
  id TEXT PRIMARY KEY,
  orchestrator_id TEXT NOT NULL,
  to_session_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  content TEXT NOT NULL,
  ts TEXT NOT NULL,
  from_orchestrator_id TEXT,
  from_orchestrator_name TEXT,
  from_session_name TEXT,
  delivered_at TEXT,
  source_kind TEXT,
  source_message_id TEXT,
  thread_id TEXT,
  thread_name TEXT,
  FOREIGN KEY (orchestrator_id) REFERENCES orchestrators(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mailbox_pending_by_orch
  ON mailbox_messages(orchestrator_id, delivered_at, ts)
  WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS instance_settings (
  id TEXT PRIMARY KEY,
  instance_label TEXT,
  accent TEXT NOT NULL,
  bg_tint TEXT NOT NULL,
  font_size INTEGER NOT NULL,
  density TEXT NOT NULL,
  dark_mode INTEGER NOT NULL DEFAULT 1,
  dismissed_update_version TEXT,
  updated_at TEXT NOT NULL
);
`;

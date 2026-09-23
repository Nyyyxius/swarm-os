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
  /** Provider inherited by every session of this team. `'claude'` for legacy rows. */
  default_provider: string;
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
  /** NULL = inherit (instance default). Same shape as `default_model`. */
  default_provider: string | null;
  connectors_json: string | null;
  schedule: string | null;
  schedule_message: string | null;
  /**
   * Approval-gate per-role override (docs/garde-fous-approbation.md, P5),
   * JSON-serialized. NULL = no override (default arming + Discord notify ON).
   * See modules/roles for the parsed `RoleApprovalSettings` shape.
   */
  approval_json: string | null;
  /**
   * Skills activated on this role (docs/plan-skills-importables.md §3.2),
   * JSON-serialized. NULL = no active skill. Same convention as connectors_json;
   * added via applyMigrations only (like approval_json), not in the base schema.
   */
  skills_json: string | null;
  /**
   * Dead-worker reaper toggle (SQLite has no boolean; 0/1 INTEGER). When 1, the
   * in-process session reaper soft-deletes terminal workers of teams of this
   * role once they have been terminal for `auto_remove_dead_workers_delay_ms`.
   * Defaults to 0 (OFF) for every pre-existing row — added via applyMigrations
   * only, NOT NULL DEFAULT 0 so the column backfills on ALTER.
   */
  auto_remove_dead_workers: number;
  /**
   * Grace period (ms) a terminal worker is kept visible before the reaper hides
   * it. Only consulted when `auto_remove_dead_workers = 1`. NOT NULL DEFAULT
   * 600000 (10 min) — backfilled on ALTER for every pre-existing row.
   */
  auto_remove_dead_workers_delay_ms: number;
  /**
   * Cost budget (docs/monitoring-agents.md, Lot 14) — the ceiling in USD on the
   * CUMULATIVE spend of ONE team of this role, removed workers included. REAL
   * and nullable: NULL means "no budget at all", which is deliberately distinct
   * from `0` ("this role may not spend anything"). Migrations-only, like the
   * reaper columns above — no default, so every pre-existing role backfills to
   * NULL (= the state they are all legitimately in).
   */
  cost_budget_usd: number | null;
  /**
   * What the budget janitor does at the crossing: `notify` (event + Discord) or
   * `pause` (that, plus SIGSTOP on the whole team). NOT NULL DEFAULT 'notify'
   * so the column backfills on ADD COLUMN and a role that only sets an amount
   * gets the non-destructive action. Stored as free text and re-whitelisted on
   * read (see modules/roles) — an unknown value degrades to `notify`, never to
   * an unintended pause.
   */
  budget_action: string;
  /**
   * Auto-compact threshold (docs/auto-compact.md §3.3) — percent of the context
   * window past which the server arms a `/compact` on an idle agent of this
   * role. INTEGER and nullable WITH NO DEFAULT, same reasoning as
   * `cost_budget_usd` above: NULL means "inherit the instance default"
   * (`config.autoCompactPct`), which is a different instruction from `0`
   * ("never auto-compact this role"). A `DEFAULT 0` would silently opt every
   * pre-existing role OUT of the feature on upgrade — the exact opposite of
   * what shipping it means — and any other constant default would freeze
   * today's number into the schema. Every inherited row backfills to NULL,
   * i.e. to whatever the instance is configured for, at each boundary.
   */
  auto_compact_pct: number | null;
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
  /**
   * OpenRouter API key, IN CLEAR, as the `opencode` provider needs it at spawn
   * (multi-provider Lot 6b). This is the one row in the database that holds a
   * third-party credential, and the only legitimate reader is
   * `SettingsStore.getOpenRouterApiKey()`.
   *
   * `SettingsStore.get()` — what every route serves — masks it with the plugin
   * `PASSWORD_SENTINEL`, so the plaintext cannot reach a JSON response by
   * accident. Anything that reads this field directly is bypassing that.
   */
  openrouter_api_key: string | null;
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
  /** Adapter id this agent runs under. `'claude'` for legacy rows. */
  provider: string;
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
  /**
   * Monitoring (docs/monitoring-agents.md, Lot 1) — cumulative inbox messages
   * this agent drained, so the counter survives a restart. Optional in the
   * type and nullable in SQLite: rows written before the column existed read
   * NULL, and `upsertSession` fills the parameter in for row builders that
   * predate it. Migrations-only column (like `roles.approval_json`).
   */
  messages_processed?: number | null;
  /**
   * Monitoring (docs/monitoring-agents.md, Lot 11) — cumulative tokens billed
   * by this agent, one column per bucket, so the bill survives a restart (which
   * relaunches the CLI on a brand-new transcript and would otherwise reset it).
   *
   * Same convention as `messages_processed`, for the same reason: optional in
   * the type and nullable in SQLite, because NULL means "this row predates the
   * columns" and `0` means "measured, and it is zero". An ESTIMATED `costUsd`
   * is NOT stored — it is a view-time multiplication by a live rate card, and a
   * stored price would be a snapshot of what a model used to cost.
   */
  tokens_in?: number | null;
  tokens_out?: number | null;
  tokens_cache_read?: number | null;
  tokens_cache_write?: number | null;
  /**
   * Monitoring (Lot 13) — cumulative dollars the PROVIDER reported, which IS
   * stored, and is the exception that proves the rule above.
   *
   * An estimate is a function of data we keep (tokens) and data we can refetch
   * (the rate card), so storing it would only freeze it. A reported cost is a
   * measurement: opencode computed it from its own catalogue at the moment of
   * the request, and once that process is gone there is nothing left to derive
   * it from. Not storing it would mean losing it at every redeploy.
   */
  reported_cost_usd?: number | null;
}

/**
 * One `(team, provider, model)` bucket of the token bill
 * (docs/monitoring-agents.md, Lot 12) — hidden rows INCLUDED.
 *
 * WHY THE GROUPING IS NOT JUST `orchestrator_id`. A price is per model: a
 * mixed team (opus lead, sonnet workers, an opencode passthrough) has no single
 * rate card, so pricing a per-team token sum with one model's rates would be
 * wrong by whatever the mix is. Folding by `(team, provider, model)` in SQL
 * gives the route exactly what it needs to price each bucket with ITS OWN rates
 * and sum the dollars — arithmetically the same as pricing row by row, in one
 * query instead of one per team.
 *
 * Every counter is `number | null`, and `null` means "not one row in this
 * bucket carries counters" (a team that ran before Lot 11). It is never `0`:
 * see the statement's comment.
 */
export interface OrchestratorTokenSumRow {
  orchestrator_id: string;
  provider: string;
  model: string;
  in: number | null;
  out: number | null;
  cache_read: number | null;
  cache_write: number | null;
  /** Rows with `hidden_at IS NOT NULL` — killed, reaped, removed by hand. */
  removed_count: number;
  removed_in: number | null;
  removed_out: number | null;
  removed_cache_read: number | null;
  removed_cache_write: number | null;
  /** `1` when at least one row here predates the Lot 11 columns. Diagnostic. */
  has_null_counters: number;
  /** Same, restricted to the removed rows. Diagnostic. */
  removed_has_null: number;
}

/**
 * One session line of the Lot 12 drill-down — again, hidden rows INCLUDED.
 * A projection of `SessionRow`, not the whole row: this feeds a cost table, and
 * the prompt / cwd / log path of a dead worker have no business on that wire.
 */
export interface SessionCostRow {
  id: string;
  orchestrator_id: string;
  name: string;
  type: 'lead' | 'worker';
  status: SessionStatusRow;
  /** Non-null ⇒ the session left the team. THE marker of "removed". */
  hidden_at: string | null;
  model: string;
  provider: string;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
}

/**
 * Monitoring Lot 15 — one row of `session_token_daily`, exactly as the rollup
 * writes it.
 *
 * `tokens_*` / `cache_*` are the DAY'S DELTAS and `cum_*` the last cumulative
 * total observed for that session — see the table comment in `schema.sql` for
 * why both live on the same row. `cost_usd` is nullable and frozen at write
 * time: it is the only figure in this database whose whole value is that it
 * does NOT move when the rate card does.
 */
export interface SessionTokenDailyRow {
  day: string;
  session_id: string;
  orchestrator_id: string;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number | null;
  cum_in: number;
  cum_out: number;
  cum_cache_read: number;
  cum_cache_write: number;
}

/**
 * The bookkeeping half of the LAST row a session has, whatever day it is on.
 * The rollup subtracts it from the live cumulative to get a delta, so reading
 * "the latest row of this session" — not "today's row" — is what keeps the
 * arithmetic continuous across midnight and across a restart.
 */
export interface SessionTokenCumRow {
  session_id: string;
  day: string;
  cum_in: number;
  cum_out: number;
  cum_cache_read: number;
  cum_cache_write: number;
}

/**
 * One line of `GET /metrics/costs/export`. Snake_case, and NOT by accident: the
 * CSV header and the JSON keys are the same strings, so the two formats are one
 * dataset in two encodings rather than two shapes to keep in sync.
 *
 * `team` / `agent` are the human names, LEFT JOINed and `''` when the row they
 * name is gone — the ledger keeps the ids either way.
 */
export interface SessionTokenDailyExportRow {
  day: string;
  orchestrator_id: string;
  team: string;
  session_id: string;
  agent: string;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number | null;
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
  // Monitoring Lot 12 — team costs.
  private readonly sumTokensByOrchStmt;
  private readonly sessionCostRowsStmt;
  // Monitoring Lot 15 — daily roll-up, export, retention.
  private readonly upsertTokenDailyStmt;
  private readonly lastTokenCumsStmt;
  private readonly exportTokenDailyStmt;
  private readonly deleteOldTokenDailyStmt;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, 'swarm-os.db');
    this.db = new Database(dbPath);
    this.applySchema();
    this.applyMigrations();

    // Prepared statements — bound to `this` for use throughout the module.
    // ⚠️ Adding a column here means adding it in THREE places: the INSERT list,
    // the VALUES list, and the `ON CONFLICT DO UPDATE SET` list below. Miss the
    // third and the column is written once at creation and never updated again
    // — no error, no log, and the old value reappears after the next restart.
    this.upsertOrchStmt = this.db.prepare<OrchestratorRow>(`
      INSERT INTO orchestrators (
        id, name, role, role_id, status, lead_session_id, default_model, default_effort,
        default_permission_mode, default_provider, lead_preamble, worker_preamble, created_at,
        ended_at, hidden_at, last_error, stop_reason, last_resumed_at, resume_count
      ) VALUES (
        @id, @name, @role, @role_id, @status, @lead_session_id, @default_model, @default_effort,
        @default_permission_mode, @default_provider, @lead_preamble, @worker_preamble, @created_at,
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
        default_provider = excluded.default_provider,
        lead_preamble = excluded.lead_preamble,
        worker_preamble = excluded.worker_preamble,
        ended_at = excluded.ended_at,
        last_error = excluded.last_error,
        stop_reason = excluded.stop_reason,
        last_resumed_at = excluded.last_resumed_at,
        resume_count = excluded.resume_count
        -- hidden_at intentionally NOT overwritten: once hidden, stays hidden
    `);

    // Same three-place rule as the orchestrator UPSERT above.
    this.upsertSessionStmt = this.db.prepare<SessionRow>(`
      INSERT INTO sessions (
        id, orchestrator_id, name, role, type, cwd, initial_prompt, model,
        effort, permission_mode, provider, status, pid, started_at, ended_at, exit_code,
        last_error, stop_reason, log_path, last_activity_at, hidden_at,
        messages_processed,
        tokens_in, tokens_out, tokens_cache_read, tokens_cache_write,
        reported_cost_usd
      ) VALUES (
        @id, @orchestrator_id, @name, @role, @type, @cwd, @initial_prompt, @model,
        @effort, @permission_mode, @provider, @status, @pid, @started_at, @ended_at, @exit_code,
        @last_error, @stop_reason, @log_path, @last_activity_at, @hidden_at,
        @messages_processed,
        @tokens_in, @tokens_out, @tokens_cache_read, @tokens_cache_write,
        @reported_cost_usd
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
        provider = excluded.provider,
        status = excluded.status,
        pid = excluded.pid,
        ended_at = excluded.ended_at,
        exit_code = excluded.exit_code,
        last_error = excluded.last_error,
        stop_reason = excluded.stop_reason,
        log_path = excluded.log_path,
        last_activity_at = excluded.last_activity_at,
        messages_processed = excluded.messages_processed,
        tokens_in = excluded.tokens_in,
        tokens_out = excluded.tokens_out,
        tokens_cache_read = excluded.tokens_cache_read,
        tokens_cache_write = excluded.tokens_cache_write,
        reported_cost_usd = excluded.reported_cost_usd
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

    // --- Monitoring Lot 12 — the team bill -------------------------------
    //
    // NO `hidden_at IS NULL` FILTER, unlike every other SELECT above, and that
    // is the entire point of this statement: a killed or reaped worker is
    // soft-deleted, so its row — and the Lot 11 counters on it — survives, and
    // a team's true bill is the sum over the workers it HAD, not the ones it
    // still has. An in-memory sum over the live sessions can never produce this
    // number.
    //
    // `SUM` over an all-NULL group returns NULL, and that is load-bearing: it
    // is how "these rows predate the counters" reaches the route intact instead
    // of being laundered into a `0` the operator would read as "free".
    // `COALESCE(…, 0)` here would be a lie, so it is deliberately absent.
    this.sumTokensByOrchStmt = this.db.prepare<[], OrchestratorTokenSumRow>(`
      SELECT
        orchestrator_id,
        provider,
        model,
        SUM(tokens_in)          AS "in",
        SUM(tokens_out)         AS "out",
        SUM(tokens_cache_read)  AS cache_read,
        SUM(tokens_cache_write) AS cache_write,
        SUM(CASE WHEN hidden_at IS NOT NULL THEN 1 ELSE 0 END)      AS removed_count,
        SUM(CASE WHEN hidden_at IS NOT NULL THEN tokens_in END)          AS removed_in,
        SUM(CASE WHEN hidden_at IS NOT NULL THEN tokens_out END)         AS removed_out,
        SUM(CASE WHEN hidden_at IS NOT NULL THEN tokens_cache_read END)  AS removed_cache_read,
        SUM(CASE WHEN hidden_at IS NOT NULL THEN tokens_cache_write END) AS removed_cache_write,
        MAX(CASE
          WHEN tokens_in IS NULL AND tokens_out IS NULL
           AND tokens_cache_read IS NULL AND tokens_cache_write IS NULL
          THEN 1 ELSE 0 END) AS has_null_counters,
        MAX(CASE
          WHEN hidden_at IS NOT NULL
           AND tokens_in IS NULL AND tokens_out IS NULL
           AND tokens_cache_read IS NULL AND tokens_cache_write IS NULL
          THEN 1 ELSE 0 END) AS removed_has_null
      FROM sessions
      GROUP BY orchestrator_id, provider, model
    `);
    // Same "hidden rows included" rule, one team at a time, ungrouped: the
    // drill-down names the dead workers, so it needs the rows themselves.
    this.sessionCostRowsStmt = this.db.prepare<[string], SessionCostRow>(`
      SELECT
        id, orchestrator_id, name, type, status, hidden_at, model, provider,
        tokens_in, tokens_out, tokens_cache_read, tokens_cache_write
      FROM sessions
      WHERE orchestrator_id = ?
      ORDER BY started_at ASC
    `);

    // --- Monitoring Lot 15 — the daily ledger ----------------------------
    //
    // ONE statement does both "create today's row" and "add to it", because the
    // rollup ticks many times a day and must never turn an hourly cadence into
    // an hourly row. The deltas ACCUMULATE (`+ excluded`) while the bookkeeping
    // cumulatives are OVERWRITTEN (`= excluded`): the first is the day's total,
    // the second is a watermark.
    //
    // `cost_usd` has its own rule and it is the subtle one: NULL + amount =
    // amount, amount + NULL = amount. A tick that could not price its delta
    // (cold catalogue, unknown model) must not erase the dollars an earlier tick
    // established, and a day that starts unpriceable must be able to become
    // priced. Only a day where NOTHING was ever priceable stays NULL — which is
    // the honest "no measurement", never a `$0`.
    this.upsertTokenDailyStmt = this.db.prepare<SessionTokenDailyRow>(`
      INSERT INTO session_token_daily (
        day, session_id, orchestrator_id,
        tokens_in, tokens_out, cache_read, cache_write, cost_usd,
        cum_in, cum_out, cum_cache_read, cum_cache_write
      ) VALUES (
        @day, @session_id, @orchestrator_id,
        @tokens_in, @tokens_out, @cache_read, @cache_write, @cost_usd,
        @cum_in, @cum_out, @cum_cache_read, @cum_cache_write
      )
      ON CONFLICT(day, session_id) DO UPDATE SET
        orchestrator_id = excluded.orchestrator_id,
        tokens_in   = session_token_daily.tokens_in   + excluded.tokens_in,
        tokens_out  = session_token_daily.tokens_out  + excluded.tokens_out,
        cache_read  = session_token_daily.cache_read  + excluded.cache_read,
        cache_write = session_token_daily.cache_write + excluded.cache_write,
        cost_usd = CASE
          WHEN excluded.cost_usd IS NULL THEN session_token_daily.cost_usd
          ELSE COALESCE(session_token_daily.cost_usd, 0) + excluded.cost_usd
        END,
        cum_in         = excluded.cum_in,
        cum_out        = excluded.cum_out,
        cum_cache_read = excluded.cum_cache_read,
        cum_cache_write = excluded.cum_cache_write
    `);
    // The watermark of every session in ONE query — the rollup indexes it and
    // never asks per session, so a fleet of 200 agents costs one statement an
    // hour rather than 200.
    //
    // The bare `cum_*` columns alongside `MAX(day)` are NOT undefined behaviour
    // here: SQLite documents that when a query has exactly one `MAX()`/`MIN()`
    // aggregate, the bare columns are taken from the row that produced it. That
    // is precisely "the cumulative recorded on this session's most recent day".
    this.lastTokenCumsStmt = this.db.prepare<[], SessionTokenCumRow>(`
      SELECT
        session_id,
        MAX(day) AS day,
        cum_in, cum_out, cum_cache_read, cum_cache_write
      FROM session_token_daily
      GROUP BY session_id
    `);
    // The export. LEFT JOIN, not JOIN: a row whose team or agent has been
    // deleted keeps its spend and loses only its label (`''`) — an accounting
    // history that drops rows when the fleet churns is worse than useless.
    // Sorted day-then-team so a spreadsheet reads chronologically; `session_id`
    // breaks the tie so two exports of the same window are byte-identical.
    this.exportTokenDailyStmt = this.db.prepare<[string], SessionTokenDailyExportRow>(`
      SELECT
        d.day                   AS day,
        d.orchestrator_id       AS orchestrator_id,
        COALESCE(o.name, '')    AS team,
        d.session_id            AS session_id,
        COALESCE(s.name, '')    AS agent,
        d.tokens_in             AS tokens_in,
        d.tokens_out            AS tokens_out,
        d.cache_read            AS cache_read,
        d.cache_write           AS cache_write,
        d.cost_usd              AS cost_usd
      FROM session_token_daily d
      LEFT JOIN orchestrators o ON o.id = d.orchestrator_id
      LEFT JOIN sessions      s ON s.id = d.session_id
      WHERE d.day >= ?
      ORDER BY d.day ASC, team ASC, d.session_id ASC
    `);
    // Retention. `day` is `YYYY-MM-DD`, so a lexicographic `<` IS a
    // chronological one — no date parsing, and the index answers it.
    this.deleteOldTokenDailyStmt = this.db.prepare<[string]>(`
      DELETE FROM session_token_daily WHERE day < ?
    `);

    this.insertRoleStmt = this.db.prepare<RoleRow>(`
      INSERT INTO roles (
        id, label, lead_prompt, lead_preamble, worker_preamble, worker_count,
        default_model, default_effort, default_permission_mode, default_provider,
        connectors_json, schedule, schedule_message, approval_json, skills_json,
        auto_remove_dead_workers, auto_remove_dead_workers_delay_ms,
        cost_budget_usd, budget_action, auto_compact_pct,
        created_at, updated_at
      ) VALUES (
        @id, @label, @lead_prompt, @lead_preamble, @worker_preamble, @worker_count,
        @default_model, @default_effort, @default_permission_mode, @default_provider,
        @connectors_json, @schedule, @schedule_message, @approval_json, @skills_json,
        @auto_remove_dead_workers, @auto_remove_dead_workers_delay_ms,
        @cost_budget_usd, @budget_action, @auto_compact_pct,
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
        default_provider = @default_provider,
        connectors_json = @connectors_json,
        schedule = @schedule,
        schedule_message = @schedule_message,
        approval_json = @approval_json,
        skills_json = @skills_json,
        auto_remove_dead_workers = @auto_remove_dead_workers,
        auto_remove_dead_workers_delay_ms = @auto_remove_dead_workers_delay_ms,
        cost_budget_usd = @cost_budget_usd,
        budget_action = @budget_action,
        auto_compact_pct = @auto_compact_pct,
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
        dismissed_update_version, openrouter_api_key, updated_at
      ) VALUES (
        @id, @instance_label, @accent, @bg_tint, @font_size, @density, @dark_mode,
        @dismissed_update_version, @openrouter_api_key, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        instance_label = excluded.instance_label,
        accent = excluded.accent,
        bg_tint = excluded.bg_tint,
        font_size = excluded.font_size,
        density = excluded.density,
        dark_mode = excluded.dark_mode,
        dismissed_update_version = excluded.dismissed_update_version,
        -- A column missing from this list is written by the first INSERT and
        -- never updated again: the operator saves a key, it works, and it is
        -- silently gone after the next restart. settings/index.test.ts upserts
        -- twice on purpose to catch exactly that.
        openrouter_api_key = excluded.openrouter_api_key,
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
      // LEGACY per-role cadence — additive nullable columns, superseded by the
      // `crons` table (modules/crons). They MUST stay: they are the only path
      // that creates the columns in an image built from tsc output (INLINE_SCHEMA
      // no longer declares them), and the boot-time migration that converts a
      // legacy cadence into a cron SELECTs them. Both are forced to NULL by
      // RoleStore on every write, so nothing new ever lands in them.
      { table: 'roles', column: 'schedule',         ddl: 'ALTER TABLE roles ADD COLUMN schedule TEXT' },
      { table: 'roles', column: 'schedule_message', ddl: 'ALTER TABLE roles ADD COLUMN schedule_message TEXT' },
      // Update detection — the version the operator chose to ignore. Declared
      // in schema.sql AND in INLINE_SCHEMA AND here: the first two only ever
      // run on a FRESH database (CREATE TABLE IF NOT EXISTS skips an existing
      // table wholesale), so every already-deployed instance gets the column
      // exclusively through this ALTER.
      { table: 'instance_settings', column: 'dismissed_update_version', ddl: 'ALTER TABLE instance_settings ADD COLUMN dismissed_update_version TEXT' },
      // Multi-provider Lot 6b — OpenRouter credential for the `opencode`
      // provider. Nullable with no default: "no key configured" is the state
      // every existing instance is legitimately in, and the provider's probe
      // already reports it as a distinct, actionable reason.
      { table: 'instance_settings', column: 'openrouter_api_key', ddl: 'ALTER TABLE instance_settings ADD COLUMN openrouter_api_key TEXT' },
      // Multi-provider (plan Lot 2). SQLite backfills a CONSTANT default on
      // ADD COLUMN, so every pre-existing team/session row reads 'claude' —
      // which is exactly what they were. No catch-up UPDATE, and none needed.
      // `roles.default_provider` is nullable on purpose: NULL means "inherit",
      // same convention as `roles.default_model`.
      { table: 'orchestrators', column: 'default_provider', ddl: "ALTER TABLE orchestrators ADD COLUMN default_provider TEXT NOT NULL DEFAULT 'claude'" },
      { table: 'roles',         column: 'default_provider', ddl: 'ALTER TABLE roles ADD COLUMN default_provider TEXT' },
      { table: 'sessions',      column: 'provider',         ddl: "ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'" },
      // Approval gate (docs/garde-fous-approbation.md, P5) — OPTIONAL per-role
      // override of the human-in-the-loop guard, JSON-serialized to stay
      // future-proof (same convention as connectors_json). NULL = no override:
      // the role behaves EXACTLY as before (default `isPromptingMode` arming,
      // Discord notification ON). Every pre-existing role reads NULL.
      { table: 'roles',         column: 'approval_json',    ddl: 'ALTER TABLE roles ADD COLUMN approval_json TEXT' },
      // Skills library (docs/plan-skills-importables.md §3.2) — OPTIONAL
      // JSON-serialized list of skills activated on a role. NULL = none. Same
      // migrations-only convention as approval_json (not in the base schema).
      { table: 'roles',         column: 'skills_json',      ddl: 'ALTER TABLE roles ADD COLUMN skills_json TEXT' },
      // Dead-worker reaper (per-role auto-removal of terminal workers). Two
      // additive columns with CONSTANT NOT NULL defaults, so SQLite backfills
      // every pre-existing role to OFF / 10-min on ADD COLUMN — no catch-up
      // UPDATE needed. Migrations-only, like approval_json / skills_json above.
      // `0` = feature OFF (the state every existing role is legitimately in).
      { table: 'roles',         column: 'auto_remove_dead_workers',          ddl: 'ALTER TABLE roles ADD COLUMN auto_remove_dead_workers INTEGER NOT NULL DEFAULT 0' },
      { table: 'roles',         column: 'auto_remove_dead_workers_delay_ms',  ddl: 'ALTER TABLE roles ADD COLUMN auto_remove_dead_workers_delay_ms INTEGER NOT NULL DEFAULT 600000' },
      // Cost budgets (docs/monitoring-agents.md, Lot 14). Same additive,
      // migrations-only convention as the reaper pair above, with ONE
      // difference that matters: the amount is NULLABLE WITH NO DEFAULT.
      // "No budget" and "a budget of $0" are different instructions, and a
      // `DEFAULT 0` would silently arm every existing role at zero — i.e.
      // pause the whole fleet on the first tick after an upgrade. The ACTION
      // does carry a constant NOT NULL default, so a role that only sets an
      // amount gets the non-destructive outcome.
      { table: 'roles',         column: 'cost_budget_usd',                   ddl: 'ALTER TABLE roles ADD COLUMN cost_budget_usd REAL' },
      { table: 'roles',         column: 'budget_action',                     ddl: "ALTER TABLE roles ADD COLUMN budget_action TEXT NOT NULL DEFAULT 'notify'" },
      // Auto-compact threshold per role (docs/auto-compact.md D6/§3.3). Same
      // additive, migrations-only convention, and NULLABLE WITH NO DEFAULT for
      // the same reason as `cost_budget_usd`: NULL = "inherit the instance
      // default", which is NOT the same instruction as `0` = "never compact
      // this role". A constant default would either opt every existing role out
      // of a feature that ships ON, or freeze today's percentage into the
      // schema where an env var could no longer move it.
      { table: 'roles',         column: 'auto_compact_pct',                  ddl: 'ALTER TABLE roles ADD COLUMN auto_compact_pct INTEGER' },
      // Agent monitoring (docs/monitoring-agents.md, Lot 1) — cumulative count
      // of inbox messages each agent has drained. Nullable with no default:
      // NULL means "this row predates the counter", which is honestly
      // different from "this agent read nothing", and the view omits the
      // field rather than inventing a 0. Migrations-only, like the columns
      // above.
      { table: 'sessions',      column: 'messages_processed',                ddl: 'ALTER TABLE sessions ADD COLUMN messages_processed INTEGER' },
      // Agent monitoring (docs/monitoring-agents.md, Lot 11) — cumulative
      // tokens billed per agent, one column per bucket. Four columns rather
      // than one JSON blob: they are four integers that only ever get added to,
      // SQL can sum them across a team without parsing anything, and the schema
      // is the same one `docs/auto-amelioration.md` reserves in
      // `learning_episodes`. Nullable with no default, exactly like
      // `messages_processed`: NULL = "predates the columns", 0 = "measured".
      { table: 'sessions',      column: 'tokens_in',                         ddl: 'ALTER TABLE sessions ADD COLUMN tokens_in INTEGER' },
      { table: 'sessions',      column: 'tokens_out',                        ddl: 'ALTER TABLE sessions ADD COLUMN tokens_out INTEGER' },
      { table: 'sessions',      column: 'tokens_cache_read',                 ddl: 'ALTER TABLE sessions ADD COLUMN tokens_cache_read INTEGER' },
      { table: 'sessions',      column: 'tokens_cache_write',                ddl: 'ALTER TABLE sessions ADD COLUMN tokens_cache_write INTEGER' },
      // Agent monitoring (Lot 13) — dollars the PROVIDER itself billed, when it
      // publishes them (opencode does, per session and per message). REAL, not
      // INTEGER: a turn routinely costs $0.00008. The one price this schema
      // stores, and only because it is the one price we cannot recompute — the
      // tokens can always be re-priced from the catalogue, the figure opencode
      // quoted dies with its process. Same NULL/0 convention as above.
      { table: 'sessions',      column: 'reported_cost_usd',                 ddl: 'ALTER TABLE sessions ADD COLUMN reported_cost_usd REAL' },
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

  /**
   * ONE-SHOT: rewrite stored concrete claude ids to their family alias
   * (`claude-opus-4-8` → `opus`, `claude-sonnet-5` → `sonnet`,
   * `claude-opus-4-8[1m]` → `opus[1m]`) on teams and roles, so every NEW lead
   * and worker they spawn runs the newest release of that family
   * (docs/model-aliases.md, Lot 5). `sessions` are left alone: a resumed agent
   * keeps the model it ran on.
   *
   * Guarded by `PRAGMA user_version` (bit 0) rather than being idempotent on
   * its own: after it has run once, a concrete id an operator deliberately
   * pins in the UI must never be rewritten again on the next boot.
   *
   * Only rows whose EFFECTIVE provider is claude: a team's `default_provider`
   * is NOT NULL; a role's NULL means "the instance default", hence the
   * parameter. Returns the number of rows rewritten, or `null` if it had
   * already run.
   */
  migrateModelAliases(
    instanceDefaultProvider: string,
    familyOf: (model: string) => string | null,
  ): { orchestrators: number; roles: number } | null {
    const MODEL_ALIASES_BIT = 1;
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if ((version & MODEL_ALIASES_BIT) !== 0) return null;
    const rewrite = (table: 'orchestrators' | 'roles', where: string, params: unknown[]): number => {
      const rows = this.db
        .prepare(`SELECT id, default_model FROM ${table} WHERE default_model IS NOT NULL AND (${where})`)
        .all(...params) as Array<{ id: string; default_model: string }>;
      const update = this.db.prepare(`UPDATE ${table} SET default_model = ? WHERE id = ?`);
      let n = 0;
      for (const r of rows) {
        const alias = familyOf(r.default_model);
        if (alias !== null && alias !== r.default_model) {
          update.run(alias, r.id);
          n++;
        }
      }
      return n;
    };
    const run = this.db.transaction(() => {
      const orchestrators = rewrite('orchestrators', "default_provider = 'claude'", []);
      const roles = rewrite(
        'roles',
        "default_provider = 'claude' OR (default_provider IS NULL AND ? = 'claude')",
        [instanceDefaultProvider],
      );
      this.db.pragma(`user_version = ${version | MODEL_ALIASES_BIT}`);
      return { orchestrators, roles };
    });
    return run();
  }

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
      // The monitoring counters are optional on the row type (additive
      // columns), but better-sqlite3 requires every named parameter to be
      // present — normalize rather than force every caller to carry fields it
      // knows nothing about.
      this.upsertSessionStmt.run({
        ...row,
        messages_processed: row.messages_processed ?? null,
        tokens_in: row.tokens_in ?? null,
        tokens_out: row.tokens_out ?? null,
        tokens_cache_read: row.tokens_cache_read ?? null,
        tokens_cache_write: row.tokens_cache_write ?? null,
        reported_cost_usd: row.reported_cost_usd ?? null,
      });
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
   * Monitoring Lot 12 — the whole fleet's token bill in ONE query, folded by
   * `(team, provider, model)`, hidden rows included. Backs `GET /metrics/costs`,
   * which the monitoring page polls every 15 s while it is open.
   *
   * Fleet-wide rather than per-team on purpose: the page shows every team, and
   * a per-team method would be an N+1 on a 15 s timer.
   */
  sumTokenUsageByOrchestrator(): OrchestratorTokenSumRow[] {
    try {
      return this.sumTokensByOrchStmt.all();
    } catch (err) {
      log.warn({
        event: 'db.read_failed',
        op: 'sumTokenUsageByOrchestrator',
        error: String(err),
      });
      return [];
    }
  }

  /**
   * Monitoring Lot 12 — every session ever attached to one team, live and
   * removed, with the counters needed to price each of them. Backs
   * `GET /orchestrators/:id/cost` (fetched on demand, never polled).
   */
  sessionCostRowsForOrchestrator(orchId: string): SessionCostRow[] {
    try {
      return this.sessionCostRowsStmt.all(orchId);
    } catch (err) {
      log.warn({
        event: 'db.read_failed',
        op: 'sessionCostRowsForOrchestrator',
        orchId,
        error: String(err),
      });
      return [];
    }
  }

  /**
   * Monitoring Lot 15 — add one tick's DELTA to a session's row for `day`,
   * creating the row when the day turns. See the statement for the two
   * accumulation rules (deltas add, watermarks overwrite, `cost_usd` merges).
   *
   * Swallow-and-log like every other write: a failed roll-up costs the history
   * an hour, and the next tick recovers it in full — the delta is computed from
   * the watermark, not from the tick that failed.
   */
  upsertSessionTokenDaily(row: SessionTokenDailyRow): void {
    try {
      this.upsertTokenDailyStmt.run(row);
    } catch (err) {
      log.warn({
        event: 'db.write_failed',
        op: 'upsertSessionTokenDaily',
        sessionId: row.session_id,
        day: row.day,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Monitoring Lot 15 — the last cumulative recorded for EVERY session, one
   * query. The rollup's continuity across midnight and across restarts is
   * exactly this read: the watermark lives in the DB, not in the process.
   */
  lastSessionTokenCums(): SessionTokenCumRow[] {
    try {
      return this.lastTokenCumsStmt.all();
    } catch (err) {
      log.warn({ event: 'db.read_failed', op: 'lastSessionTokenCums', error: String(err) });
      return [];
    }
  }

  /**
   * Monitoring Lot 15 — the export window: every daily row on or after
   * `sinceDay` (`YYYY-MM-DD`), team and agent names joined in. Bounded by the
   * route's 90-day cap, which is what makes a plain array — rather than a
   * stream — the right answer here.
   */
  sessionTokenDailySince(sinceDay: string): SessionTokenDailyExportRow[] {
    try {
      return this.exportTokenDailyStmt.all(sinceDay);
    } catch (err) {
      log.warn({
        event: 'db.read_failed',
        op: 'sessionTokenDailySince',
        sinceDay,
        error: String(err),
      });
      return [];
    }
  }

  /**
   * Monitoring Lot 15 — retention: drop every daily row strictly before
   * `cutoffDay` (`YYYY-MM-DD`). Run once at boot, like `mailboxJanitor`.
   */
  deleteSessionTokenDailyBefore(cutoffDay: string): number {
    try {
      return this.deleteOldTokenDailyStmt.run(cutoffDay).changes;
    } catch (err) {
      log.warn({
        event: 'db.write_failed',
        op: 'deleteSessionTokenDailyBefore',
        cutoffDay,
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
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

  /**
   * Clear the per-role approval override on EVERY role (`approval_json = NULL`).
   * Backs `RoleStore.clearApprovalSettings()`, itself called by the `approvals`
   * feature descriptor's purge() (docs/builtin-features.md D7): uninstalling
   * approvals must not leave stale role overrides behind. Returns the number of
   * rows touched. Never throws (runs on the 24/7 purge path); prepared inline as
   * this is a rare admin op. Only `approval_json` is cleared — a role's budget
   * config (`cost_budget_usd`/`budget_action`) is out of scope (D7).
   */
  clearAllRoleApprovalSettings(): number {
    try {
      const res = this.db.prepare('UPDATE roles SET approval_json = NULL').run();
      return res.changes;
    } catch (err) {
      log.warn({
        event: 'db.write_failed',
        op: 'clearAllRoleApprovalSettings',
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
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
  default_provider TEXT NOT NULL DEFAULT 'claude',
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
  default_provider TEXT,
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
  provider TEXT NOT NULL DEFAULT 'claude',
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
  openrouter_api_key TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_token_daily (
  day TEXT NOT NULL,
  session_id TEXT NOT NULL,
  orchestrator_id TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  cum_in INTEGER NOT NULL DEFAULT 0,
  cum_out INTEGER NOT NULL DEFAULT 0,
  cum_cache_read INTEGER NOT NULL DEFAULT 0,
  cum_cache_write INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, session_id)
);
CREATE INDEX IF NOT EXISTS idx_session_token_daily_day ON session_token_daily(day);
`;

/**
 * UpdateStore — persistence for `update_runs`.
 *
 * ⚠️ WHY the DDL lives here and NOT in `db/schema.sql` — verified, not a
 * preference: `schema.sql` is not shipped in the Docker image (`tsc` does not
 * copy `.sql`, so `dist/modules/db/` holds only `index.js`), `SwarmDb` silently
 * falls back to its `INLINE_SCHEMA` copy, and `SwarmDb`'s writers swallow
 * failures into a `log.warn`. A table declared only in `schema.sql` would
 * therefore never exist in production, and every write to it would vanish
 * without a single error. `modules/plugins/store.ts:161` already sidesteps this
 * the same way; we follow it.
 *
 * ⚠️ WHY writes here THROW instead of warning: an `update_runs` row is the only
 * record of `env_line_before` — the byte-exact `.env` line a rollback restores.
 * "Best effort" persistence of a rollback token is a trap: the failure surfaces
 * hours later as an un-rollbackable deployment. Callers must decide, loudly.
 *
 * This package (Lot B) only creates and reads the table; the state machine that
 * drives it lands with the apply/schedule work (Lot D/E).
 */
import type { Database as Db } from 'better-sqlite3';
import { withModule } from '../../logger.js';
import type { SwarmDb } from '../db/index.js';

const log = withModule('updates.store');

/**
 * Run states, per the plan's §D.1 diagram. Kept as a union so the later
 * apply/schedule package can't invent a state the readers don't know.
 */
export type UpdateRunState =
  | 'scheduled'
  | 'warning_teams'
  | 'preflight'
  | 'applying'
  | 'verifying'
  | 'success'
  | 'rolled_back'
  | 'failed'
  | 'abandoned'
  | 'cancelled'
  | 'refused';

/** Nothing left to do or watch. Anything else means a run is in flight. */
export const TERMINAL_UPDATE_STATES: ReadonlySet<UpdateRunState> = new Set<UpdateRunState>([
  'success',
  'rolled_back',
  'failed',
  'abandoned',
  'cancelled',
  'refused',
]);

export type UpdateRunKind = 'system' | 'plugins';

/** Row shape of `update_runs` — column-for-column. */
export interface UpdateRunRow {
  /** `runId`; also the basename of the run directory (the correlation key). */
  id: string;
  kind: string;
  state: string;
  target_version: string | null;
  scheduled_for: string | null;
  warned_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  run_dir: string;
  env_file: string | null;
  /** Byte-exact `SWARM_OS_IMAGE=` line as found before the rewrite. */
  env_line_before: string | null;
  /** Teams alive BEFORE the update — the DB rows are `interrupted` by then. */
  teams_snapshot_json: string | null;
  /**
   * `[{orch_id, orch_name, lead_id, signalled, read, state}]`,
   * `state ∈ read | queued_unread | never_idle | no_lead | pending`.
   *
   * `pending` is the placeholder written when the window opens and means
   * "nothing observed about this lead yet" — in a `pending` row `signalled` and
   * `read` are floors, not observations. Every other value is an observation.
   */
  teams_warned_json: string | null;
  /**
   * §D.6 — which of those teams actually came back, written once after
   * auto-resume: `[{orch_id, orch_name, lead_id, back, lead_id_now, status,
   * reason}]`, `reason ∈ ok | absent | not_running | no_lead | lead_dead`.
   *
   * A column of its own, and it had to be: `teams_snapshot_json` still holds
   * the `ActiveTeam[]` that `UpdateRunView.teamsSnapshot` and the web package
   * read, and `error`/`log_tail` are overwritten by `applyResult` whenever a
   * run concludes after the boot that reconciled it.
   */
  teams_reconciled_json: string | null;
  error: string | null;
  log_tail: string | null;
}

/** Thrown when the table is missing at boot — see `assertReady`. */
export class UpdateStoreSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateStoreSchemaError';
  }
}

export class UpdateStore {
  private readonly db: Db;
  private readonly insertStmt;
  private readonly getStmt;
  private readonly listRecentStmt;
  private readonly listActiveStmt;

  constructor(swarmDb: SwarmDb) {
    this.db = swarmDb.db;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS update_runs (
        id TEXT PRIMARY KEY,            -- runId, = name of the run directory
        kind TEXT NOT NULL,             -- 'system' | 'plugins'
        state TEXT NOT NULL,
        target_version TEXT,
        scheduled_for TEXT, warned_at TEXT, started_at TEXT, finished_at TEXT,
        run_dir TEXT NOT NULL,
        env_file TEXT, env_line_before TEXT,   -- byte-exact rollback
        teams_snapshot_json TEXT,              -- teams alive BEFORE the update
        teams_warned_json TEXT,                -- [{orch_id, lead_id, signalled, read, state}]
        teams_reconciled_json TEXT,            -- [{orch_id, back, reason, …}] after resume
        error TEXT, log_tail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_update_runs_state ON update_runs(state);
    `);
    this.applyMigrations();

    this.insertStmt = this.db.prepare<UpdateRunRow>(`
      INSERT INTO update_runs (
        id, kind, state, target_version, scheduled_for, warned_at, started_at,
        finished_at, run_dir, env_file, env_line_before, teams_snapshot_json,
        teams_warned_json, teams_reconciled_json, error, log_tail
      ) VALUES (
        @id, @kind, @state, @target_version, @scheduled_for, @warned_at, @started_at,
        @finished_at, @run_dir, @env_file, @env_line_before, @teams_snapshot_json,
        @teams_warned_json, @teams_reconciled_json, @error, @log_tail
      )
    `);
    this.getStmt = this.db.prepare<[string], UpdateRunRow>('SELECT * FROM update_runs WHERE id = ?');
    this.listRecentStmt = this.db.prepare<[number], UpdateRunRow>(
      // `id` is time-ordered by construction (the runId carries an ISO stamp);
      // COALESCE keeps a still-scheduled run above older finished ones.
      'SELECT * FROM update_runs ORDER BY COALESCE(started_at, scheduled_for, id) DESC LIMIT ?',
    );
    this.listActiveStmt = this.db.prepare<[], UpdateRunRow>(
      `SELECT * FROM update_runs WHERE state NOT IN (${[...TERMINAL_UPDATE_STATES]
        .map((s) => `'${s}'`)
        .join(', ')}) ORDER BY COALESCE(started_at, scheduled_for, id) ASC`,
    );
  }

  /**
   * Idempotent column-additions, same shape as `SwarmDb.applyMigrations()`
   * (`modules/db/index.ts:464-489`) and for the same reason: `CREATE TABLE IF
   * NOT EXISTS` above skips an EXISTING table wholesale, so every instance that
   * already has `update_runs` can only get a new column through an `ALTER`.
   *
   * The duplicate-column error is the normal outcome from the second boot
   * onwards and is swallowed; anything else is logged and then caught for real
   * by `assertReady()`, which refuses to hand back a store whose columns are
   * not all there (an insert would otherwise fail hours later, on the one run
   * an operator was watching).
   */
  private applyMigrations(): void {
    const additions: Array<{ column: string; ddl: string }> = [
      // §D.6 — the post-update "which teams came back" record.
      {
        column: 'teams_reconciled_json',
        ddl: 'ALTER TABLE update_runs ADD COLUMN teams_reconciled_json TEXT',
      },
    ];
    for (const a of additions) {
      try {
        this.db.exec(a.ddl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/duplicate column name/i.test(msg)) {
          log.warn({ event: 'updates.store_migration_failed', column: a.column, error: msg });
        }
      }
    }
  }

  /**
   * Boot assertion: the table exists AND carries every column this build
   * writes. Cheap, and the only thing standing between a schema regression and
   * months of silently-dropped run rows (the exact failure mode `schema.sql`
   * produces — see the module header). The column check is what makes the
   * migration above *verified* rather than hoped for.
   */
  assertReady(): void {
    const row = this.db
      .prepare<[string], { name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get('update_runs');
    if (!row) {
      throw new UpdateStoreSchemaError(
        'update_runs table missing after UpdateStore construction — the DDL did not run',
      );
    }
    const present = new Set(
      (this.db.pragma('table_info(update_runs)') as Array<{ name?: unknown }>)
        .map((c) => c.name)
        .filter((n): n is string => typeof n === 'string'),
    );
    const missing = [...REQUIRED_COLUMNS].filter((c) => !present.has(c));
    if (missing.length > 0) {
      throw new UpdateStoreSchemaError(
        `update_runs is missing column(s) ${missing.join(', ')} — the ALTER TABLE migration did not run`,
      );
    }
  }

  /** Insert a fresh run. Throws on conflict or on any write failure. */
  insert(row: UpdateRunRow): void {
    this.insertStmt.run(row);
  }

  get(id: string): UpdateRunRow | null {
    return this.getStmt.get(id) ?? null;
  }

  listRecent(limit = 20): UpdateRunRow[] {
    return this.listRecentStmt.all(limit);
  }

  /** Runs in a non-terminal state — normally 0 or 1 (the apply path is exclusive). */
  listActive(): UpdateRunRow[] {
    return this.listActiveStmt.all();
  }

  /**
   * Partial update of an existing run. The SET clause is built from the patch's
   * OWN keys, each of which is validated against the column allow-list below —
   * so no caller-controlled string ever reaches the SQL text.
   */
  patch(id: string, fields: Partial<Omit<UpdateRunRow, 'id'>>): void {
    const keys = Object.keys(fields).filter((k): k is keyof Omit<UpdateRunRow, 'id'> =>
      PATCHABLE_COLUMNS.has(k),
    );
    if (keys.length === 0) return;
    const sql = `UPDATE update_runs SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run({ ...fields, id });
  }
}

/** Every column a `patch` may touch — `id` is the key and never moves. */
const PATCHABLE_COLUMNS: ReadonlySet<string> = new Set([
  'kind',
  'state',
  'target_version',
  'scheduled_for',
  'warned_at',
  'started_at',
  'finished_at',
  'run_dir',
  'env_file',
  'env_line_before',
  'teams_snapshot_json',
  'teams_warned_json',
  'teams_reconciled_json',
  'error',
  'log_tail',
]);

/**
 * Every column this build inserts, patches or reads. `assertReady()` checks
 * them all: a table that predates one of them takes its `ALTER` in
 * `applyMigrations()`, and if that never happened we want to know at boot, not
 * on the first `INSERT` of a run somebody is watching.
 */
const REQUIRED_COLUMNS: ReadonlySet<string> = new Set(['id', ...PATCHABLE_COLUMNS]);

/**
 * CronStore — the durable set of agent crons (docs/crons-agents.md §2.2).
 *
 * A cron is a FIRST-CLASS entity: N crons per role, each with its own cadence,
 * its own pause switch and its own bounded run history. It replaces the single
 * `roles.schedule` / `roles.schedule_message` pair, which could only ever
 * express one cadence per role and had no pause, no history and no manual fire
 * (§1). The target of a cron is a ROLE, not a session: sessions are ephemeral,
 * the role is the durable identity, and a tick fans out to the lead of every
 * live instance of that role — the semantics the per-role scheduler already had.
 *
 * ⚠️ Like `approvals/store.ts`, `memory/store.ts` and `taskboard/store.ts`, this
 * class OWNS its tables via `CREATE TABLE IF NOT EXISTS` on the raw `Database`
 * handle (`SwarmDb.db`). It deliberately touches NEITHER `schema.sql` NOR
 * `INLINE_SCHEMA`: `tsc` does not copy `.sql` files into the image, so the
 * inline fallback is the path that actually runs in prod — and it has ALREADY
 * diverged from `schema.sql` on the schedule columns. Keeping the DDL here
 * sidesteps the trap entirely.
 *
 * Robustness policy — deliberately split, unlike the uniformly-never-throwing
 * approvals store:
 *   - READS degrade (empty list / null + a warn). A broken read must not turn
 *     the crons screen into a 500; it turns it into an empty screen.
 *   - MUTATIONS throw `CronStoreError`. The route is the caller and it has to
 *     be able to tell the operator that their POST did not land — silently
 *     swallowing a failed create would be a lie.
 *   - `recordRun` NEVER throws: it runs inside a scheduler tick, where the only
 *     thing worse than losing a history row is taking the cadence down with it.
 *
 * The constructor also runs the one-shot LEGACY MIGRATION (see
 * `migrateLegacyRoleSchedules`), in its own try/catch: a migration failure
 * leaves the crons subsystem up rather than failing the boot.
 */

import * as crypto from 'node:crypto';
import type { Database as Db } from 'better-sqlite3';
import { withModule } from '../../logger.js';
import type { SwarmDb } from '../db/index.js';

const log = withModule('crons.store');

// --- DTO contract (shared with the HTTP layer / the web client) -------------

/**
 * What a tick does.
 *   - `message` — render the template and drop it in the lead's inbox (the
 *     behaviour the per-role scheduler had).
 *   - `script` — run a local script (`crons/runner.ts`) that decides whether
 *     waking the agent is worth an agent turn, and with what message.
 */
export type CronAction = 'message' | 'script';

export const CRON_ACTIONS: readonly CronAction[] = ['message', 'script'];

/** Why a run happened: the cadence fired, or an operator pressed RUN NOW. */
export type CronRunKind = 'tick' | 'manual';

export const CRON_RUN_KINDS: readonly CronRunKind[] = ['tick', 'manual'];

/**
 * How a run ended.
 *   - `wake`    — a message was delivered to at least one lead.
 *   - `skip`    — the script explicitly declined to wake anyone (`wake:false`).
 *   - `noop`    — nothing to deliver to: no live instance of the role (§6.1 —
 *                 v1 does NOT restart a stopped team).
 *   - `overlap` — the previous run of this cron was still in flight (§2.5). A
 *                 cron that is systematically slower than its cadence has to be
 *                 visible in LAST RUNS, so the skipped tick is recorded, not
 *                 silently dropped.
 *   - `error`   — delivery/execution failed. Never fatal to the scheduler.
 */
export type CronRunOutcome = 'wake' | 'skip' | 'noop' | 'overlap' | 'error';

/** Interpreters a script cron may declare. No `+x` fallback (§2.5). */
export const CRON_INTERPRETERS: readonly string[] = ['python3', 'bash', 'node'];

/** Default wall-clock budget of a script run. */
export const DEFAULT_CRON_TIMEOUT_MS = 60_000;

/**
 * Hard ceiling on a script run's timeout. Deliberately under Node's 300 s
 * `requestTimeout`: even though a manual fire answers 202 without waiting, an
 * operator reading the cap should never be able to configure a run that
 * outlives the process's own request budget.
 */
export const MAX_CRON_TIMEOUT_MS = 240_000;

/** How many runs are kept per cron. Older ones are deleted by `recordRun`. */
export const CRON_RUN_RETENTION = 20;

/** Cap on a persisted stdout/stderr excerpt (§2.2). */
export const CRON_EXCERPT_MAX_BYTES = 2000;

/**
 * Accepted cron names. The name is not decoration: it is what the delivery
 * primitive puts in `from = "cron:<name>"`, so it must be UNIQUE (enforced by
 * the table) and free of the characters that would make that prefix ambiguous
 * — no colon, no whitespace.
 */
export const CRON_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface CronRecord {
  id: string;
  /** Display slug, UNIQUE. Also the `cron:<name>` sender of its messages. */
  name: string;
  /** Target role. A deleted role leaves an ORPHAN cron (§6.2), not a cascade. */
  roleId: string;
  /** 5-field cron expression, evaluated in `SWARM_OS_SCHEDULE_TZ`. */
  schedule: string;
  action: CronAction;
  /** action=message: the template ({{fire}} / {{now}} / {{window:Nh|Nm}}). */
  message: string | null;
  /** action=script: absolute path under the workspace or data roots. */
  scriptPath: string | null;
  /** action=script: argv tail, persisted as a JSON array of strings. */
  scriptArgs: string[] | null;
  /** action=script: explicit interpreter, one of CRON_INTERPRETERS. */
  interpreter: string | null;
  /** action=script: per-run wall-clock budget. `null` = DEFAULT_CRON_TIMEOUT_MS. */
  timeoutMs: number | null;
  /** Paused crons stay in the list but are NOT armed (and have no next run). */
  paused: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CronRun {
  id: string;
  cronId: string;
  /** ISO-8601 of the fire time. */
  firedAt: string;
  kind: CronRunKind;
  outcome: CronRunOutcome;
  /** action=script only: the child's exit code. */
  exitCode: number | null;
  durationMs: number | null;
  /** Truncated stdout/stderr, or the reason of an `error` outcome. */
  outputExcerpt: string | null;
  /** Orchestrator ids the message reached. */
  deliveredTo: string[];
}

// --- Method input shapes ----------------------------------------------------

export interface CronInit {
  name: string;
  roleId: string;
  schedule: string;
  action: CronAction;
  message?: string | null;
  scriptPath?: string | null;
  scriptArgs?: string[] | null;
  interpreter?: string | null;
  timeoutMs?: number | null;
  paused?: boolean;
}

export type CronPatch = Partial<CronInit>;

export interface RecordRunInput {
  /**
   * Pre-allocated run id. Used by the SCRIPT path: a script run is journalled
   * only when its child exits, yet `POST /crons/:id/fire` must answer 202 with
   * the id the operator will find in `/crons/:id/runs` afterwards — so the
   * scheduler mints the id at launch and hands it here at settle time. Omitted
   * everywhere else, where the row is written synchronously.
   */
  id?: string;
  cronId: string;
  firedAt: Date | string;
  kind: CronRunKind;
  outcome: CronRunOutcome;
  exitCode?: number | null;
  durationMs?: number | null;
  outputExcerpt?: string | null;
  deliveredTo?: readonly string[];
}

/** Why a mutation was refused. Mapped to HTTP status codes by the route. */
export type CronErrorCode = 'INVALID' | 'NAME_TAKEN' | 'STORE_FAILED';

export class CronStoreError extends Error {
  constructor(
    readonly code: CronErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CronStoreError';
  }
}

// --- Internal row shapes ----------------------------------------------------

interface CronRow {
  id: string;
  name: string;
  role_id: string;
  schedule: string;
  action: string;
  message: string | null;
  script_path: string | null;
  script_args: string | null;
  interpreter: string | null;
  timeout_ms: number | null;
  paused: number;
  created_at: string;
  updated_at: string;
}

interface CronRunRow {
  id: string;
  cron_id: string;
  fired_at: string;
  kind: string;
  outcome: string;
  exit_code: number | null;
  duration_ms: number | null;
  output_excerpt: string | null;
  delivered_to: string | null;
}

/** Defensively parse a JSON array-of-strings column; anything else → `null`. */
function parseStringArray(json: string | null): string[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return null;
  }
}

function rowToCron(row: CronRow): CronRecord {
  return {
    id: row.id,
    name: row.name,
    roleId: row.role_id,
    schedule: row.schedule,
    // An unknown persisted action (hand-edited row, downgrade from a future
    // version) reads as `message`, the harmless one: the worst case is a
    // template delivered to a lead, never an unexpected local execution.
    action: row.action === 'script' ? 'script' : 'message',
    message: row.message,
    scriptPath: row.script_path,
    scriptArgs: parseStringArray(row.script_args),
    interpreter: row.interpreter,
    timeoutMs: typeof row.timeout_ms === 'number' ? row.timeout_ms : null,
    paused: row.paused === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cronToRow(c: CronRecord): CronRow {
  return {
    id: c.id,
    name: c.name,
    role_id: c.roleId,
    schedule: c.schedule,
    action: c.action,
    message: c.message,
    script_path: c.scriptPath,
    script_args: c.scriptArgs && c.scriptArgs.length > 0 ? JSON.stringify(c.scriptArgs) : null,
    interpreter: c.interpreter,
    timeout_ms: c.timeoutMs,
    paused: c.paused ? 1 : 0,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

function rowToRun(row: CronRunRow): CronRun {
  return {
    id: row.id,
    cronId: row.cron_id,
    firedAt: row.fired_at,
    kind: row.kind === 'manual' ? 'manual' : 'tick',
    outcome: (['wake', 'skip', 'noop', 'overlap', 'error'] as string[]).includes(row.outcome)
      ? (row.outcome as CronRunOutcome)
      : 'error',
    exitCode: typeof row.exit_code === 'number' ? row.exit_code : null,
    durationMs: typeof row.duration_ms === 'number' ? row.duration_ms : null,
    outputExcerpt: row.output_excerpt,
    deliveredTo: parseStringArray(row.delivered_to) ?? [],
  };
}

/**
 * Mint a run id. Exported because the script path needs one BEFORE the run
 * settles (see `RecordRunInput.id`) — the format has to stay in one place.
 */
export function newCronRunId(): string {
  return `run_${crypto.randomBytes(8).toString('hex')}`;
}

/** Truncate an excerpt to the documented byte budget (§2.2). */
export function clampExcerpt(v: string | null | undefined): string | null {
  if (v == null) return null;
  const s = String(v);
  if (Buffer.byteLength(s, 'utf8') <= CRON_EXCERPT_MAX_BYTES) return s;
  return Buffer.from(s, 'utf8').subarray(0, CRON_EXCERPT_MAX_BYTES).toString('utf8');
}

/**
 * Turn a free-form role label into the slug half of a migrated cron's name.
 * Empty / entirely non-alphanumeric labels fall back to `role`, so the result
 * always satisfies `CRON_NAME_RE`.
 */
export function slugifyForCronName(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug.length > 0 ? slug : 'role';
}

/**
 * Assert the §2.2 invariants on a complete record. Enforced by the store as
 * well as the route — the plugin façade and the migration write here too, and
 * a cron with `action='message'` and no message would tick forever delivering
 * nothing.
 */
function assertInvariants(c: CronRecord): void {
  if (!CRON_NAME_RE.test(c.name)) {
    throw new CronStoreError('INVALID', `invalid cron name '${c.name}'`);
  }
  if (!c.roleId) throw new CronStoreError('INVALID', 'roleId is required');
  if (!c.schedule || c.schedule.trim() === '') {
    throw new CronStoreError('INVALID', 'schedule is required');
  }
  if (c.action === 'message') {
    if (c.message == null) {
      throw new CronStoreError('INVALID', "message is required when action is 'message'");
    }
  } else {
    if (!c.scriptPath) {
      throw new CronStoreError('INVALID', "scriptPath is required when action is 'script'");
    }
    if (!c.interpreter) {
      throw new CronStoreError('INVALID', "interpreter is required when action is 'script'");
    }
  }
}

export class CronStore {
  private readonly db: Db;

  private readonly getStmt;
  private readonly getByNameStmt;
  private readonly listStmt;
  private readonly listByRoleStmt;
  private readonly countsByRoleStmt;
  private readonly insertStmt;
  private readonly updateStmt;
  private readonly deleteStmt;
  private readonly insertRunStmt;
  private readonly listRunsStmt;
  private readonly lastRunStmt;
  private readonly trimRunsStmt;

  constructor(swarmDb: SwarmDb) {
    this.db = swarmDb.db;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS crons (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL UNIQUE,
        role_id       TEXT NOT NULL,
        schedule      TEXT NOT NULL,
        action        TEXT NOT NULL,
        message       TEXT,
        script_path   TEXT,
        script_args   TEXT,
        interpreter   TEXT,
        timeout_ms    INTEGER,
        paused        INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_crons_role ON crons(role_id);

      CREATE TABLE IF NOT EXISTS cron_runs (
        id             TEXT PRIMARY KEY,
        cron_id        TEXT NOT NULL REFERENCES crons(id) ON DELETE CASCADE,
        fired_at       TEXT NOT NULL,
        kind           TEXT NOT NULL,
        outcome        TEXT NOT NULL,
        exit_code      INTEGER,
        duration_ms    INTEGER,
        output_excerpt TEXT,
        delivered_to   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cron_runs_cron ON cron_runs(cron_id, fired_at DESC);
    `);

    this.getStmt = this.db.prepare<[string], CronRow>('SELECT * FROM crons WHERE id = ?');
    this.getByNameStmt = this.db.prepare<[string], CronRow>('SELECT * FROM crons WHERE name = ?');
    // Creation order, with rowid breaking a same-timestamp tie deterministically
    // rather than the random id (same reasoning as approvals/store.ts).
    this.listStmt = this.db.prepare<[], CronRow>(
      'SELECT * FROM crons ORDER BY created_at ASC, rowid ASC',
    );
    this.listByRoleStmt = this.db.prepare<[string], CronRow>(
      'SELECT * FROM crons WHERE role_id = ? ORDER BY created_at ASC, rowid ASC',
    );
    this.countsByRoleStmt = this.db.prepare<[], { role_id: string; n: number }>(
      'SELECT role_id, COUNT(*) AS n FROM crons GROUP BY role_id',
    );
    this.insertStmt = this.db.prepare<CronRow>(`
      INSERT INTO crons (
        id, name, role_id, schedule, action, message, script_path, script_args,
        interpreter, timeout_ms, paused, created_at, updated_at
      ) VALUES (
        @id, @name, @role_id, @schedule, @action, @message, @script_path, @script_args,
        @interpreter, @timeout_ms, @paused, @created_at, @updated_at
      )
    `);
    this.updateStmt = this.db.prepare<CronRow>(`
      UPDATE crons SET
        name = @name, role_id = @role_id, schedule = @schedule, action = @action,
        message = @message, script_path = @script_path, script_args = @script_args,
        interpreter = @interpreter, timeout_ms = @timeout_ms, paused = @paused,
        updated_at = @updated_at
      WHERE id = @id
    `);
    this.deleteStmt = this.db.prepare<[string]>('DELETE FROM crons WHERE id = ?');
    this.insertRunStmt = this.db.prepare<CronRunRow>(`
      INSERT INTO cron_runs (
        id, cron_id, fired_at, kind, outcome, exit_code, duration_ms,
        output_excerpt, delivered_to
      ) VALUES (
        @id, @cron_id, @fired_at, @kind, @outcome, @exit_code, @duration_ms,
        @output_excerpt, @delivered_to
      )
    `);
    // Newest-first, rowid (insertion order) as the tie-break: two runs stamped
    // in the same millisecond must still read back in the order they happened.
    this.listRunsStmt = this.db.prepare<[string, number], CronRunRow>(
      'SELECT * FROM cron_runs WHERE cron_id = ? ORDER BY fired_at DESC, rowid DESC LIMIT ?',
    );
    this.lastRunStmt = this.db.prepare<[string], CronRunRow>(
      'SELECT * FROM cron_runs WHERE cron_id = ? ORDER BY fired_at DESC, rowid DESC LIMIT 1',
    );
    // Retention: keep the N newest runs of this cron, drop the rest. Expressed
    // as "not in the newest N" so it stays correct whatever the insert order.
    this.trimRunsStmt = this.db.prepare<[string, string, number]>(`
      DELETE FROM cron_runs
       WHERE cron_id = ?
         AND id NOT IN (
           SELECT id FROM cron_runs WHERE cron_id = ?
            ORDER BY fired_at DESC, rowid DESC LIMIT ?
         )
    `);

    this.migrateLegacyRoleSchedules();
  }

  // --- legacy migration -----------------------------------------------------

  /**
   * One-shot migration of the per-role cadence into the crons table (§Lot 1).
   *
   * For every role still carrying a `schedule`, insert a cron with a
   * DETERMINISTIC id (`cron_role_<roleId>`) and then clear the role columns —
   * both in ONE better-sqlite3 transaction. Two properties matter:
   *
   *  - the deterministic id + `INSERT OR IGNORE` makes the whole thing
   *    REPLAYABLE: a crash between the insert and the UPDATE leaves a cron that
   *    the next boot recognises instead of duplicating;
   *  - the clear is raw SQL, NOT `RoleStore.update`, so it does not bump the
   *    roles' `updated_at` — a migration is not an operator edit.
   *
   * Role labels are not unique, so the name (`<label>-cadence`) can collide;
   * the collision is resolved BEFORE the insert (suffix with the role id),
   * because `INSERT OR IGNORE` would otherwise silently drop the cron while the
   * UPDATE still erased its source — the one way this migration could lose data.
   *
   * Own try/catch: a failed migration disables nothing. The crons subsystem
   * stays up, and the legacy columns stay readable for a retry at the next boot.
   */
  private migrateLegacyRoleSchedules(): void {
    try {
      const legacy = this.db
        .prepare<[], { id: string; label: string; schedule: string; schedule_message: string | null }>(
          `SELECT id, label, schedule, schedule_message FROM roles
            WHERE schedule IS NOT NULL AND TRIM(schedule) <> ''`,
        )
        .all();
      if (legacy.length === 0) return;

      const now = new Date().toISOString();
      const migrated: Array<{ roleId: string; cronId: string; name: string }> = [];
      const run = this.db.transaction(() => {
        for (const role of legacy) {
          const id = `cron_role_${role.id}`;
          // Already migrated (replay after a crash): keep the existing row and
          // its operator edits; only the roles UPDATE below still has to run.
          if (this.getStmt.get(id)) continue;
          const name = this.freeName(slugifyForCronName(role.label), role.id);
          const record: CronRecord = {
            id,
            name,
            roleId: role.id,
            schedule: role.schedule.trim(),
            action: 'message',
            // The legacy route enforced "message required when schedule is
            // set", but the plugin façade did not — so an empty template is
            // possible, and is migrated as-is rather than dropped on the floor.
            message: role.schedule_message ?? '',
            scriptPath: null,
            scriptArgs: null,
            interpreter: null,
            timeoutMs: null,
            paused: false,
            createdAt: now,
            updatedAt: now,
          };
          this.insertStmt.run(cronToRow(record));
          migrated.push({ roleId: role.id, cronId: id, name });
        }
        // Raw SQL on purpose (see the doc comment): no `updated_at` bump.
        this.db
          .prepare('UPDATE roles SET schedule = NULL, schedule_message = NULL')
          .run();
      });
      run();

      log.info({
        event: 'crons.legacy_migrated',
        roles: legacy.length,
        created: migrated.length,
        crons: migrated,
      });
    } catch (err) {
      log.error({
        event: 'crons.legacy_migration_failed',
        error: err instanceof Error ? err.message : String(err),
        note: 'the per-role cadence columns were left untouched — the crons subsystem is up and the migration is retried at the next boot.',
      });
    }
  }

  /**
   * Find a free UNIQUE name for a migrated cron: `<slug>-cadence`, else
   * `<slug>-cadence-<roleId>`, else a counter. Reads through the open
   * transaction, so two roles sharing a label inside the same migration see
   * each other's freshly-inserted names.
   */
  private freeName(slug: string, roleId: string): string {
    const base = `${slug}-cadence`;
    if (!this.getByNameStmt.get(base)) return base;
    const withRole = `${base}-${roleId}`.slice(0, 64);
    if (!this.getByNameStmt.get(withRole)) return withRole;
    for (let i = 2; i < 1000; i += 1) {
      const candidate = `${base}-${i}`;
      if (!this.getByNameStmt.get(candidate)) return candidate;
    }
    // Unreachable in practice; a random suffix beats throwing in a migration.
    return `${base}-${crypto.randomBytes(4).toString('hex')}`;
  }

  // --- reads (degrade, never throw) ----------------------------------------

  list(): CronRecord[] {
    try {
      return this.listStmt.all().map(rowToCron);
    } catch (err) {
      log.warn({ event: 'crons.list_failed', error: String(err) });
      return [];
    }
  }

  listByRole(roleId: string): CronRecord[] {
    try {
      return this.listByRoleStmt.all(roleId).map(rowToCron);
    } catch (err) {
      log.warn({ event: 'crons.list_by_role_failed', roleId, error: String(err) });
      return [];
    }
  }

  /**
   * `roleId → number of crons`, computed by SQLite in one pass. Backs the
   * `cronCount` of `GET /roles` (§2.3), which is what lets the roles screen
   * show a badge without a second poll.
   */
  countsByRole(): Map<string, number> {
    const out = new Map<string, number>();
    try {
      for (const row of this.countsByRoleStmt.all()) out.set(row.role_id, row.n);
    } catch (err) {
      log.warn({ event: 'crons.counts_failed', error: String(err) });
    }
    return out;
  }

  get(id: string): CronRecord | null {
    try {
      const row = this.getStmt.get(id);
      return row ? rowToCron(row) : null;
    } catch (err) {
      log.warn({ event: 'crons.get_failed', id, error: String(err) });
      return null;
    }
  }

  getByName(name: string): CronRecord | null {
    try {
      const row = this.getByNameStmt.get(name);
      return row ? rowToCron(row) : null;
    } catch (err) {
      log.warn({ event: 'crons.get_by_name_failed', name, error: String(err) });
      return null;
    }
  }

  /** Newest-first run history, capped at `CRON_RUN_RETENTION` by construction. */
  listRuns(cronId: string, limit = CRON_RUN_RETENTION): CronRun[] {
    try {
      return this.listRunsStmt.all(cronId, Math.max(1, Math.min(limit, CRON_RUN_RETENTION))).map(rowToRun);
    } catch (err) {
      log.warn({ event: 'crons.list_runs_failed', cronId, error: String(err) });
      return [];
    }
  }

  lastRun(cronId: string): CronRun | null {
    try {
      const row = this.lastRunStmt.get(cronId);
      return row ? rowToRun(row) : null;
    } catch (err) {
      log.warn({ event: 'crons.last_run_failed', cronId, error: String(err) });
      return null;
    }
  }

  // --- mutations (throw CronStoreError) ------------------------------------

  create(init: CronInit): CronRecord {
    const now = new Date().toISOString();
    const record: CronRecord = {
      id: `cron_${crypto.randomBytes(4).toString('hex')}`,
      name: init.name,
      roleId: init.roleId,
      schedule: init.schedule,
      action: init.action,
      message: init.message ?? null,
      scriptPath: init.scriptPath ?? null,
      scriptArgs: init.scriptArgs ?? null,
      interpreter: init.interpreter ?? null,
      timeoutMs: init.timeoutMs ?? null,
      paused: init.paused ?? false,
      createdAt: now,
      updatedAt: now,
    };
    assertInvariants(record);
    this.write(() => this.insertStmt.run(cronToRow(record)), record.name);
    return record;
  }

  /** Partial edit. Returns `null` when the id is unknown (the route 404s). */
  update(id: string, patch: CronPatch): CronRecord | null {
    const existing = this.get(id);
    if (!existing) return null;
    const updated: CronRecord = {
      ...existing,
      name: patch.name ?? existing.name,
      roleId: patch.roleId ?? existing.roleId,
      schedule: patch.schedule ?? existing.schedule,
      action: patch.action ?? existing.action,
      // `null` is a MEANINGFUL patch value on every nullable field (clear the
      // script args, drop back to the default timeout), so each one goes
      // through `!== undefined` rather than `??`.
      message: patch.message !== undefined ? patch.message : existing.message,
      scriptPath: patch.scriptPath !== undefined ? patch.scriptPath : existing.scriptPath,
      scriptArgs: patch.scriptArgs !== undefined ? patch.scriptArgs : existing.scriptArgs,
      interpreter: patch.interpreter !== undefined ? patch.interpreter : existing.interpreter,
      timeoutMs: patch.timeoutMs !== undefined ? patch.timeoutMs : existing.timeoutMs,
      paused: patch.paused !== undefined ? patch.paused : existing.paused,
      updatedAt: new Date().toISOString(),
    };
    assertInvariants(updated);
    this.write(() => this.updateStmt.run(cronToRow(updated)), updated.name);
    return updated;
  }

  /** Deletes the cron and, by FK cascade, its run history. */
  delete(id: string): boolean {
    try {
      return this.deleteStmt.run(id).changes > 0;
    } catch (err) {
      throw new CronStoreError('STORE_FAILED', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Append a run and enforce retention, in ONE transaction. NEVER throws: this
   * is called from a scheduler tick and from the shutdown path, where losing a
   * history row is strictly better than taking the cadence (or the shutdown)
   * down with it.
   */
  recordRun(input: RecordRunInput): CronRun | null {
    try {
      const firedAt =
        input.firedAt instanceof Date ? input.firedAt.toISOString() : String(input.firedAt);
      const run: CronRun = {
        id: input.id ?? newCronRunId(),
        cronId: input.cronId,
        firedAt,
        kind: input.kind,
        outcome: input.outcome,
        exitCode: input.exitCode ?? null,
        durationMs: input.durationMs ?? null,
        outputExcerpt: clampExcerpt(input.outputExcerpt),
        deliveredTo: [...(input.deliveredTo ?? [])],
      };
      this.db.transaction(() => {
        this.insertRunStmt.run({
          id: run.id,
          cron_id: run.cronId,
          fired_at: run.firedAt,
          kind: run.kind,
          outcome: run.outcome,
          exit_code: run.exitCode,
          duration_ms: run.durationMs,
          output_excerpt: run.outputExcerpt,
          delivered_to: run.deliveredTo.length > 0 ? JSON.stringify(run.deliveredTo) : null,
        });
        this.trimRunsStmt.run(run.cronId, run.cronId, CRON_RUN_RETENTION);
      })();
      return run;
    } catch (err) {
      log.warn({ event: 'crons.record_run_failed', cronId: input.cronId, error: String(err) });
      return null;
    }
  }

  /**
   * Run a write, translating SQLite's UNIQUE violation on `name` into the
   * store's own `NAME_TAKEN` code — the route turns that into a 409 naming the
   * offending name, instead of a 500 with an opaque `SQLITE_CONSTRAINT` string.
   */
  private write(fn: () => void, name: string): void {
    try {
      fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/UNIQUE constraint failed: crons\.name/i.test(msg)) {
        throw new CronStoreError('NAME_TAKEN', `a cron named '${name}' already exists`);
      }
      throw new CronStoreError('STORE_FAILED', msg);
    }
  }
}

/**
 * TaskboardStore — the durable task board ("Kanban"), scoped PER TEAM
 * (per orchestrator). Unlike the shared memory (global to the deployment), a
 * board is the operational state of ONE mission: cards, assignees, a DAG of
 * dependencies and an append-only audit journal, all surviving `/clear`, a
 * crash and a resume (docs/tableau-de-taches.md §2/§4).
 *
 * ⚠️ Like `memory/store.ts`, `plugins/store.ts` and `updates/store.ts`, this
 * class OWNS its tables via `CREATE TABLE IF NOT EXISTS` on the raw `Database`
 * handle (`SwarmDb.db`). It deliberately touches NEITHER `schema.sql` NOR
 * `INLINE_SCHEMA`: the inline fallback is the path that runs in the Docker image
 * (tsc doesn't copy `.sql`), so a table declared only in `schema.sql` would
 * never exist in prod. Keeping the DDL here sidesteps the trap entirely.
 *
 * Robustness: read methods are wrapped in try/catch and log on failure — a
 * broken read NEVER crashes the 24/7 server. Mutations THROW on genuine errors
 * (not found, cycle, optimistic-lock conflict) so the MCP tool / REST layer can
 * answer a clean error instead of silently losing a write. Every mutation
 * inserts an append-only `taskboard_events` row IN THE SAME transaction and then
 * emits a `taskboard.*` event on the injected bus (docs §4/§8).
 */

import * as crypto from 'node:crypto';
import type { Database as Db } from 'better-sqlite3';
import { withModule } from '../../logger.js';
import type { SwarmDb } from '../db/index.js';
import type { SwarmEventBus, SwarmEventKind } from '../../events.js';

const log = withModule('taskboard.store');

// --- DTO contract (shared with the frontend — do NOT change without cause) ---

export type TaskboardStatus = 'todo' | 'doing' | 'blocked' | 'review' | 'done';

export const TASKBOARD_STATUSES: readonly TaskboardStatus[] = [
  'todo',
  'doing',
  'blocked',
  'review',
  'done',
];

/** Journal (audit) event kinds — the `kind` column of `taskboard_events`. */
export type TaskboardEventKind =
  | 'created'
  | 'updated'
  | 'moved'
  | 'assigned'
  | 'dep_added'
  | 'dep_removed'
  | 'comment'
  | 'closed'
  | 'reopened'
  | 'deleted'
  | 'orphaned';

export interface TaskboardCard {
  id: string;
  orchestratorId: string;
  title: string;
  body: string;
  status: TaskboardStatus;
  /** Session id of the assignee (soft-ref), or `null` when unassigned. */
  assigneeSessionId: string | null;
  priority: number;
  labels: string[];
  orderKey: string;
  createdBy: string;
  /** Epoch millis. */
  createdAt: number;
  /** Epoch millis. */
  updatedAt: number;
  version: number;
  /** Epoch millis, or `null` when open. */
  closedAt: number | null;
  /** Epoch millis when the assignee vanished (crash-resume), or `null`. */
  orphanedAt: number | null;
  /** True when the card was auto-created at worker spawn (Phase 3). */
  autoCreated: boolean;
  /** Epoch millis when soft-deleted, or `null`. */
  hiddenAt: number | null;
  /**
   * Lot 16 — dollars attributed to this card, or `null` when the question has
   * no honest answer: nothing was ever measured, the assignee changed while the
   * card was in `doing`, or the session has no cost counters. NEVER a doubtful
   * figure — the web renders nothing at all for `null` (docs/monitoring-agents.md
   * "Lot 16"). Additive: a `doing → review → doing → done` round trip SUMS its
   * spells, it does not keep only the last one.
   */
  costUsd: number | null;
}

export interface TaskboardEvent {
  id: string;
  cardId: string;
  orchestratorId: string;
  actorSessionId: string | null;
  kind: TaskboardEventKind;
  data: Record<string, unknown> | null;
  ts: number;
}

export interface TaskboardCardDetail extends TaskboardCard {
  /** Cards THIS card depends on (must finish first). */
  dependsOn: string[];
  /** Cards that depend on THIS card. */
  blocks: string[];
  /** Tail of the append-only audit journal (oldest → newest). */
  events: TaskboardEvent[];
}

// --- Errors -----------------------------------------------------------------

export class TaskboardError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'TaskboardError';
  }
}

/** Optimistic-lock failure — thrown (never swallowed) so callers return 409. */
export class TaskboardConflictError extends TaskboardError {
  constructor(
    public readonly currentVersion: number,
    public readonly expectedVersion: number,
  ) {
    super(
      `version conflict: expected ${expectedVersion} but current is ${currentVersion}`,
      'VERSION_CONFLICT',
    );
    this.name = 'TaskboardConflictError';
  }
}

// --- Internal row shapes ----------------------------------------------------

interface CardRow {
  id: string;
  orchestrator_id: string;
  title: string;
  body: string;
  status: string;
  assignee_session_id: string | null;
  priority: number;
  labels: string | null;
  order_key: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  version: number;
  closed_at: number | null;
  orphaned_at: number | null;
  auto_created: number;
  hidden_at: number | null;
  /** Lot 16 — settled dollars for this card (see `TaskboardCard.costUsd`). */
  cost_usd: number | null;
  /**
   * Lot 16 bookkeeping — the assignee's CUMULATIVE cost at the instant the card
   * entered `doing`, or `null` when nothing is in flight. Never leaves the row:
   * it is a subtrahend, not a fact about the card.
   */
  cost_start_usd: number | null;
  /**
   * Lot 16 bookkeeping — the session id `cost_start_usd` was snapshotted from.
   * The delta is only banked if THIS same session is still the assignee on the
   * way out of `doing`; anything else and the spell is dropped, unattributed.
   */
  cost_assignee_session: string | null;
}

/**
 * The columns the card INSERT/UPDATE statements bind. The two Lot 16
 * bookkeeping columns are deliberately absent: they are written apart (
 * `setCostBookStmt`, same transaction) by the three status transitions that own
 * them, so every OTHER mutation preserves them without having to know they
 * exist — and so they never reach `TaskboardCard`, which is the frontend's DTO.
 */
type CardWriteRow = Omit<CardRow, 'cost_start_usd' | 'cost_assignee_session'>;

/** What one status transition does to a card's cost columns. */
interface CardCostPatch {
  costUsd: number | null;
  costStartUsd: number | null;
  costAssigneeSession: string | null;
}

/**
 * Lot 16 — how the board turns a card's `assignee` into live money. Injected
 * (never imported): the store must keep knowing nothing about the orchestrator
 * module, and it is wired only at boot, AFTER the spawner exists.
 *
 * Resolves an assignee — which may be a session id OR an agent name — inside
 * its own team, and answers the session's CUMULATIVE cost in USD.
 * `null` when the team is gone, the assignee resolves to nothing, or a name is
 * ambiguous. `costUsd: null` when the session has no priced counters. Both mean
 * the same thing to the caller: no snapshot, no attribution.
 */
export type TaskboardCostLookup = (
  orchestratorId: string,
  assignee: string,
) => { sessionId: string; costUsd: number | null } | null;

interface EventRow {
  id: string;
  card_id: string;
  orchestrator_id: string;
  actor_session_id: string | null;
  kind: string;
  data: string | null;
  ts: number;
}

interface TeamRow {
  orchestratorId: string;
  total: number;
  open: number;
}

/** One entry of the web board's team selector (docs §7 — read-only web). */
export interface TaskboardTeam {
  orchestratorId: string;
  /** Non-hidden cards on this team's board. */
  total: number;
  /** Of those, the ones that are not closed. */
  open: number;
}

// --- id / order-key helpers -------------------------------------------------

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_ID_LEN = 200;
const MAX_TITLE_LEN = 2000;
/** How many trailing journal events `getCard` returns by default. */
const JOURNAL_TAIL = 50;

/**
 * Fractional-index midpoint: return a string that sorts STRICTLY between `prev`
 * and `next` lexicographically (façon LexoRank), so a card can be re-ordered in
 * its column without rewriting its neighbours. `prev===''` is the lower bound
 * (before everything), `next===''` the upper bound (after everything). Requires
 * `prev < next` when both are non-empty. Alphabet is 'a'..'z'.
 *
 * This is the well-known canonical algorithm (char codes 96='a'-1, 123='z'+1).
 */
export function orderKeyBetween(prev: string, next: string): string {
  const a = prev ?? '';
  const b = next ?? '';
  let p = 0;
  let n = 0;
  let pos = 0;
  // Find the leftmost position where the two bounds differ.
  do {
    p = pos < a.length ? a.charCodeAt(pos) : 96;
    n = pos < b.length && b.length > 0 ? b.charCodeAt(pos) : 123;
    pos++;
  } while (p === n);
  let str = a.slice(0, pos - 1);
  if (p === 96) {
    // `prev` is a prefix of `next` (or empty): borrow leading 'a'/'b' from next.
    while (n === 97) {
      n = pos < b.length ? b.charCodeAt(pos++) : 123;
      str += 'a';
    }
    if (n === 98) {
      str += 'a';
      n = 123;
    }
  } else if (p + 1 === n) {
    // Consecutive characters: keep prev's char and extend past its 'z' tail.
    str += String.fromCharCode(p);
    n = 123;
    while ((p = pos < a.length ? a.charCodeAt(pos++) : 96) === 122) {
      str += 'z';
    }
  }
  return str + String.fromCharCode(Math.ceil((p + n) / 2));
}

function safeParseLabels(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function safeParseData(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// --- Method input shapes ----------------------------------------------------

export interface CreateCardInput {
  orchestratorId: string;
  title: string;
  body?: string;
  status?: string;
  assignee?: string | null;
  priority?: number;
  labels?: string[];
  /** Provenance — the session id (or 'web') that created the card. */
  createdBy: string;
  /** Optional initial dependencies (card ids this card depends on). */
  dependsOn?: string[];
  /** Marks the card as auto-created at worker spawn (Phase 3). */
  autoCreated?: boolean;
}

export interface UpdateCardInput {
  id: string;
  expectedVersion: number;
  actorSessionId: string | null;
  title?: string;
  body?: string;
  priority?: number;
  labels?: string[];
}

export interface ListCardsFilter {
  orchestratorId: string;
  status?: string;
  assignee?: string;
  /** Include soft-deleted (hidden) cards. Default false. */
  includeHidden?: boolean;
}

export class TaskboardStore {
  private readonly db: Db;
  private readonly eventBus: SwarmEventBus | null;

  private readonly getCardStmt;
  private readonly insertCardStmt;
  private readonly updateCardStmt;
  private readonly listByOrchStmt;
  private readonly maxOrderKeyStmt;
  private readonly insertEventStmt;
  private readonly tailEventsStmt;
  private readonly dependsOnStmt;
  private readonly blocksStmt;
  private readonly insertDepStmt;
  private readonly deleteDepStmt;
  private readonly hasDepStmt;
  private readonly listOrphanedStmt;
  private readonly listTeamsStmt;
  private readonly expiredOrphansStmt;
  private readonly setCostBookStmt;

  /** Lot 16 — see `setCostLookup`. `null` ⇒ no card is ever priced. */
  private costLookup: TaskboardCostLookup | null;

  constructor(
    swarmDb: SwarmDb,
    opts: { eventBus?: SwarmEventBus; costLookup?: TaskboardCostLookup } = {},
  ) {
    this.db = swarmDb.db;
    this.eventBus = opts.eventBus ?? null;
    this.costLookup = opts.costLookup ?? null;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS taskboard_cards (
        id                  TEXT PRIMARY KEY,
        orchestrator_id     TEXT NOT NULL,
        title               TEXT NOT NULL,
        body                TEXT NOT NULL DEFAULT '',
        status              TEXT NOT NULL DEFAULT 'todo',
        assignee_session_id TEXT,
        priority            INTEGER NOT NULL DEFAULT 0,
        labels              TEXT,
        order_key           TEXT NOT NULL,
        created_by          TEXT NOT NULL,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        version             INTEGER NOT NULL DEFAULT 1,
        closed_at           INTEGER,
        orphaned_at         INTEGER,
        auto_created        INTEGER NOT NULL DEFAULT 0,
        hidden_at           INTEGER,
        cost_usd              REAL,
        cost_start_usd        REAL,
        cost_assignee_session TEXT,
        FOREIGN KEY (orchestrator_id) REFERENCES orchestrators(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_tb_cards_orch_status ON taskboard_cards(orchestrator_id, status);
      CREATE INDEX IF NOT EXISTS idx_tb_cards_assignee    ON taskboard_cards(assignee_session_id);

      CREATE TABLE IF NOT EXISTS taskboard_deps (
        card_id       TEXT NOT NULL,
        depends_on_id TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        PRIMARY KEY (card_id, depends_on_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tb_deps_depends_on ON taskboard_deps(depends_on_id);

      CREATE TABLE IF NOT EXISTS taskboard_events (
        id                TEXT PRIMARY KEY,
        card_id           TEXT NOT NULL,
        orchestrator_id   TEXT NOT NULL,
        actor_session_id  TEXT,
        kind              TEXT NOT NULL,
        data              TEXT,
        ts                INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tb_events_card ON taskboard_events(card_id, ts);
    `);
    // Idempotent additive migrations for instances whose `taskboard_cards`
    // predates a column (CREATE TABLE IF NOT EXISTS skips an existing table
    // wholesale — same pattern as SwarmDb.applyMigrations / MemoryStore).
    this.applyMigrations();

    this.getCardStmt = this.db.prepare<[string], CardRow>(
      'SELECT * FROM taskboard_cards WHERE id = ?',
    );
    this.insertCardStmt = this.db.prepare<CardWriteRow>(`
      INSERT INTO taskboard_cards (
        id, orchestrator_id, title, body, status, assignee_session_id, priority, labels,
        order_key, created_by, created_at, updated_at, version, closed_at, orphaned_at,
        auto_created, hidden_at, cost_usd
      ) VALUES (
        @id, @orchestrator_id, @title, @body, @status, @assignee_session_id, @priority, @labels,
        @order_key, @created_by, @created_at, @updated_at, @version, @closed_at, @orphaned_at,
        @auto_created, @hidden_at, @cost_usd
      )
    `);
    this.updateCardStmt = this.db.prepare<CardWriteRow>(`
      UPDATE taskboard_cards SET
        title = @title, body = @body, status = @status,
        assignee_session_id = @assignee_session_id, priority = @priority, labels = @labels,
        order_key = @order_key, updated_at = @updated_at, version = @version,
        closed_at = @closed_at, orphaned_at = @orphaned_at, hidden_at = @hidden_at,
        cost_usd = @cost_usd
      WHERE id = @id
    `);
    // Lot 16 bookkeeping, written apart from the card itself (see CardWriteRow):
    // only the three status transitions touch it, always inside their own
    // transaction, so no other mutation can clobber an in-flight snapshot.
    this.setCostBookStmt = this.db.prepare<[number | null, string | null, string]>(
      'UPDATE taskboard_cards SET cost_start_usd = ?, cost_assignee_session = ? WHERE id = ?',
    );
    this.listByOrchStmt = this.db.prepare<[string], CardRow>(
      'SELECT * FROM taskboard_cards WHERE orchestrator_id = ? ORDER BY order_key ASC',
    );
    this.maxOrderKeyStmt = this.db.prepare<[string, string], { order_key: string }>(
      'SELECT order_key FROM taskboard_cards WHERE orchestrator_id = ? AND status = ? ORDER BY order_key DESC LIMIT 1',
    );
    this.insertEventStmt = this.db.prepare<EventRow>(`
      INSERT INTO taskboard_events (id, card_id, orchestrator_id, actor_session_id, kind, data, ts)
      VALUES (@id, @card_id, @orchestrator_id, @actor_session_id, @kind, @data, @ts)
    `);
    this.tailEventsStmt = this.db.prepare<[string, number], EventRow>(
      'SELECT * FROM taskboard_events WHERE card_id = ? ORDER BY ts DESC, id DESC LIMIT ?',
    );
    this.dependsOnStmt = this.db.prepare<[string], { depends_on_id: string }>(
      'SELECT depends_on_id FROM taskboard_deps WHERE card_id = ? ORDER BY depends_on_id ASC',
    );
    this.blocksStmt = this.db.prepare<[string], { card_id: string }>(
      'SELECT card_id FROM taskboard_deps WHERE depends_on_id = ? ORDER BY card_id ASC',
    );
    this.insertDepStmt = this.db.prepare<[string, string, number]>(
      'INSERT OR IGNORE INTO taskboard_deps (card_id, depends_on_id, created_at) VALUES (?, ?, ?)',
    );
    this.deleteDepStmt = this.db.prepare<[string, string]>(
      'DELETE FROM taskboard_deps WHERE card_id = ? AND depends_on_id = ?',
    );
    this.hasDepStmt = this.db.prepare<[string, string], { n: number }>(
      'SELECT COUNT(*) AS n FROM taskboard_deps WHERE card_id = ? AND depends_on_id = ?',
    );
    this.listOrphanedStmt = this.db.prepare<[string], CardRow>(
      'SELECT * FROM taskboard_cards WHERE orchestrator_id = ? AND orphaned_at IS NOT NULL AND hidden_at IS NULL ORDER BY orphaned_at ASC',
    );
    // Teams (orchestrators) that own at least one non-hidden card — powers the
    // web board's team selector. `open` excludes closed cards (Phase 3 REST).
    this.listTeamsStmt = this.db.prepare<[], TeamRow>(`
      SELECT orchestrator_id AS orchestratorId,
             COUNT(*) AS total,
             SUM(CASE WHEN closed_at IS NULL THEN 1 ELSE 0 END) AS open
      FROM taskboard_cards
      WHERE hidden_at IS NULL
      GROUP BY orchestrator_id
      ORDER BY orchestrator_id ASC
    `);
    // Orphaned, still-visible cards whose `orphaned_at` predates a cutoff — the
    // Phase 3 TTL janitor soft-deletes each via `deleteCard`.
    this.expiredOrphansStmt = this.db.prepare<[number], { id: string }>(
      'SELECT id FROM taskboard_cards WHERE orphaned_at IS NOT NULL AND orphaned_at < ? AND hidden_at IS NULL ORDER BY orphaned_at ASC',
    );
  }

  // --- migrations -----------------------------------------------------------

  /**
   * Additive, idempotent column adds. The `orphaned_at` and `auto_created`
   * columns already ship in the CREATE TABLE above, so on a fresh DB these
   * ALTERs are no-ops that raise "duplicate column name" and are swallowed —
   * they exist only to upgrade an instance created by an earlier build of this
   * store. Never throws (a migration hiccup must not crash the 24/7 server).
   */
  private applyMigrations(): void {
    const additions = [
      'ALTER TABLE taskboard_cards ADD COLUMN orphaned_at INTEGER',
      'ALTER TABLE taskboard_cards ADD COLUMN auto_created INTEGER NOT NULL DEFAULT 0',
      // Lot 16 — cost per card. NULL-able with no default on purpose: NULL is
      // "never attributed", which is a different statement from `0`.
      'ALTER TABLE taskboard_cards ADD COLUMN cost_usd REAL',
      'ALTER TABLE taskboard_cards ADD COLUMN cost_start_usd REAL',
      'ALTER TABLE taskboard_cards ADD COLUMN cost_assignee_session TEXT',
    ];
    for (const ddl of additions) {
      try {
        this.db.exec(ddl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/duplicate column name/i.test(msg)) {
          log.warn({ event: 'taskboard.migration_failed', ddl, error: msg });
        }
      }
    }
  }

  // --- cost per card (Lot 16) ----------------------------------------------

  /**
   * Late wiring: this store is built at boot BEFORE the spawner exists, so the
   * lookup cannot be a constructor dependency in the real server (mirror of
   * `SkillsSubsystem.setOrchestratorLookup`). Until it is set — and on any
   * deployment that never sets it — every card simply stays unpriced.
   */
  setCostLookup(lookup: TaskboardCostLookup | null): void {
    this.costLookup = lookup;
  }

  /**
   * Resolve a card's assignee to its session id + cumulative dollars. Never
   * throws and never guesses: a lookup that blows up, an unknown assignee or an
   * ambiguous name all answer `null`, which costs a snapshot and nothing else.
   */
  private resolveAssigneeCost(
    orchestratorId: string,
    assignee: string | null,
  ): { sessionId: string; costUsd: number | null } | null {
    if (!assignee || !this.costLookup) return null;
    try {
      const hit = this.costLookup(orchestratorId, assignee);
      if (!hit || typeof hit.sessionId !== 'string' || hit.sessionId.length === 0) return null;
      const costUsd =
        typeof hit.costUsd === 'number' && Number.isFinite(hit.costUsd) ? hit.costUsd : null;
      return { sessionId: hit.sessionId, costUsd };
    } catch (err) {
      log.warn({ event: 'taskboard.cost_lookup_failed', orchestratorId, error: String(err) });
      return null;
    }
  }

  /**
   * THE one place the per-card dollar rule lives. Given a card's row as it
   * stands BEFORE a status write and the status it is about to take, answer the
   * cost columns to write — or `null` when this transition has nothing to do
   * with the accounting (neither end is `doing`), so the caller writes nothing.
   *
   * Entering `doing` snapshots the assignee's running total; leaving it banks
   * `now − start`, clamped at 0 (a session whose counters reset must not credit
   * the card a negative bill) and ADDED to what the card already owes, so a
   * `doing → review → doing → done` round trip sums its spells.
   *
   * The delta is banked ONLY if the very session it was snapshotted from is
   * still the assignee and still has a priced total. Otherwise the spell is
   * dropped and `cost_usd` is left exactly as it was — `null` if it never held
   * a figure. Attribution is honest or it is absent; it is never approximate.
   */
  private costTransition(row: CardRow, to: TaskboardStatus): CardCostPatch | null {
    const from = this.normalizeStatus(row.status);
    if (from === to) return null;

    if (to === 'doing') {
      const resolved = this.resolveAssigneeCost(row.orchestrator_id, row.assignee_session_id);
      // No session, no counters ⇒ no snapshot: with no start there can be no
      // delta later, which is the point.
      if (!resolved || resolved.costUsd == null) {
        return { costUsd: row.cost_usd, costStartUsd: null, costAssigneeSession: null };
      }
      return {
        costUsd: row.cost_usd,
        costStartUsd: resolved.costUsd,
        costAssigneeSession: resolved.sessionId,
      };
    }

    if (from === 'doing') {
      let costUsd = row.cost_usd;
      if (row.cost_start_usd != null && row.cost_assignee_session != null) {
        const resolved = this.resolveAssigneeCost(row.orchestrator_id, row.assignee_session_id);
        if (
          resolved &&
          resolved.sessionId === row.cost_assignee_session &&
          resolved.costUsd != null
        ) {
          costUsd = (row.cost_usd ?? 0) + Math.max(0, resolved.costUsd - row.cost_start_usd);
        }
      }
      return { costUsd, costStartUsd: null, costAssigneeSession: null };
    }

    return null;
  }

  // --- helpers --------------------------------------------------------------

  private assertValidId(id: string, what = 'id'): void {
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LEN || !ID_RE.test(id)) {
      throw new TaskboardError(`invalid ${what}: '${id}'`, 'INVALID_ID');
    }
  }

  private normalizeStatus(status: string | undefined, fallback: TaskboardStatus = 'todo'): TaskboardStatus {
    return (TASKBOARD_STATUSES as readonly string[]).includes(status ?? '')
      ? (status as TaskboardStatus)
      : fallback;
  }

  private rowToCard(row: CardRow): TaskboardCard {
    return {
      id: row.id,
      orchestratorId: row.orchestrator_id,
      title: row.title,
      body: row.body,
      status: this.normalizeStatus(row.status),
      assigneeSessionId: row.assignee_session_id,
      priority: row.priority,
      labels: safeParseLabels(row.labels),
      orderKey: row.order_key,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version,
      closedAt: row.closed_at,
      orphanedAt: row.orphaned_at,
      autoCreated: row.auto_created !== 0,
      hiddenAt: row.hidden_at,
      // Lot 16 — straight through, `null` included: an absent figure is a
      // statement ("never attributed"), not a zero to be papered over.
      costUsd: row.cost_usd,
    };
  }

  private rowToEvent(row: EventRow): TaskboardEvent {
    return {
      id: row.id,
      cardId: row.card_id,
      orchestratorId: row.orchestrator_id,
      actorSessionId: row.actor_session_id,
      kind: row.kind as TaskboardEventKind,
      data: safeParseData(row.data),
      ts: row.ts,
    };
  }

  /** Row → the full `@`-named object the INSERT/UPDATE prepared statements need. */
  private cardToRow(c: TaskboardCard): CardWriteRow {
    return {
      id: c.id,
      orchestrator_id: c.orchestratorId,
      title: c.title,
      body: c.body,
      status: c.status,
      assignee_session_id: c.assigneeSessionId,
      priority: c.priority,
      labels: JSON.stringify(c.labels ?? []),
      order_key: c.orderKey,
      created_by: c.createdBy,
      created_at: c.createdAt,
      updated_at: c.updatedAt,
      version: c.version,
      closed_at: c.closedAt,
      orphaned_at: c.orphanedAt,
      auto_created: c.autoCreated ? 1 : 0,
      hidden_at: c.hiddenAt,
      cost_usd: c.costUsd,
    };
  }

  /** Build an append-only journal row (not yet inserted). */
  private makeEvent(
    card: { id: string; orchestratorId: string },
    kind: TaskboardEventKind,
    actorSessionId: string | null,
    data: Record<string, unknown> | null,
  ): EventRow {
    return {
      id: crypto.randomUUID(),
      card_id: card.id,
      orchestrator_id: card.orchestratorId,
      actor_session_id: actorSessionId,
      kind,
      data: data ? JSON.stringify(data) : null,
      ts: Date.now(),
    };
  }

  /** Map a journal kind to its `taskboard.*` bus event kind. */
  private busKindFor(kind: TaskboardEventKind): SwarmEventKind {
    switch (kind) {
      case 'created':
        return 'taskboard.card_created';
      case 'moved':
        return 'taskboard.card_moved';
      case 'assigned':
        return 'taskboard.card_assigned';
      case 'comment':
        return 'taskboard.comment_added';
      case 'dep_added':
      case 'dep_removed':
        return 'taskboard.dep_changed';
      case 'closed':
        return 'taskboard.card_closed';
      case 'reopened':
        return 'taskboard.card_reopened';
      case 'deleted':
        return 'taskboard.card_deleted';
      case 'orphaned':
        return 'taskboard.card_orphaned';
      case 'updated':
      default:
        return 'taskboard.card_updated';
    }
  }

  private emit(
    kind: TaskboardEventKind,
    card: { id: string; orchestratorId: string },
    extra: Record<string, unknown> = {},
  ): void {
    try {
      this.eventBus?.emitEvent({
        kind: this.busKindFor(kind),
        orchestratorId: card.orchestratorId,
        payload: { cardId: card.id, orchestratorId: card.orchestratorId, ...extra },
      });
    } catch (err) {
      log.warn({ event: 'taskboard.emit_failed', kind, error: String(err) });
    }
  }

  /** Fetch a card row or throw NOT_FOUND. */
  private requireCard(id: string): CardRow {
    this.assertValidId(id, 'card id');
    const row = this.getCardStmt.get(id);
    if (!row) throw new TaskboardError(`card not found: ${id}`, 'NOT_FOUND');
    return row;
  }

  /** Append-key for the end of a (orchestrator, status) column. */
  private appendKey(orchestratorId: string, status: TaskboardStatus): string {
    const max = this.maxOrderKeyStmt.get(orchestratorId, status);
    return orderKeyBetween(max?.order_key ?? '', '');
  }

  // --- reads ----------------------------------------------------------------

  /** One card + its dependencies + the tail of its audit journal. `null` if absent. */
  getCard(id: string, journalTail = JOURNAL_TAIL): TaskboardCardDetail | null {
    try {
      const row = this.getCardStmt.get(id);
      if (!row) return null;
      const dependsOn = this.dependsOnStmt.all(id).map((r) => r.depends_on_id);
      const blocks = this.blocksStmt.all(id).map((r) => r.card_id);
      const tail = Math.max(1, Math.min(500, Math.floor(journalTail) || JOURNAL_TAIL));
      // Journal is fetched newest-first then reversed so callers read oldest → newest.
      const events = this.tailEventsStmt
        .all(id, tail)
        .map((e) => this.rowToEvent(e))
        .reverse();
      return { ...this.rowToCard(row), dependsOn, blocks, events };
    } catch (err) {
      log.warn({ event: 'taskboard.get_failed', id, error: String(err) });
      return null;
    }
  }

  /** Cards of one team, optionally filtered by status / assignee. Excludes hidden. */
  listCards(filter: ListCardsFilter): TaskboardCard[] {
    try {
      this.assertValidId(filter.orchestratorId, 'orchestrator id');
      const rows = this.listByOrchStmt.all(filter.orchestratorId);
      return rows
        .filter((r) => (filter.includeHidden ? true : r.hidden_at == null))
        .filter((r) => (filter.status ? r.status === filter.status : true))
        .filter((r) => (filter.assignee ? r.assignee_session_id === filter.assignee : true))
        .map((r) => this.rowToCard(r));
    } catch (err) {
      log.warn({ event: 'taskboard.list_failed', error: String(err) });
      return [];
    }
  }

  /** Orphaned (assignee-vanished) cards of one team — used by the Phase 3 janitor. */
  listOrphaned(orchestratorId: string): TaskboardCard[] {
    try {
      this.assertValidId(orchestratorId, 'orchestrator id');
      return this.listOrphanedStmt.all(orchestratorId).map((r) => this.rowToCard(r));
    } catch (err) {
      log.warn({ event: 'taskboard.list_orphaned_failed', error: String(err) });
      return [];
    }
  }

  /**
   * Orchestrators that own at least one non-hidden card, with card counts.
   * Backs the read-only web board's team selector (Phase 3 REST). Never throws.
   */
  listTeams(): TaskboardTeam[] {
    try {
      return this.listTeamsStmt.all().map((r) => ({
        orchestratorId: r.orchestratorId,
        total: r.total,
        open: r.open,
      }));
    } catch (err) {
      log.warn({ event: 'taskboard.list_teams_failed', error: String(err) });
      return [];
    }
  }

  // --- mutations ------------------------------------------------------------

  /** Create a card, append its `created` journal entry, wire initial deps. */
  createCard(input: CreateCardInput): TaskboardCard {
    this.assertValidId(input.orchestratorId, 'orchestrator id');
    if (typeof input.title !== 'string' || input.title.trim().length === 0) {
      throw new TaskboardError('title is required', 'INVALID_TITLE');
    }
    if (input.title.length > MAX_TITLE_LEN) {
      throw new TaskboardError(`title too long (max ${MAX_TITLE_LEN})`, 'INVALID_TITLE');
    }
    const status = this.normalizeStatus(input.status);
    const now = Date.now();
    const card: TaskboardCard = {
      id: crypto.randomUUID(),
      orchestratorId: input.orchestratorId,
      title: input.title,
      body: input.body ?? '',
      status,
      assigneeSessionId: input.assignee ?? null,
      priority: Number.isFinite(input.priority) ? Math.trunc(input.priority as number) : 0,
      labels: input.labels ?? [],
      orderKey: this.appendKey(input.orchestratorId, status),
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      version: 1,
      closedAt: null,
      orphanedAt: null,
      autoCreated: input.autoCreated ?? false,
      hiddenAt: null,
      // Lot 16 — a brand-new card has cost nothing yet. Note that a card
      // CREATED straight into `doing` takes no snapshot: creation is not a
      // transition, and v1 keeps the rule to the one place transitions happen.
      // Such a card simply stays unpriced until its next real move.
      costUsd: null,
    };

    const deps = (input.dependsOn ?? []).filter((d) => d && d !== card.id);
    // Validate dependency targets exist & belong to the same team BEFORE writing.
    for (const dep of deps) {
      this.assertValidId(dep, 'dependsOn id');
      const target = this.getCardStmt.get(dep);
      if (!target || target.orchestrator_id !== card.orchestratorId) {
        throw new TaskboardError(`dependency target not on this board: ${dep}`, 'INVALID_DEP');
      }
    }

    this.db.transaction(() => {
      this.insertCardStmt.run(this.cardToRow(card));
      for (const dep of deps) this.insertDepStmt.run(card.id, dep, now);
      this.insertEventStmt.run(
        this.makeEvent(card, 'created', input.createdBy || null, {
          title: card.title,
          status: card.status,
          ...(card.assigneeSessionId ? { assignee: card.assigneeSessionId } : {}),
          ...(deps.length ? { dependsOn: deps } : {}),
        }),
      );
    })();

    this.emit('created', card, { status: card.status });
    return card;
  }

  /** Edit title/body/priority/labels under an optimistic lock. */
  updateCard(input: UpdateCardInput): TaskboardCard {
    const row = this.requireCard(input.id);
    if (input.expectedVersion !== row.version) {
      throw new TaskboardConflictError(row.version, input.expectedVersion);
    }
    if (input.title != null && (input.title.trim().length === 0 || input.title.length > MAX_TITLE_LEN)) {
      throw new TaskboardError('invalid title', 'INVALID_TITLE');
    }
    const now = Date.now();
    const next: TaskboardCard = {
      ...this.rowToCard(row),
      ...(input.title != null ? { title: input.title } : {}),
      ...(input.body != null ? { body: input.body } : {}),
      ...(input.priority != null ? { priority: Math.trunc(input.priority) } : {}),
      ...(input.labels != null ? { labels: input.labels } : {}),
      updatedAt: now,
      version: row.version + 1,
    };
    const changed: string[] = [];
    if (input.title != null) changed.push('title');
    if (input.body != null) changed.push('body');
    if (input.priority != null) changed.push('priority');
    if (input.labels != null) changed.push('labels');

    this.db.transaction(() => {
      this.updateCardStmt.run(this.cardToRow(next));
      this.insertEventStmt.run(this.makeEvent(next, 'updated', input.actorSessionId, { changed }));
    })();

    this.emit('updated', next, { changed });
    return next;
  }

  /**
   * Move a card to another column (the key Kanban action). Recomputes the
   * `order_key` to append at the end of the destination column and bumps
   * `version`. `expectedVersion` is optional — pass it to guard against a
   * concurrent edit.
   */
  moveCard(input: {
    id: string;
    status: string;
    expectedVersion?: number;
    actorSessionId: string | null;
  }): TaskboardCard {
    const row = this.requireCard(input.id);
    if (input.expectedVersion != null && input.expectedVersion !== row.version) {
      throw new TaskboardConflictError(row.version, input.expectedVersion);
    }
    if (!(TASKBOARD_STATUSES as readonly string[]).includes(input.status)) {
      throw new TaskboardError(
        `invalid status '${input.status}' (one of ${TASKBOARD_STATUSES.join('|')})`,
        'INVALID_STATUS',
      );
    }
    const status = input.status as TaskboardStatus;
    const from = this.normalizeStatus(row.status);
    const now = Date.now();
    const cost = this.costTransition(row, status);
    const next: TaskboardCard = {
      ...this.rowToCard(row),
      status,
      orderKey: this.appendKey(row.orchestrator_id, status),
      updatedAt: now,
      version: row.version + 1,
      ...(cost ? { costUsd: cost.costUsd } : {}),
    };

    this.db.transaction(() => {
      this.updateCardStmt.run(this.cardToRow(next));
      if (cost) this.setCostBookStmt.run(cost.costStartUsd, cost.costAssigneeSession, next.id);
      this.insertEventStmt.run(this.makeEvent(next, 'moved', input.actorSessionId, { from, to: status }));
    })();

    this.emit('moved', next, { from, to: status });
    return next;
  }

  /** (Re)assign a card. `assignee=null` unassigns. Clears the orphaned flag. */
  assignCard(input: { id: string; assignee: string | null; actorSessionId: string | null }): TaskboardCard {
    const row = this.requireCard(input.id);
    if (input.assignee != null) this.assertValidId(input.assignee, 'assignee');
    const now = Date.now();
    const from = row.assignee_session_id;
    const next: TaskboardCard = {
      ...this.rowToCard(row),
      assigneeSessionId: input.assignee ?? null,
      // A fresh assignment resolves the "assignee vanished" flag.
      orphanedAt: null,
      updatedAt: now,
      version: row.version + 1,
    };

    this.db.transaction(() => {
      this.updateCardStmt.run(this.cardToRow(next));
      this.insertEventStmt.run(
        this.makeEvent(next, 'assigned', input.actorSessionId, {
          from: from ?? null,
          assignee: input.assignee ?? null,
        }),
      );
    })();

    this.emit('assigned', next, { from: from ?? null, assignee: input.assignee ?? null });
    return next;
  }

  /** Append a comment to the audit journal. Does NOT bump `version` (append-only). */
  comment(input: { id: string; text: string; actorSessionId: string | null }): TaskboardEvent {
    const row = this.requireCard(input.id);
    if (typeof input.text !== 'string' || input.text.trim().length === 0) {
      throw new TaskboardError('comment text is required', 'INVALID_COMMENT');
    }
    const card = { id: row.id, orchestratorId: row.orchestrator_id };
    const ev = this.makeEvent(card, 'comment', input.actorSessionId, { text: input.text });
    const now = ev.ts;
    this.db.transaction(() => {
      this.insertEventStmt.run(ev);
      // Touch updated_at so the board reflects activity, but leave version alone
      // so an in-flight optimistic edit is not spuriously invalidated.
      this.db
        .prepare('UPDATE taskboard_cards SET updated_at = ? WHERE id = ?')
        .run(now, row.id);
    })();
    this.emit('comment', card, { text: input.text });
    return this.rowToEvent(ev);
  }

  /**
   * Add a dependency edge `cardId` → `dependsOnId` (cardId is blocked by
   * dependsOnId). Cycle-guarded: refuses an edge that would close a cycle in the
   * dependency DAG. Both cards must exist on the SAME board.
   */
  addDep(input: { cardId: string; dependsOnId: string; actorSessionId: string | null }): void {
    const { cardId, dependsOnId } = input;
    this.assertValidId(cardId, 'card id');
    this.assertValidId(dependsOnId, 'dependsOn id');
    if (cardId === dependsOnId) {
      throw new TaskboardError('a card cannot depend on itself', 'INVALID_DEP');
    }
    const card = this.requireCard(cardId);
    const target = this.getCardStmt.get(dependsOnId);
    if (!target) throw new TaskboardError(`dependency target not found: ${dependsOnId}`, 'NOT_FOUND');
    if (target.orchestrator_id !== card.orchestrator_id) {
      throw new TaskboardError('dependency target is on another board', 'INVALID_DEP');
    }
    // Cycle guard: adding cardId → dependsOnId closes a cycle iff dependsOnId
    // can ALREADY reach cardId by following depends_on edges. DFS from dependsOnId.
    if (this.dependsOnReaches(dependsOnId, cardId)) {
      throw new TaskboardError(
        `refusing dependency: ${cardId} → ${dependsOnId} would create a cycle`,
        'CYCLE',
      );
    }
    if (this.hasDepStmt.get(cardId, dependsOnId)!.n > 0) return; // idempotent no-op
    const now = Date.now();
    const ref = { id: cardId, orchestratorId: card.orchestrator_id };
    this.db.transaction(() => {
      this.insertDepStmt.run(cardId, dependsOnId, now);
      this.insertEventStmt.run(this.makeEvent(ref, 'dep_added', input.actorSessionId, { dependsOn: dependsOnId }));
    })();
    this.emit('dep_added', ref, { dependsOn: dependsOnId });
  }

  /** Remove a dependency edge `cardId` → `dependsOnId`. */
  removeDep(input: { cardId: string; dependsOnId: string; actorSessionId: string | null }): void {
    const { cardId, dependsOnId } = input;
    const card = this.requireCard(cardId);
    this.assertValidId(dependsOnId, 'dependsOn id');
    const ref = { id: cardId, orchestratorId: card.orchestrator_id };
    this.db.transaction(() => {
      this.deleteDepStmt.run(cardId, dependsOnId);
      this.insertEventStmt.run(this.makeEvent(ref, 'dep_removed', input.actorSessionId, { dependsOn: dependsOnId }));
    })();
    this.emit('dep_removed', ref, { dependsOn: dependsOnId });
  }

  /** True if `from` can reach `to` by following depends_on edges (DFS). */
  private dependsOnReaches(from: string, to: string): boolean {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === to) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const r of this.dependsOnStmt.all(cur)) stack.push(r.depends_on_id);
    }
    return false;
  }

  /** Close a card: stamp `closed_at`, move it to `done`, bump `version`. */
  closeCard(input: { id: string; expectedVersion?: number; actorSessionId: string | null }): TaskboardCard {
    const row = this.requireCard(input.id);
    if (input.expectedVersion != null && input.expectedVersion !== row.version) {
      throw new TaskboardConflictError(row.version, input.expectedVersion);
    }
    const now = Date.now();
    // `board.close` is a `doing → done` exit like any other — the accounting
    // does not care which tool got the card there.
    const cost = this.costTransition(row, 'done');
    const next: TaskboardCard = {
      ...this.rowToCard(row),
      status: 'done',
      closedAt: now,
      orderKey: this.appendKey(row.orchestrator_id, 'done'),
      updatedAt: now,
      version: row.version + 1,
      ...(cost ? { costUsd: cost.costUsd } : {}),
    };
    this.db.transaction(() => {
      this.updateCardStmt.run(this.cardToRow(next));
      if (cost) this.setCostBookStmt.run(cost.costStartUsd, cost.costAssigneeSession, next.id);
      this.insertEventStmt.run(this.makeEvent(next, 'closed', input.actorSessionId, {}));
    })();
    this.emit('closed', next, {});
    return next;
  }

  /** Reopen a closed card: clear `closed_at`, move it back to `todo`. */
  reopenCard(input: { id: string; expectedVersion?: number; actorSessionId: string | null }): TaskboardCard {
    const row = this.requireCard(input.id);
    if (input.expectedVersion != null && input.expectedVersion !== row.version) {
      throw new TaskboardConflictError(row.version, input.expectedVersion);
    }
    const now = Date.now();
    // A reopen out of `doing` (rare, but reachable) settles the spell exactly
    // like any other exit rather than silently dropping it on the floor.
    const cost = this.costTransition(row, 'todo');
    const next: TaskboardCard = {
      ...this.rowToCard(row),
      status: 'todo',
      closedAt: null,
      orderKey: this.appendKey(row.orchestrator_id, 'todo'),
      updatedAt: now,
      version: row.version + 1,
      ...(cost ? { costUsd: cost.costUsd } : {}),
    };
    this.db.transaction(() => {
      this.updateCardStmt.run(this.cardToRow(next));
      if (cost) this.setCostBookStmt.run(cost.costStartUsd, cost.costAssigneeSession, next.id);
      this.insertEventStmt.run(this.makeEvent(next, 'reopened', input.actorSessionId, {}));
    })();
    this.emit('reopened', next, {});
    return next;
  }

  /** Soft-delete a card (`hidden_at`). Idempotent; returns false if already hidden. */
  deleteCard(input: { id: string; actorSessionId: string | null }): boolean {
    const row = this.requireCard(input.id);
    if (row.hidden_at != null) return false;
    const now = Date.now();
    const next: TaskboardCard = {
      ...this.rowToCard(row),
      hiddenAt: now,
      updatedAt: now,
      version: row.version + 1,
    };
    this.db.transaction(() => {
      this.updateCardStmt.run(this.cardToRow(next));
      this.insertEventStmt.run(this.makeEvent(next, 'deleted', input.actorSessionId, {}));
    })();
    this.emit('deleted', next, {});
    return true;
  }

  /**
   * Flag a card whose assignee session no longer exists (Phase 3 crash-resume
   * pass). Stamps `orphaned_at` (idempotent) and audits it. Returns false if the
   * card is missing / hidden / already orphaned.
   */
  markOrphaned(id: string): boolean {
    try {
      const row = this.getCardStmt.get(id);
      if (!row || row.hidden_at != null || row.orphaned_at != null) return false;
      const now = Date.now();
      const next: TaskboardCard = {
        ...this.rowToCard(row),
        orphanedAt: now,
        updatedAt: now,
        version: row.version + 1,
      };
      this.db.transaction(() => {
        this.updateCardStmt.run(this.cardToRow(next));
        this.insertEventStmt.run(
          this.makeEvent(next, 'orphaned', null, { assignee: row.assignee_session_id }),
        );
      })();
      this.emit('orphaned', next, { assignee: row.assignee_session_id });
      return true;
    } catch (err) {
      log.warn({ event: 'taskboard.mark_orphaned_failed', id, error: String(err) });
      return false;
    }
  }

  /**
   * TTL janitor (Phase 3): soft-delete every orphaned, still-visible card whose
   * `orphaned_at` is older than `cutoffMs`. Reuses `deleteCard` so each purge is
   * audited (`deleted` journal + `taskboard.card_deleted` event) exactly like an
   * operator delete. Never throws — a bad row must not abort the whole sweep;
   * returns how many were actually purged.
   */
  purgeOrphanedBefore(cutoffMs: number): number {
    let purged = 0;
    try {
      const ids = this.expiredOrphansStmt.all(cutoffMs).map((r) => r.id);
      for (const id of ids) {
        try {
          if (this.deleteCard({ id, actorSessionId: null })) purged++;
        } catch (err) {
          log.warn({ event: 'taskboard.purge_card_failed', id, error: String(err) });
        }
      }
    } catch (err) {
      log.warn({ event: 'taskboard.purge_orphaned_failed', error: String(err) });
    }
    return purged;
  }

  /**
   * Create a card auto-assigned to a freshly-spawned worker (Phase 3, wired at
   * `Orchestrator.addWorker`). Not yet called anywhere — the method exists so
   * the Phase 3 hook has a stable entry point.
   */
  createAutoCardForWorker(input: {
    orchestratorId: string;
    assigneeSessionId: string;
    title: string;
    body?: string;
    createdBy: string;
  }): TaskboardCard {
    this.assertValidId(input.assigneeSessionId, 'assignee');
    return this.createCard({
      orchestratorId: input.orchestratorId,
      title: input.title,
      body: input.body ?? '',
      status: 'todo',
      assignee: input.assigneeSessionId,
      createdBy: input.createdBy,
      autoCreated: true,
    });
  }

  /**
   * Purge ALL board data — `DELETE` the three owned tables in ONE transaction
   * (docs/builtin-features.md D7: `taskboard_cards` + `taskboard_deps` +
   * `taskboard_events`). Deliberately a DELETE, NEVER a DROP: every prepared
   * statement above stays valid, so a board re-enable finds this store already
   * present and simply empty. The per-card `cost_*` bookkeeping columns leave
   * with their cards. Never throws (a purge hiccup must not crash the 24/7
   * server); wrapped in a transaction so the three tables are cleared together.
   */
  purgeAll(): void {
    try {
      this.db.transaction(() => {
        this.db.exec('DELETE FROM taskboard_cards');
        this.db.exec('DELETE FROM taskboard_deps');
        this.db.exec('DELETE FROM taskboard_events');
      })();
      log.info({ event: 'taskboard.purged' });
    } catch (err) {
      log.warn({ event: 'taskboard.purge_all_failed', error: String(err) });
    }
  }
}

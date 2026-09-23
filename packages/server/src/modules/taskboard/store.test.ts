import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../db/index.js';
import { SwarmEventBus, type SwarmEvent } from '../../events.js';
import {
  TaskboardStore,
  TaskboardConflictError,
  TaskboardError,
  orderKeyBetween,
} from './store.js';

let dir: string;
let db: SwarmDb;
let bus: SwarmEventBus;
let events: SwarmEvent[];
let store: TaskboardStore;

const ORCH_A = 'orch-a';
const ORCH_B = 'orch-b';
const LEAD = 'sess-lead';
const WORKER = 'sess-worker';

/** Insert a minimal orchestrator row so the FK (cards → orchestrators) holds. */
function insertOrch(id: string): void {
  db.db
    .prepare(
      `INSERT INTO orchestrators (id, name, role, status, default_model, default_effort, default_permission_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, `Team ${id}`, 'lead', 'running', 'claude-x', 'high', 'default', new Date().toISOString());
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-store-'));
  db = new SwarmDb(dir);
  bus = new SwarmEventBus();
  events = [];
  bus.onEvent((e) => events.push(e));
  insertOrch(ORCH_A);
  insertOrch(ORCH_B);
  store = new TaskboardStore(db, { eventBus: bus });
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('orderKeyBetween', () => {
  it('produces keys that sort strictly between the bounds', () => {
    const first = orderKeyBetween('', '');
    const second = orderKeyBetween(first, '');
    expect(first < second).toBe(true);
    const mid = orderKeyBetween(first, second);
    expect(first < mid && mid < second).toBe(true);
  });

  it('keeps ordering when repeatedly inserting between adjacent keys', () => {
    let a = orderKeyBetween('', '');
    let b = orderKeyBetween(a, '');
    for (let i = 0; i < 40; i++) {
      const m = orderKeyBetween(a, b);
      expect(a < m).toBe(true);
      expect(m < b).toBe(true);
      b = m; // keep squeezing between a and the new midpoint
    }
  });
});

describe('createCard + getCard', () => {
  it('creates a card, returns it via getCard with a created journal entry', () => {
    const card = store.createCard({
      orchestratorId: ORCH_A,
      title: 'Ship phase 1',
      body: 'do the store',
      assignee: WORKER,
      labels: ['backend'],
      createdBy: LEAD,
    });
    expect(card.id).toBeTruthy();
    expect(card.version).toBe(1);
    expect(card.status).toBe('todo');
    expect(card.autoCreated).toBe(false);

    const detail = store.getCard(card.id);
    expect(detail).not.toBeNull();
    expect(detail!.title).toBe('Ship phase 1');
    expect(detail!.assigneeSessionId).toBe(WORKER);
    expect(detail!.labels).toEqual(['backend']);
    expect(detail!.dependsOn).toEqual([]);
    expect(detail!.events.map((e) => e.kind)).toContain('created');

    // A card_created bus event fired, tagged with the team.
    const created = events.find((e) => e.kind === 'taskboard.card_created');
    expect(created).toBeTruthy();
    expect(created!.orchestratorId).toBe(ORCH_A);
  });

  it('rejects an empty title', () => {
    expect(() => store.createCard({ orchestratorId: ORCH_A, title: '  ', createdBy: LEAD })).toThrow(
      TaskboardError,
    );
  });
});

describe('updateCard optimistic lock', () => {
  it('bumps version on a matching expectedVersion', () => {
    const card = store.createCard({ orchestratorId: ORCH_A, title: 'T', createdBy: LEAD });
    const updated = store.updateCard({
      id: card.id,
      expectedVersion: 1,
      actorSessionId: LEAD,
      title: 'T2',
      priority: 2,
    });
    expect(updated.version).toBe(2);
    expect(updated.title).toBe('T2');
    expect(updated.priority).toBe(2);
  });

  it('throws VERSION_CONFLICT on a stale expectedVersion', () => {
    const card = store.createCard({ orchestratorId: ORCH_A, title: 'T', createdBy: LEAD });
    store.updateCard({ id: card.id, expectedVersion: 1, actorSessionId: LEAD, title: 'T2' });
    // Second writer still holds version 1 → conflict.
    let thrown: unknown;
    try {
      store.updateCard({ id: card.id, expectedVersion: 1, actorSessionId: WORKER, title: 'T3' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TaskboardConflictError);
    expect((thrown as TaskboardConflictError).code).toBe('VERSION_CONFLICT');
    expect((thrown as TaskboardConflictError).currentVersion).toBe(2);
    expect((thrown as TaskboardConflictError).expectedVersion).toBe(1);
  });
});

describe('moveCard', () => {
  it('changes column, bumps version, records a moved event + emits', () => {
    const card = store.createCard({ orchestratorId: ORCH_A, title: 'T', createdBy: LEAD });
    events.length = 0;
    const moved = store.moveCard({ id: card.id, status: 'doing', actorSessionId: WORKER });
    expect(moved.status).toBe('doing');
    expect(moved.version).toBe(2);

    const detail = store.getCard(card.id)!;
    const moveEvent = detail.events.find((e) => e.kind === 'moved');
    expect(moveEvent).toBeTruthy();
    expect(moveEvent!.data).toMatchObject({ from: 'todo', to: 'doing' });
    expect(moveEvent!.actorSessionId).toBe(WORKER);

    expect(events.some((e) => e.kind === 'taskboard.card_moved')).toBe(true);
  });

  it('rejects an invalid status', () => {
    const card = store.createCard({ orchestratorId: ORCH_A, title: 'T', createdBy: LEAD });
    expect(() => store.moveCard({ id: card.id, status: 'nope', actorSessionId: LEAD })).toThrow(
      TaskboardError,
    );
    try {
      store.moveCard({ id: card.id, status: 'nope', actorSessionId: LEAD });
    } catch (e) {
      expect((e as TaskboardError).code).toBe('INVALID_STATUS');
    }
  });
});

describe('dependencies + cycle guard', () => {
  it('adds a dependency edge visible from both sides', () => {
    const a = store.createCard({ orchestratorId: ORCH_A, title: 'A', createdBy: LEAD });
    const b = store.createCard({ orchestratorId: ORCH_A, title: 'B', createdBy: LEAD });
    store.addDep({ cardId: a.id, dependsOnId: b.id, actorSessionId: LEAD });
    expect(store.getCard(a.id)!.dependsOn).toEqual([b.id]);
    expect(store.getCard(b.id)!.blocks).toEqual([a.id]);
  });

  it('refuses an edge that would close a cycle', () => {
    const a = store.createCard({ orchestratorId: ORCH_A, title: 'A', createdBy: LEAD });
    const b = store.createCard({ orchestratorId: ORCH_A, title: 'B', createdBy: LEAD });
    const c = store.createCard({ orchestratorId: ORCH_A, title: 'C', createdBy: LEAD });
    store.addDep({ cardId: a.id, dependsOnId: b.id, actorSessionId: LEAD });
    store.addDep({ cardId: b.id, dependsOnId: c.id, actorSessionId: LEAD });
    // c → a would close a → b → c → a.
    let thrown: unknown;
    try {
      store.addDep({ cardId: c.id, dependsOnId: a.id, actorSessionId: LEAD });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TaskboardError);
    expect((thrown as TaskboardError).code).toBe('CYCLE');
    // The edge was NOT written.
    expect(store.getCard(c.id)!.dependsOn).toEqual([]);
  });

  it('refuses a self-dependency', () => {
    const a = store.createCard({ orchestratorId: ORCH_A, title: 'A', createdBy: LEAD });
    expect(() => store.addDep({ cardId: a.id, dependsOnId: a.id, actorSessionId: LEAD })).toThrow(
      TaskboardError,
    );
  });

  it('refuses a dependency across teams', () => {
    const a = store.createCard({ orchestratorId: ORCH_A, title: 'A', createdBy: LEAD });
    const other = store.createCard({ orchestratorId: ORCH_B, title: 'X', createdBy: LEAD });
    let thrown: unknown;
    try {
      store.addDep({ cardId: a.id, dependsOnId: other.id, actorSessionId: LEAD });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TaskboardError);
    expect((thrown as TaskboardError).code).toBe('INVALID_DEP');
  });

  it('removes a dependency edge', () => {
    const a = store.createCard({ orchestratorId: ORCH_A, title: 'A', createdBy: LEAD });
    const b = store.createCard({ orchestratorId: ORCH_A, title: 'B', createdBy: LEAD });
    store.addDep({ cardId: a.id, dependsOnId: b.id, actorSessionId: LEAD });
    store.removeDep({ cardId: a.id, dependsOnId: b.id, actorSessionId: LEAD });
    expect(store.getCard(a.id)!.dependsOn).toEqual([]);
  });
});

describe('scoping by orchestrator_id', () => {
  it('listCards only returns the requested team, filters work', () => {
    store.createCard({ orchestratorId: ORCH_A, title: 'A1', createdBy: LEAD });
    store.createCard({ orchestratorId: ORCH_A, title: 'A2', assignee: WORKER, createdBy: LEAD });
    store.createCard({ orchestratorId: ORCH_B, title: 'B1', createdBy: LEAD });

    expect(store.listCards({ orchestratorId: ORCH_A }).length).toBe(2);
    expect(store.listCards({ orchestratorId: ORCH_B }).length).toBe(1);
    expect(store.listCards({ orchestratorId: ORCH_A, assignee: WORKER }).length).toBe(1);
    expect(store.listCards({ orchestratorId: ORCH_A, status: 'done' }).length).toBe(0);
  });
});

describe('comment', () => {
  it('appends a journal entry without bumping the card version', () => {
    const card = store.createCard({ orchestratorId: ORCH_A, title: 'T', createdBy: LEAD });
    const ev = store.comment({ id: card.id, text: 'looks good', actorSessionId: WORKER });
    expect(ev.kind).toBe('comment');
    expect(ev.data).toMatchObject({ text: 'looks good' });
    expect(store.getCard(card.id)!.version).toBe(1); // unchanged
    expect(store.getCard(card.id)!.events.some((e) => e.kind === 'comment')).toBe(true);
  });
});

describe('close / reopen', () => {
  it('closes to done then reopens to todo', () => {
    const card = store.createCard({ orchestratorId: ORCH_A, title: 'T', createdBy: LEAD });
    const closed = store.closeCard({ id: card.id, actorSessionId: LEAD });
    expect(closed.status).toBe('done');
    expect(closed.closedAt).not.toBeNull();
    const reopened = store.reopenCard({ id: card.id, actorSessionId: LEAD });
    expect(reopened.status).toBe('todo');
    expect(reopened.closedAt).toBeNull();
  });
});

describe('soft-delete', () => {
  it('hides the card from listCards but keeps it in the DB', () => {
    const card = store.createCard({ orchestratorId: ORCH_A, title: 'T', createdBy: LEAD });
    expect(store.deleteCard({ id: card.id, actorSessionId: LEAD })).toBe(true);
    expect(store.listCards({ orchestratorId: ORCH_A }).length).toBe(0);
    expect(store.listCards({ orchestratorId: ORCH_A, includeHidden: true }).length).toBe(1);
    // getCard still resolves it (audit), hiddenAt set.
    expect(store.getCard(card.id)!.hiddenAt).not.toBeNull();
    // A second delete is a no-op.
    expect(store.deleteCard({ id: card.id, actorSessionId: LEAD })).toBe(false);
  });
});

describe('assign / orphan lifecycle', () => {
  it('assign clears the orphaned flag; markOrphaned + listOrphaned', () => {
    const card = store.createCard({
      orchestratorId: ORCH_A,
      title: 'T',
      assignee: WORKER,
      createdBy: LEAD,
    });
    expect(store.markOrphaned(card.id)).toBe(true);
    expect(store.getCard(card.id)!.orphanedAt).not.toBeNull();
    expect(store.listOrphaned(ORCH_A).map((c) => c.id)).toEqual([card.id]);
    // Re-assigning resolves the orphan flag.
    const reassigned = store.assignCard({ id: card.id, assignee: 'sess-new', actorSessionId: LEAD });
    expect(reassigned.orphanedAt).toBeNull();
    expect(store.listOrphaned(ORCH_A)).toEqual([]);
  });
});

describe('createAutoCardForWorker', () => {
  it('creates a todo card auto-assigned to the worker, flagged auto_created', () => {
    const card = store.createAutoCardForWorker({
      orchestratorId: ORCH_A,
      assigneeSessionId: WORKER,
      title: 'Worker task',
      createdBy: LEAD,
    });
    expect(card.autoCreated).toBe(true);
    expect(card.status).toBe('todo');
    expect(card.assigneeSessionId).toBe(WORKER);
  });
});

describe('getCard on a missing card', () => {
  it('returns null', () => {
    expect(store.getCard('does-not-exist')).toBeNull();
  });
});

// --- Lot 16: cost per card --------------------------------------------------

/**
 * A stand-in fleet: assignee → what the cost lookup answers for it. Mutating an
 * entry between two transitions is how a test makes an agent "spend" money.
 */
let fleet: Map<string, { sessionId: string; costUsd: number | null }>;

/** Read the three raw cost columns — the bookkeeping never reaches the DTO. */
function costRow(id: string): {
  cost_usd: number | null;
  cost_start_usd: number | null;
  cost_assignee_session: string | null;
} {
  return db.db
    .prepare('SELECT cost_usd, cost_start_usd, cost_assignee_session FROM taskboard_cards WHERE id = ?')
    .get(id) as never;
}

/** A card assigned to `who`, parked in `todo`, ready to be moved into `doing`. */
function cardFor(who: string): string {
  return store.createCard({ orchestratorId: ORCH_A, title: 'Costed', assignee: who, createdBy: LEAD })
    .id;
}

const move = (id: string, status: string): void => {
  store.moveCard({ id, status, actorSessionId: LEAD });
};

describe('cost per card (Lot 16)', () => {
  beforeEach(() => {
    fleet = new Map([[WORKER, { sessionId: WORKER, costUsd: 1 }]]);
    store.setCostLookup((_orch, assignee) => fleet.get(assignee) ?? null);
  });

  it('banks the delta over one doing → done spell', () => {
    const id = cardFor(WORKER);
    move(id, 'doing');
    // The snapshot is the assignee's running total at entry, not zero.
    expect(costRow(id).cost_start_usd).toBe(1);
    expect(costRow(id).cost_assignee_session).toBe(WORKER);
    expect(store.getCard(id)!.costUsd).toBeNull(); // nothing settled yet

    fleet.set(WORKER, { sessionId: WORKER, costUsd: 1.75 });
    move(id, 'done');

    expect(store.getCard(id)!.costUsd).toBeCloseTo(0.75, 6);
    // Bookkeeping is cleared on the way out — nothing is in flight any more.
    expect(costRow(id).cost_start_usd).toBeNull();
    expect(costRow(id).cost_assignee_session).toBeNull();
  });

  it('SUMS the spells of a doing → review → doing → done round trip', () => {
    const id = cardFor(WORKER);
    move(id, 'doing');
    fleet.set(WORKER, { sessionId: WORKER, costUsd: 1.75 });
    move(id, 'review'); // banks 0.75

    expect(store.getCard(id)!.costUsd).toBeCloseTo(0.75, 6);

    move(id, 'doing'); // re-snapshots at 1.75
    expect(costRow(id).cost_start_usd).toBeCloseTo(1.75, 6);
    fleet.set(WORKER, { sessionId: WORKER, costUsd: 2.25 });
    move(id, 'done'); // banks another 0.50 ON TOP

    expect(store.getCard(id)!.costUsd).toBeCloseTo(1.25, 6);
  });

  it('leaves the cost UNCHANGED when the assignee changed mid-flight', () => {
    fleet.set('sess-other', { sessionId: 'sess-other', costUsd: 40 });
    const id = cardFor(WORKER);
    move(id, 'doing');
    fleet.set(WORKER, { sessionId: WORKER, costUsd: 9 });
    // Someone else takes the card over before it lands.
    store.assignCard({ id, assignee: 'sess-other', actorSessionId: LEAD });
    move(id, 'done');

    // Neither the 8 the first agent burned nor the other's 40: nobody can say
    // who spent what, so the card carries no figure at all.
    expect(store.getCard(id)!.costUsd).toBeNull();
    expect(costRow(id).cost_start_usd).toBeNull();
    expect(costRow(id).cost_assignee_session).toBeNull();
  });

  it('takes no snapshot for a session without counters, and settles nothing', () => {
    fleet.set(WORKER, { sessionId: WORKER, costUsd: null });
    const id = cardFor(WORKER);
    move(id, 'doing');

    expect(costRow(id).cost_start_usd).toBeNull();
    expect(costRow(id).cost_assignee_session).toBeNull();

    // Counters show up mid-flight: with no start there is still no delta.
    fleet.set(WORKER, { sessionId: WORKER, costUsd: 3 });
    move(id, 'done');
    expect(store.getCard(id)!.costUsd).toBeNull();
  });

  it('takes no snapshot for an unresolvable or ambiguous assignee', () => {
    const id = cardFor('ghost-agent'); // resolves to nothing
    move(id, 'doing');
    expect(costRow(id).cost_start_usd).toBeNull();
    move(id, 'done');
    expect(store.getCard(id)!.costUsd).toBeNull();
  });

  it('clamps a negative delta to zero when the session counters reset', () => {
    const id = cardFor(WORKER);
    fleet.set(WORKER, { sessionId: WORKER, costUsd: 2 });
    move(id, 'doing');
    // The agent was restarted: its cumulative total went BACKWARDS.
    fleet.set(WORKER, { sessionId: WORKER, costUsd: 0.5 });
    move(id, 'done');

    expect(store.getCard(id)!.costUsd).toBe(0); // never negative
  });

  it('keeps an already-banked figure when a later spell cannot be attributed', () => {
    const id = cardFor(WORKER);
    move(id, 'doing');
    fleet.set(WORKER, { sessionId: WORKER, costUsd: 1.5 });
    move(id, 'review'); // banks 0.50
    move(id, 'doing');
    // The agent vanishes before the card lands.
    fleet.delete(WORKER);
    move(id, 'done');

    expect(store.getCard(id)!.costUsd).toBeCloseTo(0.5, 6);
  });

  it('settles a doing → done exit made through closeCard', () => {
    const id = cardFor(WORKER);
    move(id, 'doing');
    fleet.set(WORKER, { sessionId: WORKER, costUsd: 3 });
    const closed = store.closeCard({ id, actorSessionId: LEAD });

    expect(closed.status).toBe('done');
    expect(closed.costUsd).toBeCloseTo(2, 6);
    expect(costRow(id).cost_start_usd).toBeNull();
  });

  it('resolves an assignee given as an agent NAME, not a session id', () => {
    fleet.set('refactor-worker', { sessionId: 'sess-w7', costUsd: 5 });
    const id = cardFor('refactor-worker');
    move(id, 'doing');
    // The snapshot is booked against the resolved SESSION, not the name.
    expect(costRow(id).cost_assignee_session).toBe('sess-w7');
    fleet.set('refactor-worker', { sessionId: 'sess-w7', costUsd: 6.5 });
    move(id, 'done');
    expect(store.getCard(id)!.costUsd).toBeCloseTo(1.5, 6);
  });

  it('drops the spell when the name now resolves to a DIFFERENT session', () => {
    fleet.set('refactor-worker', { sessionId: 'sess-w7', costUsd: 5 });
    const id = cardFor('refactor-worker');
    move(id, 'doing');
    // The worker was restarted under the same name: same label, new agent.
    fleet.set('refactor-worker', { sessionId: 'sess-w8', costUsd: 12 });
    move(id, 'done');

    expect(store.getCard(id)!.costUsd).toBeNull();
  });

  it('ignores transitions that never touch doing', () => {
    const id = cardFor(WORKER);
    move(id, 'review');
    move(id, 'blocked');
    move(id, 'done');
    expect(store.getCard(id)!.costUsd).toBeNull();
    expect(costRow(id).cost_start_usd).toBeNull();
  });

  it('never throws when the lookup itself blows up', () => {
    store.setCostLookup(() => {
      throw new Error('spawner exploded');
    });
    const id = cardFor(WORKER);
    expect(() => move(id, 'doing')).not.toThrow();
    expect(() => move(id, 'done')).not.toThrow();
    expect(store.getCard(id)!.costUsd).toBeNull();
  });
});

describe('cost per card without a lookup wired', () => {
  it('exposes costUsd: null on the card view and prices nothing', () => {
    // `store` here is the default fixture — no setCostLookup call at all.
    const card = store.createCard({
      orchestratorId: ORCH_A,
      title: 'Unpriced',
      assignee: WORKER,
      createdBy: LEAD,
    });
    expect(card.costUsd).toBeNull();
    store.moveCard({ id: card.id, status: 'doing', actorSessionId: LEAD });
    store.moveCard({ id: card.id, status: 'done', actorSessionId: LEAD });

    // The field is PRESENT (the web contract) and null (nothing to show).
    const listed = store.listCards({ orchestratorId: ORCH_A }).find((c) => c.id === card.id)!;
    expect('costUsd' in listed).toBe(true);
    expect(listed.costUsd).toBeNull();
    expect(store.getCard(card.id)!.costUsd).toBeNull();
  });

  it('migrates a pre-Lot-16 table and stays idempotent', () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-migr-'));
    const db2 = new SwarmDb(dir2);
    try {
      // `taskboard_cards` exactly as an earlier build of this store left it:
      // CREATE TABLE IF NOT EXISTS skips it wholesale, so only the ALTERs help.
      db2.db.exec(`
        CREATE TABLE taskboard_cards (
          id TEXT PRIMARY KEY, orchestrator_id TEXT NOT NULL, title TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'todo',
          assignee_session_id TEXT, priority INTEGER NOT NULL DEFAULT 0, labels TEXT,
          order_key TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
          closed_at INTEGER, orphaned_at INTEGER,
          auto_created INTEGER NOT NULL DEFAULT 0, hidden_at INTEGER
        );
      `);
      const cols = (): string[] =>
        (db2.db.prepare('PRAGMA table_info(taskboard_cards)').all() as { name: string }[]).map(
          (c) => c.name,
        );
      expect(cols()).not.toContain('cost_usd');

      const migrated = new TaskboardStore(db2);
      expect(cols()).toEqual(
        expect.arrayContaining(['cost_usd', 'cost_start_usd', 'cost_assignee_session']),
      );
      // Re-opening the same DB must not throw (duplicate column name swallowed).
      expect(() => new TaskboardStore(db2)).not.toThrow();

      // And the upgraded table is writable through the new mapping.
      db2.db
        .prepare(
          `INSERT INTO orchestrators (id, name, role, status, default_model, default_effort, default_permission_mode, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ORCH_A, 'T', 'lead', 'running', 'claude-x', 'high', 'default', new Date().toISOString());
      const card = migrated.createCard({ orchestratorId: ORCH_A, title: 'Post-migration', createdBy: LEAD });
      expect(card.costUsd).toBeNull();
      expect(migrated.getCard(card.id)!.costUsd).toBeNull();
    } finally {
      db2.close();
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('round-trips the cost columns through the row mapping', () => {
    const card = store.createCard({ orchestratorId: ORCH_A, title: 'RT', createdBy: LEAD });
    db.db.prepare('UPDATE taskboard_cards SET cost_usd = ? WHERE id = ?').run(2.5, card.id);

    expect(store.getCard(card.id)!.costUsd).toBeCloseTo(2.5, 6);
    // A mutation that has nothing to do with the cost must PRESERVE it.
    store.updateCard({ id: card.id, expectedVersion: 1, actorSessionId: LEAD, title: 'RT2' });
    expect(store.getCard(card.id)!.costUsd).toBeCloseTo(2.5, 6);
    store.assignCard({ id: card.id, assignee: WORKER, actorSessionId: LEAD });
    expect(store.getCard(card.id)!.costUsd).toBeCloseTo(2.5, 6);
  });
});

describe('purgeAll (docs/builtin-features.md D7)', () => {
  /** Count rows in one of the three owned tables. */
  function count(table: string): number {
    return (db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }

  it('DELETEs cards, deps AND events across every team', () => {
    const a1 = store.createCard({ orchestratorId: ORCH_A, title: 'A1', createdBy: LEAD });
    const a2 = store.createCard({ orchestratorId: ORCH_A, title: 'A2', createdBy: LEAD });
    store.createCard({ orchestratorId: ORCH_B, title: 'B1', createdBy: LEAD });
    // A dependency edge (taskboard_deps) + a comment (extra taskboard_events row).
    store.addDep({ cardId: a1.id, dependsOnId: a2.id, actorSessionId: LEAD });
    store.comment({ id: a1.id, text: 'note', actorSessionId: LEAD });

    expect(count('taskboard_cards')).toBeGreaterThan(0);
    expect(count('taskboard_deps')).toBeGreaterThan(0);
    expect(count('taskboard_events')).toBeGreaterThan(0);

    store.purgeAll();

    expect(count('taskboard_cards')).toBe(0);
    expect(count('taskboard_deps')).toBe(0);
    expect(count('taskboard_events')).toBe(0);
    expect(store.listCards({ orchestratorId: ORCH_A })).toHaveLength(0);
    expect(store.listCards({ orchestratorId: ORCH_B })).toHaveLength(0);
    expect(store.listTeams()).toHaveLength(0);
  });

  it('is a DELETE, not a DROP — the store stays writable after a purge (re-enable)', () => {
    store.createCard({ orchestratorId: ORCH_A, title: 'before', createdBy: LEAD });
    store.purgeAll();

    // The prepared statements must still be valid: a fresh create + read works,
    // which is exactly what a board re-enable relies on (store already present,
    // simply empty).
    const revived = store.createCard({ orchestratorId: ORCH_A, title: 'after', createdBy: LEAD });
    expect(store.getCard(revived.id)?.title).toBe('after');
    expect(store.listCards({ orchestratorId: ORCH_A })).toHaveLength(1);
  });

  it('never throws (idempotent on an already-empty board)', () => {
    expect(() => store.purgeAll()).not.toThrow();
    expect(() => store.purgeAll()).not.toThrow();
    expect(count('taskboard_cards')).toBe(0);
  });
});

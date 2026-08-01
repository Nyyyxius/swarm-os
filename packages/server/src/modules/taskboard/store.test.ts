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

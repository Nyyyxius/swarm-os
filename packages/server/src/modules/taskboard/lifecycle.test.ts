import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../db/index.js';
import { SwarmEventBus, type SwarmEvent } from '../../events.js';
import { TaskboardStore } from './store.js';
import { markOrphanedCardsAtBoot, startTaskboardJanitor } from './lifecycle.js';
import type { Spawner } from '../spawner/index.js';

let dir: string;
let db: SwarmDb;
let bus: SwarmEventBus;
let events: SwarmEvent[];
let store: TaskboardStore;

const ORCH_A = 'orch-a';

function insertOrch(id: string): void {
  db.db
    .prepare(
      `INSERT INTO orchestrators (id, name, role, status, default_model, default_effort, default_permission_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, `Team ${id}`, 'lead', 'running', 'claude-x', 'high', 'default', new Date().toISOString());
}

/** Minimal Spawner stand-in: the orphan pass only reads `list()` + per-orch id/sessions. */
function fakeSpawner(
  orchs: Array<{ id: string; sessions: Array<{ id: string; status: string }> }>,
): Spawner {
  return {
    list: () =>
      orchs.map((o) => ({
        id: o.id,
        listSessions: () => o.sessions,
      })),
  } as unknown as Spawner;
}

/** Backdate a card's orphaned_at so the TTL janitor considers it expired. */
function backdateOrphan(id: string, ts: number): void {
  db.db.prepare('UPDATE taskboard_cards SET orphaned_at = ? WHERE id = ?').run(ts, id);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-lifecycle-'));
  db = new SwarmDb(dir);
  bus = new SwarmEventBus();
  events = [];
  bus.onEvent((e) => events.push(e));
  insertOrch(ORCH_A);
  store = new TaskboardStore(db, { eventBus: bus });
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('markOrphanedCardsAtBoot (crash-resume pass)', () => {
  it('orphans open cards whose assignee vanished, and emits taskboard.card_orphaned', () => {
    const kept = store.createCard({ orchestratorId: ORCH_A, title: 'still mine', assignee: 'live-1', createdBy: 'lead' });
    const vanished = store.createCard({ orchestratorId: ORCH_A, title: 'ghost', assignee: 'dead-1', createdBy: 'lead' });
    const closed = store.createCard({ orchestratorId: ORCH_A, title: 'done by ghost', assignee: 'dead-2', createdBy: 'lead' });
    store.closeCard({ id: closed.id, actorSessionId: 'lead' });
    const unassigned = store.createCard({ orchestratorId: ORCH_A, title: 'nobody', createdBy: 'lead' });

    events.length = 0;
    const spawner = fakeSpawner([{ id: ORCH_A, sessions: [{ id: 'live-1', status: 'running' }] }]);
    const { orphaned } = markOrphanedCardsAtBoot(spawner, store);

    expect(orphaned).toBe(1);
    expect(store.getCard(vanished.id)!.orphanedAt).not.toBeNull();
    // Live assignee, closed card, and unassigned card are all left untouched.
    expect(store.getCard(kept.id)!.orphanedAt).toBeNull();
    expect(store.getCard(closed.id)!.orphanedAt).toBeNull();
    expect(store.getCard(unassigned.id)!.orphanedAt).toBeNull();

    const orphanEvents = events.filter((e) => e.kind === 'taskboard.card_orphaned');
    expect(orphanEvents).toHaveLength(1);
    expect((orphanEvents[0]!.payload as { cardId: string }).cardId).toBe(vanished.id);
  });

  it('is idempotent — a second pass orphans nothing new', () => {
    const c = store.createCard({ orchestratorId: ORCH_A, title: 'ghost', assignee: 'dead', createdBy: 'lead' });
    const spawner = fakeSpawner([{ id: ORCH_A, sessions: [] }]);
    expect(markOrphanedCardsAtBoot(spawner, store).orphaned).toBe(1);
    expect(markOrphanedCardsAtBoot(spawner, store).orphaned).toBe(0);
    expect(store.getCard(c.id)!.orphanedAt).not.toBeNull();
  });
});

describe('startTaskboardJanitor (TTL sweep)', () => {
  it('purges orphaned cards past the TTL, keeps recent ones', () => {
    const oldCard = store.createCard({ orchestratorId: ORCH_A, title: 'old ghost', assignee: 'x', createdBy: 'lead' });
    const freshCard = store.createCard({ orchestratorId: ORCH_A, title: 'fresh ghost', assignee: 'y', createdBy: 'lead' });
    store.markOrphaned(oldCard.id);
    store.markOrphaned(freshCard.id);
    // Age the first orphan well past a 1h TTL; leave the second at "now".
    backdateOrphan(oldCard.id, Date.now() - 48 * 60 * 60 * 1000);

    const handle = startTaskboardJanitor(store, { ttlMs: 60 * 60 * 1000, intervalMs: 60 * 60 * 1000 });
    // The janitor fires one sweep synchronously on start.
    handle.stop();

    expect(store.getCard(oldCard.id)!.hiddenAt).not.toBeNull(); // purged (soft-deleted)
    expect(store.getCard(freshCard.id)!.hiddenAt).toBeNull(); // kept
    // The purge is audited like an operator delete.
    expect(events.some((e) => e.kind === 'taskboard.card_deleted')).toBe(true);
  });

  it('purgeOrphanedBefore ignores non-orphaned and already-hidden cards', () => {
    const open = store.createCard({ orchestratorId: ORCH_A, title: 'open', assignee: 'z', createdBy: 'lead' });
    const orphan = store.createCard({ orchestratorId: ORCH_A, title: 'orphan', assignee: 'w', createdBy: 'lead' });
    store.markOrphaned(orphan.id);
    backdateOrphan(orphan.id, 1000);

    const purged = store.purgeOrphanedBefore(Date.now());
    expect(purged).toBe(1);
    expect(store.getCard(open.id)!.hiddenAt).toBeNull();
    // A second sweep finds nothing (already hidden).
    expect(store.purgeOrphanedBefore(Date.now())).toBe(0);
  });

  it('is disabled (no-op handle) when ttl or interval is 0', () => {
    const orphan = store.createCard({ orchestratorId: ORCH_A, title: 'orphan', assignee: 'w', createdBy: 'lead' });
    store.markOrphaned(orphan.id);
    backdateOrphan(orphan.id, 1000);
    const handle = startTaskboardJanitor(store, { ttlMs: 0, intervalMs: 60_000 });
    handle.stop();
    // Disabled janitor never swept.
    expect(store.getCard(orphan.id)!.hiddenAt).toBeNull();
  });
});

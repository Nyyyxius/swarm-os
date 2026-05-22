/**
 * Unit tests for `MessagesAggregator` (S9 — fusion S4 + S9).
 *
 * Uses a fake spawner (literally `{ list() => fakeOrchs }`) so we don't have
 * to spin up the full Spawner/Orchestrator/Mailbox stack. `vi.useFakeTimers()`
 * lets us advance through 60 s ticks instantly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessagesAggregator, type MetricsSpawnerLike } from './aggregator.js';

/** Minimal Orchestrator-like shape — only `id` and `mailbox.messagesTotal`. */
interface FakeOrch {
  id: string;
  mailbox: { messagesTotal: number };
}

/** In-memory fake spawner. Tests mutate `orchs` then call `tick()`. */
function fakeSpawner(): MetricsSpawnerLike & { orchs: FakeOrch[] } {
  const orchs: FakeOrch[] = [];
  return {
    orchs,
    list() {
      return orchs;
    },
  };
}

/** Convenience — append a new orch with the given total. */
function addOrch(spawner: ReturnType<typeof fakeSpawner>, id: string, total = 0): FakeOrch {
  const o: FakeOrch = { id, mailbox: { messagesTotal: total } };
  spawner.orchs.push(o);
  return o;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MessagesAggregator — initial state', () => {
  it('exposes a 60-point global ring filled with zeros before start()', () => {
    const sp = fakeSpawner();
    const agg = new MessagesAggregator(sp);
    const snap = agg.snapshot();
    expect(snap.total).toBe(0);
    expect(snap.per_minute).toBe(0);
    expect(snap.global).toHaveLength(60);
    expect(snap.global.every((n) => n === 0)).toBe(true);
    expect(snap.per_orchestrator).toEqual({});
  });

  it('snapshot() is identical immediately after start() (no tick has run)', () => {
    const sp = fakeSpawner();
    addOrch(sp, 'a', 0);
    const agg = new MessagesAggregator(sp);
    agg.start();
    const snap = agg.snapshot();
    expect(snap.global).toEqual(new Array(60).fill(0));
    expect(snap.per_orchestrator).toEqual({});
    agg.stop();
  });

  it('total mirrors Σ messagesTotal even without any tick', () => {
    const sp = fakeSpawner();
    addOrch(sp, 'a', 7);
    addOrch(sp, 'b', 5);
    const agg = new MessagesAggregator(sp);
    expect(agg.snapshot().total).toBe(12);
  });
});

describe('MessagesAggregator — start() / stop() lifecycle', () => {
  it('start() is idempotent — only one interval', () => {
    const sp = fakeSpawner();
    addOrch(sp, 'a', 0);
    const agg = new MessagesAggregator(sp, { tickMs: 1000 });
    const before = vi.getTimerCount();
    agg.start();
    const after1 = vi.getTimerCount();
    agg.start();
    const after2 = vi.getTimerCount();
    expect(after1 - before).toBe(1);
    expect(after2).toBe(after1);
    agg.stop();
  });

  it('stop() is idempotent and prevents further ticks', () => {
    const sp = fakeSpawner();
    const orch = addOrch(sp, 'a', 0);
    const agg = new MessagesAggregator(sp, { tickMs: 1000 });
    agg.start();
    agg.stop();
    agg.stop(); // no throw
    // Advance the clock — no tick should fire.
    orch.mailbox.messagesTotal = 5;
    vi.advanceTimersByTime(10_000);
    expect(agg.snapshot().global[59]).toBe(0);
  });

  it('tick() runs automatically on the configured interval', () => {
    const sp = fakeSpawner();
    const orch = addOrch(sp, 'a', 0);
    const agg = new MessagesAggregator(sp, { tickMs: 1000 });
    agg.start();
    orch.mailbox.messagesTotal = 3;
    vi.advanceTimersByTime(1000);
    expect(agg.snapshot().global[59]).toBe(3);
    expect(agg.snapshot().per_orchestrator['a']?.[7]).toBe(3);
    agg.stop();
  });
});

describe('MessagesAggregator — tick semantics', () => {
  it('1 tick with no changes leaves a zero on the right', () => {
    const sp = fakeSpawner();
    addOrch(sp, 'a', 0);
    const agg = new MessagesAggregator(sp);
    agg.start();
    agg.tick();
    const snap = agg.snapshot();
    expect(snap.global[59]).toBe(0);
    expect(snap.per_minute).toBe(0);
    expect(snap.per_orchestrator['a']).toEqual(new Array(8).fill(0));
    agg.stop();
  });

  it('1 tick after orch goes 0 → 42', () => {
    const sp = fakeSpawner();
    const orch = addOrch(sp, 'a', 0);
    const agg = new MessagesAggregator(sp);
    agg.start();
    orch.mailbox.messagesTotal = 42;
    agg.tick();
    const snap = agg.snapshot();
    expect(snap.total).toBe(42);
    expect(snap.global[59]).toBe(42);
    expect(snap.per_minute).toBe(42);
    expect(snap.per_orchestrator['a']?.[7]).toBe(42);
    expect(snap.per_orchestrator['a']?.slice(0, 7)).toEqual(new Array(7).fill(0));
    agg.stop();
  });

  it('aggregates deltas across 2 orchs', () => {
    const sp = fakeSpawner();
    const a = addOrch(sp, 'A', 0);
    const b = addOrch(sp, 'B', 0);
    const agg = new MessagesAggregator(sp);
    agg.start();
    a.mailbox.messagesTotal = 10;
    b.mailbox.messagesTotal = 30;
    agg.tick();
    const snap = agg.snapshot();
    expect(snap.global[59]).toBe(40);
    expect(snap.per_orchestrator['A']?.[7]).toBe(10);
    expect(snap.per_orchestrator['B']?.[7]).toBe(30);
    expect(snap.total).toBe(40);
    agg.stop();
  });

  it('keeps ring lengths invariant across many ticks', () => {
    const sp = fakeSpawner();
    const orch = addOrch(sp, 'a', 0);
    const agg = new MessagesAggregator(sp);
    agg.start();
    for (let i = 1; i <= 200; i++) {
      orch.mailbox.messagesTotal = i;
      agg.tick();
    }
    const snap = agg.snapshot();
    expect(snap.global).toHaveLength(60);
    expect(snap.per_orchestrator['a']).toHaveLength(8);
    // Last 8 ticks were deltas of 1 each.
    expect(snap.per_orchestrator['a']).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    // Last 60 ticks were also deltas of 1 each.
    expect(snap.global).toEqual(new Array(60).fill(1));
    agg.stop();
  });

  it('clamps negative deltas to zero (messagesTotal must be monotone but defensive)', () => {
    const sp = fakeSpawner();
    const orch = addOrch(sp, 'a', 100);
    const agg = new MessagesAggregator(sp);
    agg.start();
    // 1st tick: equal → 0.
    agg.tick();
    expect(agg.snapshot().per_orchestrator['a']?.[7]).toBe(0);
    // 2nd tick: decreases (theoretical) → clamp to 0, NOT a negative number.
    orch.mailbox.messagesTotal = 50;
    agg.tick();
    expect(agg.snapshot().per_orchestrator['a']?.[7]).toBe(0);
    expect(agg.snapshot().global[59]).toBe(0);
    agg.stop();
  });
});

describe('MessagesAggregator — orch lifecycle', () => {
  it('orch created BEFORE start() with backlog → 1st tick delta = 0', () => {
    const sp = fakeSpawner();
    addOrch(sp, 'a', 500);
    const agg = new MessagesAggregator(sp);
    agg.start();
    agg.tick();
    const snap = agg.snapshot();
    expect(snap.global[59]).toBe(0);
    expect(snap.per_orchestrator['a']?.[7]).toBe(0);
    // total still reflects the live Σ.
    expect(snap.total).toBe(500);
    agg.stop();
  });

  it('orch created AFTER start() between 2 ticks → ring [0,0,0,0,0,0,0,delta]', () => {
    const sp = fakeSpawner();
    const agg = new MessagesAggregator(sp);
    agg.start();
    // Push 3 empty ticks first so the global ring has some history.
    agg.tick();
    agg.tick();
    agg.tick();
    // Now a new orch appears with 12 messages already in its mailbox.
    const fresh = addOrch(sp, 'late', 12);
    agg.tick();
    const snap = agg.snapshot();
    // First time we see it, prev is undefined → delta is 0 (NOT 12), so the
    // 12-message backlog is NOT attributed to a single minute. That matches
    // the global delta which counts only NEW activity from now on.
    expect(snap.per_orchestrator['late']).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    // Now actually push 5 new messages and tick again.
    fresh.mailbox.messagesTotal = 17;
    agg.tick();
    const snap2 = agg.snapshot();
    expect(snap2.per_orchestrator['late']).toEqual([0, 0, 0, 0, 0, 0, 0, 5]);
    agg.stop();
  });

  it('orch stopped after some traffic → ring decays to [0]*8 over 8 ticks', () => {
    const sp = fakeSpawner();
    const orch = addOrch(sp, 'a', 0);
    const agg = new MessagesAggregator(sp);
    agg.start();
    orch.mailbox.messagesTotal = 5;
    agg.tick();
    expect(agg.snapshot().per_orchestrator['a']?.[7]).toBe(5);
    // Orch is "stopped" — messagesTotal stays frozen. The spawner.list()
    // still surfaces it (Map never purged), so each subsequent tick pushes 0.
    for (let i = 0; i < 8; i++) agg.tick();
    expect(agg.snapshot().per_orchestrator['a']).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    agg.stop();
  });

  it('orch removed from spawner.list() between ticks still gets 0s pushed defensively', () => {
    const sp = fakeSpawner();
    addOrch(sp, 'a', 0);
    const agg = new MessagesAggregator(sp);
    agg.start();
    sp.orchs[0]!.mailbox.messagesTotal = 7;
    agg.tick();
    expect(agg.snapshot().per_orchestrator['a']?.[7]).toBe(7);
    // Spawner purges it. Today this never happens, but we test the branch.
    sp.orchs.pop();
    for (let i = 0; i < 8; i++) agg.tick();
    // Ring is still present (we never delete) and decayed to all zeros.
    expect(agg.snapshot().per_orchestrator['a']).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    agg.stop();
  });
});

describe('MessagesAggregator — invariants', () => {
  it('snapshot().total === Σ mailbox.messagesTotal at every moment', () => {
    const sp = fakeSpawner();
    const a = addOrch(sp, 'A', 0);
    const b = addOrch(sp, 'B', 0);
    const agg = new MessagesAggregator(sp);
    agg.start();

    const sumOfTotals = () => sp.orchs.reduce((acc, o) => acc + o.mailbox.messagesTotal, 0);

    a.mailbox.messagesTotal = 4;
    b.mailbox.messagesTotal = 9;
    expect(agg.snapshot().total).toBe(sumOfTotals());
    agg.tick();
    expect(agg.snapshot().total).toBe(sumOfTotals());

    a.mailbox.messagesTotal = 100;
    expect(agg.snapshot().total).toBe(sumOfTotals());

    agg.stop();
  });

  it('Σ per_orchestrator[*][7] === global[59] when all orchs were known at start', () => {
    const sp = fakeSpawner();
    const a = addOrch(sp, 'A', 0);
    const b = addOrch(sp, 'B', 0);
    const agg = new MessagesAggregator(sp);
    agg.start();
    a.mailbox.messagesTotal = 11;
    b.mailbox.messagesTotal = 7;
    agg.tick();
    const snap = agg.snapshot();
    const sumLastSlot = Object.values(snap.per_orchestrator).reduce(
      (acc, ring) => acc + ring[ring.length - 1]!,
      0,
    );
    expect(sumLastSlot).toBe(snap.global[59]);
    agg.stop();
  });
});

describe('MessagesAggregator — snapshot isolation', () => {
  it('snapshot returns copies — mutating them does not change internal state', () => {
    const sp = fakeSpawner();
    const orch = addOrch(sp, 'a', 0);
    const agg = new MessagesAggregator(sp);
    agg.start();
    orch.mailbox.messagesTotal = 3;
    agg.tick();
    const s1 = agg.snapshot();
    s1.global[59] = 9999;
    s1.per_orchestrator['a']![7] = 9999;
    const s2 = agg.snapshot();
    expect(s2.global[59]).toBe(3);
    expect(s2.per_orchestrator['a']?.[7]).toBe(3);
    agg.stop();
  });
});

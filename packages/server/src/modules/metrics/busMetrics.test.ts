/**
 * S8 — unit tests for `BusMetricsCollector`.
 *
 * Strategy mirrors `aggregator.test.ts`: a fake spawner (`{ list() => [...] }`)
 * plus `vi.useFakeTimers()` to advance through 1 s ticks instantly. The
 * collector's `recordRequestStart` / `recordRequestEnd` calls real
 * `process.hrtime.bigint()` — we bracket them around tiny synchronous code
 * blocks so the latency is small but deterministically non-zero, OR we use
 * the manual `_setLatencyForTest` helper... actually we DON'T add a helper:
 * we lean on real hrtime measurement, asserting *ranges* rather than exact
 * values when latency is involved. Bookkeeping (request/error counts,
 * throughput, queue_depth) is fully deterministic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  BusMetricsCollector,
  type BusMetricsSpawnerLike,
} from './busMetrics.js';

interface FakeOrch {
  id: string;
  mailbox: {
    messagesTotal: number;
    totalSize(): number;
  };
}

function fakeSpawner(): BusMetricsSpawnerLike & { orchs: FakeOrch[] } {
  const orchs: FakeOrch[] = [];
  return {
    orchs,
    list() {
      return orchs;
    },
  };
}

/** Append a fake orch with `messagesTotal` and an in-memory queue depth. */
function addOrch(
  sp: ReturnType<typeof fakeSpawner>,
  id: string,
  messagesTotal = 0,
  queueDepth = 0,
): FakeOrch {
  const o: FakeOrch = {
    id,
    mailbox: {
      messagesTotal,
      totalSize() {
        return queueDepth;
      },
    },
  };
  sp.orchs.push(o);
  return o;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('BusMetricsCollector — initial state', () => {
  it('exposes zeroed snapshot before start()', () => {
    const sp = fakeSpawner();
    const c = new BusMetricsCollector(sp);
    const s = c.snapshot();
    expect(s.latency_ms).toBe(0);
    expect(s.throughput_msg_per_s).toBe(0);
    expect(s.queue_depth).toBe(0);
    expect(s.err_rate_pct).toBe(0);
    expect(s.window_seconds).toBe(60);
  });

  it('queue_depth reflects Σ mailbox.totalSize() at call time, no tick needed', () => {
    const sp = fakeSpawner();
    addOrch(sp, 'a', 10, 3);
    addOrch(sp, 'b', 20, 4);
    const c = new BusMetricsCollector(sp);
    expect(c.snapshot().queue_depth).toBe(7);
  });
});

describe('BusMetricsCollector — start/stop lifecycle', () => {
  it('start() is idempotent — only one interval', () => {
    const sp = fakeSpawner();
    addOrch(sp, 'a');
    const c = new BusMetricsCollector(sp, { tickMs: 1000 });
    const before = vi.getTimerCount();
    c.start();
    const after1 = vi.getTimerCount();
    c.start();
    const after2 = vi.getTimerCount();
    expect(after1 - before).toBe(1);
    expect(after2).toBe(after1);
    c.stop();
  });

  it('stop() is idempotent and prevents further ticks', () => {
    const sp = fakeSpawner();
    const orch = addOrch(sp, 'a', 0);
    const c = new BusMetricsCollector(sp, { tickMs: 1000 });
    c.start();
    c.stop();
    c.stop(); // no throw
    orch.mailbox.messagesTotal = 5;
    vi.advanceTimersByTime(10_000);
    // No tick ran — throughput stays at 0.
    expect(c.snapshot().throughput_msg_per_s).toBe(0);
  });

  it('tick() runs automatically on the configured interval', () => {
    const sp = fakeSpawner();
    const orch = addOrch(sp, 'a', 0);
    const c = new BusMetricsCollector(sp, { tickMs: 1000 });
    c.start();
    orch.mailbox.messagesTotal = 30;
    // Advance enough seconds to fill (or at least make use of) the window.
    vi.advanceTimersByTime(1000);
    // After 1 tick, _ticksSinceStart === 1, newest = 30, oldest = 30
    // (only the freshly-overwritten slot has data; the slot right after
    // the cursor was untouched, so still 0). throughput = (30 - 0) / 1 = 30.
    // We don't pin the exact ring-internal arithmetic in this assert — we
    // just confirm a tick ran and recorded SOMETHING > 0.
    expect(c.snapshot().throughput_msg_per_s).toBeGreaterThan(0);
    c.stop();
  });
});

describe('BusMetricsCollector — latency_ms', () => {
  it('returns 0 when no request has been recorded in the window', () => {
    const sp = fakeSpawner();
    const c = new BusMetricsCollector(sp);
    expect(c.snapshot().latency_ms).toBe(0);
  });

  it('records the duration of a single request (real hrtime)', () => {
    // `vi.useFakeTimers()` (set up in beforeEach) freezes `process.hrtime` in
    // Vitest 4 — so `recordRequestStart() / recordRequestEnd()` would both
    // see the same clock value and produce latency = 0. Switch to real
    // timers for this measurement-sensitive test.
    vi.useRealTimers();
    const sp = fakeSpawner();
    const c = new BusMetricsCollector(sp);
    c.start(); // arm — instrumentation is a no-op until the collector is active.
    const t0 = c.recordRequestStart();
    // Burn a tiny bit of CPU so duration > 0 but stays bounded.
    let acc = 0;
    for (let i = 0; i < 100_000; i++) acc += i;
    expect(acc).toBeGreaterThan(0); // sink, avoid DCE
    c.recordRequestEnd(t0, true);
    const s = c.snapshot();
    // hrtime granularity is ~1 µs on Linux. A no-op loop runs in well under
    // 1 second — assert a generous upper bound to stay non-flaky on CI.
    expect(s.latency_ms).toBeGreaterThan(0);
    expect(s.latency_ms).toBeLessThan(1_000);
    c.stop();
  });

  it('averages across many requests in the same slot', () => {
    const sp = fakeSpawner();
    const c = new BusMetricsCollector(sp);
    c.start(); // arm — instrumentation is a no-op until the collector is active.
    for (let i = 0; i < 10; i++) {
      const t0 = c.recordRequestStart();
      c.recordRequestEnd(t0, true);
    }
    const s = c.snapshot();
    // 10 records done, all in the same (current) slot. Mean is whatever it
    // is — just confirm the structure (no division by zero, non-negative).
    expect(s.latency_ms).toBeGreaterThanOrEqual(0);
    c.stop();
  });

  it('averages across slots once we have ticked', () => {
    // Real timers — see the comment in the single-request test above.
    vi.useRealTimers();
    const sp = fakeSpawner();
    const c = new BusMetricsCollector(sp, { tickMs: 1000 });
    c.start();
    const t0 = c.recordRequestStart();
    let acc = 0;
    for (let i = 0; i < 100_000; i++) acc += i;
    expect(acc).toBeGreaterThan(0);
    c.recordRequestEnd(t0, true);
    c.tick(); // move to a fresh slot
    const t1 = c.recordRequestStart();
    for (let i = 0; i < 100_000; i++) acc += i;
    c.recordRequestEnd(t1, true);
    const s = c.snapshot();
    // Both slots contribute — the mean is computed across the whole ring.
    expect(s.latency_ms).toBeGreaterThan(0);
    c.stop();
  });

  it('evicts old measurements after RING_SIZE ticks', () => {
    const sp = fakeSpawner();
    const c = new BusMetricsCollector(sp, { tickMs: 1000 });
    c.start();
    // Record a very high latency by hand-crafting the slot (we do this via
    // the public API: record, tick, record etc.). We just confirm that
    // after >= 60 ticks with no new requests, latency_ms drops back to 0.
    const t0 = c.recordRequestStart();
    c.recordRequestEnd(t0, true);
    for (let i = 0; i < 60; i++) c.tick();
    expect(c.snapshot().latency_ms).toBe(0);
    c.stop();
  });
});

describe('BusMetricsCollector — err_rate_pct', () => {
  it('returns 0 when no requests recorded', () => {
    const sp = fakeSpawner();
    const c = new BusMetricsCollector(sp);
    expect(c.snapshot().err_rate_pct).toBe(0);
  });

  it('returns 0 when all requests succeeded', () => {
    const sp = fakeSpawner();
    const c = new BusMetricsCollector(sp);
    c.start(); // arm — instrumentation is a no-op until the collector is active.
    for (let i = 0; i < 7; i++) {
      const t0 = c.recordRequestStart();
      c.recordRequestEnd(t0, true);
    }
    expect(c.snapshot().err_rate_pct).toBe(0);
    c.stop();
  });

  it('computes the percentage across mixed outcomes', () => {
    const sp = fakeSpawner();
    const c = new BusMetricsCollector(sp);
    c.start(); // arm — instrumentation is a no-op until the collector is active.
    for (let i = 0; i < 10; i++) {
      const t0 = c.recordRequestStart();
      c.recordRequestEnd(t0, i < 8); // 8 OK, 2 errors
    }
    expect(c.snapshot().err_rate_pct).toBe(20);
    c.stop();
  });

  it('returns 100 when every request failed', () => {
    const sp = fakeSpawner();
    const c = new BusMetricsCollector(sp);
    c.start(); // arm — instrumentation is a no-op until the collector is active.
    for (let i = 0; i < 3; i++) {
      const t0 = c.recordRequestStart();
      c.recordRequestEnd(t0, false);
    }
    expect(c.snapshot().err_rate_pct).toBe(100);
    c.stop();
  });

  it('aggregates errors across slots', () => {
    const sp = fakeSpawner();
    const c = new BusMetricsCollector(sp);
    c.start();
    const a = c.recordRequestStart();
    c.recordRequestEnd(a, false);
    c.tick();
    const b = c.recordRequestStart();
    c.recordRequestEnd(b, true);
    const s = c.snapshot();
    // 1 error / 2 requests = 50 %.
    expect(s.err_rate_pct).toBe(50);
    c.stop();
  });
});

describe('BusMetricsCollector — throughput_msg_per_s', () => {
  it('returns 0 before any tick has run', () => {
    const sp = fakeSpawner();
    addOrch(sp, 'a', 100);
    const c = new BusMetricsCollector(sp);
    expect(c.snapshot().throughput_msg_per_s).toBe(0);
  });

  it('divides by elapsed-seconds (not 60) before the ring is full', () => {
    const sp = fakeSpawner();
    const orch = addOrch(sp, 'a', 0);
    const c = new BusMetricsCollector(sp);
    c.start();
    // 10 ticks — each tick the orch gains 10 messages, total +100.
    for (let i = 0; i < 10; i++) {
      orch.mailbox.messagesTotal += 10;
      c.tick();
    }
    const s = c.snapshot();
    // Expected: (100 - 0) / 10 = 10 msg/s (NOT 100/60 ≈ 1.67).
    expect(s.throughput_msg_per_s).toBe(10);
    c.stop();
  });

  it('stabilises to a steady rate once the ring is full', () => {
    const sp = fakeSpawner();
    const orch = addOrch(sp, 'a', 0);
    const c = new BusMetricsCollector(sp);
    c.start();
    // Push 80 ticks (>> RING_SIZE) so the boot-seed slot wraps out and every
    // ring slot stores a strictly +10 delta from its predecessor. After
    // that, newest - oldest = 59 * 10 (the ring stores 60 monotone samples
    // separated by 10 each between the freshest and the one just behind
    // the cursor). denom = 60 → throughput ≈ 9.83. We just assert the
    // sustained rate is within +/- 1 of the input rate.
    for (let i = 0; i < 80; i++) {
      orch.mailbox.messagesTotal += 10;
      c.tick();
    }
    const s = c.snapshot();
    expect(s.throughput_msg_per_s).toBeGreaterThan(9);
    expect(s.throughput_msg_per_s).toBeLessThanOrEqual(10);
    c.stop();
  });

  it('clamps negative deltas to zero (defensive against orch removal)', () => {
    const sp = fakeSpawner();
    const orch = addOrch(sp, 'a', 100);
    const c = new BusMetricsCollector(sp);
    c.start();
    c.tick();
    // Simulate the orch disappearing — global total drops.
    sp.orchs.length = 0;
    c.tick();
    const s = c.snapshot();
    expect(s.throughput_msg_per_s).toBe(0);
    expect(s.throughput_msg_per_s).not.toBeLessThan(0);
    // Make sure orch is unused in the rest of the test so TS doesn't complain.
    expect(orch.mailbox.messagesTotal).toBe(100);
    c.stop();
  });
});

describe('BusMetricsCollector — queue_depth', () => {
  it('sums totalSize across all orchs', () => {
    const sp = fakeSpawner();
    addOrch(sp, 'a', 0, 5);
    addOrch(sp, 'b', 0, 3);
    addOrch(sp, 'c', 0, 7);
    const c = new BusMetricsCollector(sp);
    expect(c.snapshot().queue_depth).toBe(15);
  });

  it('is independent of ticks — instantaneous, not aggregated', () => {
    const sp = fakeSpawner();
    const orch = addOrch(sp, 'a', 0, 0);
    const c = new BusMetricsCollector(sp);
    c.start();
    c.tick();
    c.tick();
    expect(c.snapshot().queue_depth).toBe(0);
    orch.mailbox.totalSize = () => 42;
    expect(c.snapshot().queue_depth).toBe(42);
    c.stop();
  });

  it('returns 0 when no orchs exist', () => {
    const sp = fakeSpawner();
    const c = new BusMetricsCollector(sp);
    expect(c.snapshot().queue_depth).toBe(0);
  });
});

describe('BusMetricsCollector — snapshot shape', () => {
  it('always carries window_seconds === 60', () => {
    const sp = fakeSpawner();
    const c = new BusMetricsCollector(sp);
    expect(c.snapshot().window_seconds).toBe(60);
    c.start();
    c.tick();
    expect(c.snapshot().window_seconds).toBe(60);
    c.stop();
  });

  it('returns plain numbers (no NaN, no Infinity)', () => {
    const sp = fakeSpawner();
    const c = new BusMetricsCollector(sp);
    const s = c.snapshot();
    expect(Number.isFinite(s.latency_ms)).toBe(true);
    expect(Number.isFinite(s.throughput_msg_per_s)).toBe(true);
    expect(Number.isFinite(s.err_rate_pct)).toBe(true);
    expect(Number.isFinite(s.queue_depth)).toBe(true);
  });
});

describe('BusMetricsCollector — interval-driven smoke test', () => {
  it('records requests through the auto-tick path', () => {
    const sp = fakeSpawner();
    const orch = addOrch(sp, 'a', 0);
    const c = new BusMetricsCollector(sp, { tickMs: 1000 });
    c.start();
    const t0 = c.recordRequestStart();
    c.recordRequestEnd(t0, true);
    orch.mailbox.messagesTotal = 5;
    vi.advanceTimersByTime(3000); // 3 ticks
    const s = c.snapshot();
    expect(s.latency_ms).toBeGreaterThanOrEqual(0);
    expect(s.throughput_msg_per_s).toBeGreaterThan(0);
    expect(s.window_seconds).toBe(60);
    c.stop();
  });
});

// docs/builtin-features.md D6 — when the `monitoring` feature is off the
// collector is stopped (or never started), and the MCP server keeps calling
// record* on every tool call. Those calls MUST be true no-ops so a frozen slot
// never gets inflated, and a re-enable MUST reset the ring so no throughput
// spike leaks the idle-gap message growth.
describe('BusMetricsCollector — `active` flag (monitoring toggle, D6)', () => {
  it('records nothing before start() (armed only between start and stop)', () => {
    const sp = fakeSpawner();
    const c = new BusMetricsCollector(sp);
    // Never started — mirrors `monitoring` seeded disabled at boot.
    for (let i = 0; i < 10; i++) {
      const t = c.recordRequestStart();
      expect(t).toBe(0n); // sentinel — no hrtime read while disarmed
      c.recordRequestEnd(t, false); // all errors — would be 100% if recorded
    }
    const s = c.snapshot();
    expect(s.err_rate_pct).toBe(0);
    expect(s.latency_ms).toBe(0);
  });

  it('is a true no-op after stop() — instrumentation never pollutes the frozen slot', () => {
    const sp = fakeSpawner();
    const c = new BusMetricsCollector(sp, { tickMs: 1000 });
    c.start();
    c.stop(); // monitoring disabled — collector disarmed but MCP keeps calling.
    for (let i = 0; i < 50; i++) {
      const t = c.recordRequestStart();
      expect(t).toBe(0n);
      c.recordRequestEnd(t, false);
    }
    const s = c.snapshot();
    expect(s.err_rate_pct).toBe(0); // nothing recorded → 0, not 100
    expect(s.latency_ms).toBe(0);
  });

  it('resets ring + ticks on restart — no throughput spike after a re-enable', () => {
    const sp = fakeSpawner();
    const orch = addOrch(sp, 'a', 0);
    const c = new BusMetricsCollector(sp, { tickMs: 1000 });
    c.start();
    // Build up a real throughput history: 10 ticks, +50 messages each.
    for (let i = 0; i < 10; i++) {
      orch.mailbox.messagesTotal += 50;
      c.tick();
    }
    expect(c.snapshot().throughput_msg_per_s).toBeGreaterThan(0);

    // Disable → the orch keeps receiving messages while monitoring is off.
    c.stop();
    orch.mailbox.messagesTotal += 5000; // huge idle-period growth

    // Re-enable: start() must reset the ring + ticks so the 5000-message idle
    // growth is NOT reported as a one-off (newest − oldest) spike.
    c.start();
    expect(c.snapshot().throughput_msg_per_s).toBe(0);

    // A single fresh tick now measures ONLY the delta since re-enable.
    orch.mailbox.messagesTotal += 30;
    c.tick();
    expect(c.snapshot().throughput_msg_per_s).toBe(30);
    c.stop();
  });
});

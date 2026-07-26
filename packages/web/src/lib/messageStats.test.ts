// S4 — Tests for `messageStats.ts` (frontend-only global stats).
//
// Two concerns:
//   1. The pure helpers (`sumMsgCount`, `computeGlobalMessageStats`) —
//      table-driven coverage of the math: total, delta clamping, ring
//      rotation, undefined-field tolerance.
//   2. The React hook `useGlobalMessageStats` — driven with fake timers
//      to verify the interval cadence, the snapshot-on-mount semantics
//      (first tick should yield 0 when the total hasn't moved), and the
//      cleanup on unmount.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { OrchestratorView } from '../api/client';
import {
  HISTORY_SIZE,
  DEFAULT_TICK_MS,
  computeGlobalMessageStats,
  emptyHistory,
  sumMsgCount,
  useGlobalMessageStats,
} from './messageStats';

/** Minimal fixture — only the fields the helpers actually read. */
function makeOrch(id: string, msgCount: number): OrchestratorView {
  return {
    id,
    name: id,
    role: 'worker',
    roleId: null,
    status: 'running',
    leadSessionId: null,
    defaultModel: 'sonnet',
    defaultEffort: 'medium',
    defaultPermissionMode: 'default',
    leadPreamble: null,
    workerPreamble: null,
    createdAt: '2025-01-01T00:00:00Z',
    endedAt: null,
    lastError: null,
    sessions: [],
    msgCount,
    health: 'ok',
    resumeCount: 0,
    lastResumedAt: null,
  };
}

describe('sumMsgCount', () => {
  it.each<{ name: string; counts: number[]; expected: number }>([
    { name: 'empty list', counts: [], expected: 0 },
    { name: 'single orch', counts: [42], expected: 42 },
    { name: 'three orchs', counts: [100, 200, 300], expected: 600 },
    { name: 'with zeros', counts: [0, 0, 5, 0], expected: 5 },
    { name: 'large values', counts: [1_000_000, 2_000_000], expected: 3_000_000 },
  ])('sums correctly: $name', ({ counts, expected }) => {
    const orchs = counts.map((c, i) => makeOrch(`o${i}`, c));
    expect(sumMsgCount(orchs)).toBe(expected);
  });

  it('tolerates a missing msgCount field (legacy/history rows)', () => {
    // Simulate a payload shape drift — strip the field on one entry.
    const a = makeOrch('a', 10);
    const b = makeOrch('b', 20);
    const stripped = { ...b } as Partial<OrchestratorView> as OrchestratorView;
    delete (stripped as { msgCount?: number }).msgCount;
    expect(sumMsgCount([a, stripped])).toBe(10);
  });
});

describe('computeGlobalMessageStats', () => {
  it('returns total = Σ msgCount with delta 0 on the first tick when nothing moved', () => {
    const orchs = [makeOrch('a', 100), makeOrch('b', 200), makeOrch('c', 300)];
    const stats = computeGlobalMessageStats(orchs, 600, emptyHistory());
    expect(stats.total).toBe(600);
    expect(stats.perMinute).toBe(0);
    expect(stats.history).toHaveLength(HISTORY_SIZE);
    expect(stats.history[HISTORY_SIZE - 1]).toBe(0);
  });

  it('computes a positive delta when total grows between snapshots', () => {
    const orchs = [makeOrch('a', 642)];
    const stats = computeGlobalMessageStats(orchs, 600, emptyHistory());
    expect(stats.total).toBe(642);
    expect(stats.perMinute).toBe(42);
    expect(stats.history[HISTORY_SIZE - 1]).toBe(42);
    // Older slots stay zero.
    expect(stats.history.slice(0, HISTORY_SIZE - 1).every((x) => x === 0)).toBe(true);
  });

  it('clamps a downward delta to 0 (e.g. orchestrator removed between snapshots)', () => {
    const orchs = [makeOrch('a', 50)];
    const stats = computeGlobalMessageStats(orchs, 200, emptyHistory());
    expect(stats.total).toBe(50);
    expect(stats.perMinute).toBe(0);
    expect(stats.history[HISTORY_SIZE - 1]).toBe(0);
  });

  it('rotates the ring buffer: oldest dropped, newest appended last', () => {
    // Seed a buffer where every slot is identifiable: [0,1,2,...,59].
    const seeded = Array.from({ length: HISTORY_SIZE }, (_, i) => i);
    const orchs = [makeOrch('a', 100)];
    const stats = computeGlobalMessageStats(orchs, 95, seeded);
    // delta = 5, appended last; oldest (`0`) dropped; everything else
    // shifted one slot to the left.
    expect(stats.history).toHaveLength(HISTORY_SIZE);
    expect(stats.history[HISTORY_SIZE - 1]).toBe(5);
    expect(stats.history[0]).toBe(1);
    expect(stats.history[HISTORY_SIZE - 2]).toBe(HISTORY_SIZE - 1);
  });

  it('pads with leading zeros when the supplied history is shorter than HISTORY_SIZE', () => {
    const stats = computeGlobalMessageStats([makeOrch('a', 10)], 7, [1, 2, 3]);
    expect(stats.history).toHaveLength(HISTORY_SIZE);
    expect(stats.history[HISTORY_SIZE - 1]).toBe(3); // newest delta
    expect(stats.history[HISTORY_SIZE - 2]).toBe(3);
    expect(stats.history[HISTORY_SIZE - 3]).toBe(2);
    expect(stats.history[HISTORY_SIZE - 4]).toBe(1);
    // Leading slots padded with 0.
    expect(stats.history[0]).toBe(0);
  });

  it('handles a long sequence of ticks correctly (rotation invariant after >60 cycles)', () => {
    // Drive 65 ticks where each tick adds exactly 1 message.
    let history = emptyHistory();
    let snapshot = 0;
    for (let i = 1; i <= 65; i++) {
      const orchs = [makeOrch('a', i)];
      const stats = computeGlobalMessageStats(orchs, snapshot, history);
      history = stats.history;
      snapshot = stats.total;
    }
    expect(history).toHaveLength(HISTORY_SIZE);
    // Every slot is a delta of 1 (the 5 oldest +0s were rotated out).
    expect(history.every((x) => x === 1)).toBe(true);
  });
});

describe('useGlobalMessageStats', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns total + zero history on mount', () => {
    vi.useFakeTimers();
    const orchs = [makeOrch('a', 100), makeOrch('b', 200)];
    const { result } = renderHook(() => useGlobalMessageStats(orchs));
    expect(result.current.total).toBe(300);
    expect(result.current.perMinute).toBe(0);
    expect(result.current.history).toHaveLength(HISTORY_SIZE);
    expect(result.current.history.every((x) => x === 0)).toBe(true);
  });

  it('first tick yields delta=0 when the total has not changed since mount', () => {
    vi.useFakeTimers();
    const orchs = [makeOrch('a', 600)];
    const { result } = renderHook(() => useGlobalMessageStats(orchs));
    act(() => {
      vi.advanceTimersByTime(DEFAULT_TICK_MS);
    });
    expect(result.current.perMinute).toBe(0);
    expect(result.current.history[HISTORY_SIZE - 1]).toBe(0);
  });

  it('captures the delta on the next tick when orchestrator msgCount grows', () => {
    vi.useFakeTimers();
    const initial = [makeOrch('a', 600)];
    const { result, rerender } = renderHook(
      ({ orchs }: { orchs: OrchestratorView[] }) => useGlobalMessageStats(orchs),
      { initialProps: { orchs: initial } },
    );
    expect(result.current.total).toBe(600);

    // Total moves between ticks — the next tick should record +42.
    rerender({ orchs: [makeOrch('a', 642)] });
    expect(result.current.total).toBe(642);
    expect(result.current.perMinute).toBe(0); // no tick yet

    act(() => {
      vi.advanceTimersByTime(DEFAULT_TICK_MS);
    });
    expect(result.current.perMinute).toBe(42);
    expect(result.current.history[HISTORY_SIZE - 1]).toBe(42);
  });

  it('rotates the ring buffer correctly over 65 consecutive ticks', () => {
    vi.useFakeTimers();
    let orchs = [makeOrch('a', 0)];
    const { result, rerender } = renderHook(
      ({ o }: { o: OrchestratorView[] }) => useGlobalMessageStats(o),
      { initialProps: { o: orchs } },
    );

    // At each step: bump msgCount by 1, then advance one tick.
    for (let i = 1; i <= 65; i++) {
      orchs = [makeOrch('a', i)];
      rerender({ o: orchs });
      act(() => {
        vi.advanceTimersByTime(DEFAULT_TICK_MS);
      });
    }

    expect(result.current.history).toHaveLength(HISTORY_SIZE);
    expect(result.current.history.every((x) => x === 1)).toBe(true);
    expect(result.current.perMinute).toBe(1);
    expect(result.current.total).toBe(65);
  });

  it('honors a custom tick interval', () => {
    vi.useFakeTimers();
    const initial = [makeOrch('a', 0)];
    const { result, rerender } = renderHook(
      ({ orchs }: { orchs: OrchestratorView[] }) => useGlobalMessageStats(orchs, 1_000),
      { initialProps: { orchs: initial } },
    );
    rerender({ orchs: [makeOrch('a', 7)] });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current.perMinute).toBe(7);
  });

  it('clears its interval on unmount (no orphan ticks)', () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useGlobalMessageStats([makeOrch('a', 0)]));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    // Sanity: advancing post-unmount must not throw or update state.
    act(() => {
      vi.advanceTimersByTime(DEFAULT_TICK_MS * 5);
    });
  });
});

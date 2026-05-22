// S6 — `useNow` hook tests.
//
// Verifies the hook returns a fresh `Date.now()` on mount and re-renders
// the consumer at the configured cadence. We use `renderHook` from
// `@testing-library/react` with fake timers so the test is fully
// deterministic.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useNow } from './useNow';

describe('useNow', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a recent timestamp on first render', () => {
    vi.useFakeTimers();
    const t0 = new Date('2025-06-01T00:00:00.000Z').getTime();
    vi.setSystemTime(t0);
    const { result } = renderHook(() => useNow());
    expect(result.current).toBe(t0);
  });

  it('re-renders with an updated value at every interval tick', () => {
    vi.useFakeTimers();
    const t0 = new Date('2025-06-01T00:00:00.000Z').getTime();
    vi.setSystemTime(t0);
    const { result } = renderHook(() => useNow(5_000));
    expect(result.current).toBe(t0);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current).toBe(t0 + 5_000);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current).toBe(t0 + 10_000);
  });

  it('honors a custom interval', () => {
    vi.useFakeTimers();
    const t0 = new Date('2025-06-01T00:00:00.000Z').getTime();
    vi.setSystemTime(t0);
    const { result } = renderHook(() => useNow(1_000));

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current).toBe(t0 + 1_000);
  });

  it('cleans up its interval on unmount (no orphan ticks)', () => {
    vi.useFakeTimers();
    const t0 = new Date('2025-06-01T00:00:00.000Z').getTime();
    vi.setSystemTime(t0);
    const { result, unmount } = renderHook(() => useNow(5_000));
    expect(result.current).toBe(t0);

    unmount();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    // No assertion on `result.current` post-unmount — what matters is
    // that no orphan setInterval keeps firing. The `getTimerCount`
    // assertion below catches that directly.
    expect(vi.getTimerCount()).toBe(0);
  });
});

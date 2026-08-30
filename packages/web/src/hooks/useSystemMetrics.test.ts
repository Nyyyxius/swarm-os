/**
 * Monitoring Lot 10 — `useSystemMetrics`.
 *
 * Three properties, all of them about restraint rather than about fetching:
 *
 *   1. It does NOT poll while disabled. `MonitoringPage` is always mounted and
 *      renders null when closed, so a hook that ignored `enabled` would hit
 *      the server every 3 s behind every other screen, forever.
 *   2. A dead endpoint (a server predating Lot 10 → 404 on every tick) warns
 *      ONCE, not 1 200 times an hour. A console nobody can read is a console
 *      nobody reads.
 *   3. A failed tick keeps the last real snapshot instead of blanking the
 *      gauges — one dropped request during a redeploy should not make the KPI
 *      band flicker to `—` and back.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useSystemMetrics } from './useSystemMetrics';
import { api, HttpError, type SystemMetricsSnapshot } from '../api/client';

function snapshot(over: Partial<SystemMetricsSnapshot> = {}): SystemMetricsSnapshot {
  return {
    cpu: { pct: 0.35, cores: 4, basis: 'cgroup' },
    memory: {
      usedBytes: 6.2 * 1024 ** 3,
      limitBytes: 8 * 1024 ** 3,
      pct: 0.775,
      basis: 'cgroup',
    },
    ...over,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useSystemMetrics', () => {
  it('fetches immediately and hands the snapshot straight through', async () => {
    const spy = vi.spyOn(api, 'getMetricsSystem').mockResolvedValue(snapshot());
    const { result } = renderHook(() => useSystemMetrics(3_000));

    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.current?.cpu.pct).toBe(0.35);
    expect(result.current?.memory.basis).toBe('cgroup');
  });

  it('does not fetch AT ALL while disabled', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(api, 'getMetricsSystem').mockResolvedValue(snapshot());
    const { result } = renderHook(() => useSystemMetrics(3_000, false));

    await vi.advanceTimersByTimeAsync(30_000);
    expect(spy).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it('starts polling when the page opens and stops when it closes', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(api, 'getMetricsSystem').mockResolvedValue(snapshot());
    const { rerender } = renderHook(
      ({ on }: { on: boolean }) => useSystemMetrics(3_000, on),
      { initialProps: { on: false } },
    );
    expect(spy).not.toHaveBeenCalled();

    rerender({ on: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(spy).toHaveBeenCalledTimes(3);

    // Closing the page must clear the interval, not merely ignore its results.
    rerender({ on: false });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('stops polling on unmount', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(api, 'getMetricsSystem').mockResolvedValue(snapshot());
    const { unmount } = renderHook(() => useSystemMetrics(3_000));
    await vi.advanceTimersByTimeAsync(0);
    unmount();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('stays null and silent-ish on a 404 — warning once, not every tick', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const spy = vi.spyOn(api, 'getMetricsSystem').mockRejectedValue(
      new HttpError('HTTP 404 GET /metrics/system', 404, null),
    );
    const { result } = renderHook(() => useSystemMetrics(3_000));

    await vi.advanceTimersByTimeAsync(30_000);
    expect(spy.mock.calls.length).toBeGreaterThan(5);
    // The gauges render `—` from a null snapshot; no zeros are invented.
    expect(result.current).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good snapshot through a transient failure', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const spy = vi.spyOn(api, 'getMetricsSystem').mockResolvedValue(snapshot());
    const { result } = renderHook(() => useSystemMetrics(3_000));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current?.cpu.pct).toBe(0.35);

    spy.mockRejectedValueOnce(new Error('network blip'));
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(result.current?.cpu.pct).toBe(0.35);
  });

  it('passes nulls through untouched — never defaulting a missing reading to 0', async () => {
    vi.spyOn(api, 'getMetricsSystem').mockResolvedValue(snapshot({
      cpu: { pct: null, cores: 4, basis: 'host' },
    }));
    const { result } = renderHook(() => useSystemMetrics(3_000));
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.cpu.pct).toBeNull();
    expect(result.current?.cpu.basis).toBe('host');
  });
});

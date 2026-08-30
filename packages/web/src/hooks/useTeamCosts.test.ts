/**
 * Monitoring Lot 12 — `useTeamCosts`.
 *
 * Same three properties as `useSystemMetrics`, for the same reasons, on a
 * slower cadence: it must not poll while the page is closed (the overlay is
 * always mounted), a server predating Lot 12 must not fill the console with
 * one 404 per tick, and a dropped request must not blank a section the
 * operator is reading.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useTeamCosts } from './useTeamCosts';
import { api, HttpError, type TeamCostsSnapshot } from '../api/client';

function snapshot(costUsd: number | null = 12.5): TeamCostsSnapshot {
  return {
    teams: [{
      orchId: 'o1',
      name: 'ATLAS',
      live: 3,
      total: { in: 1_000, out: 200, cacheRead: 4_000, cacheWrite: 100, costUsd },
      removed: { count: 2, costUsd: 1.25 },
      burnPerHour: 1.84,
    }],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useTeamCosts', () => {
  it('fetches immediately and hands the snapshot straight through', async () => {
    const spy = vi.spyOn(api, 'getMetricsCosts').mockResolvedValue(snapshot());
    const { result } = renderHook(() => useTeamCosts(15_000));

    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.current?.teams[0]?.burnPerHour).toBe(1.84);
  });

  it('does not fetch AT ALL while disabled', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(api, 'getMetricsCosts').mockResolvedValue(snapshot());
    const { result } = renderHook(() => useTeamCosts(15_000, false));

    await vi.advanceTimersByTimeAsync(120_000);
    expect(spy).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it('starts on open and stops on close', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(api, 'getMetricsCosts').mockResolvedValue(snapshot());
    const { rerender } = renderHook(
      ({ on }: { on: boolean }) => useTeamCosts(15_000, on),
      { initialProps: { on: false } },
    );
    expect(spy).not.toHaveBeenCalled();

    rerender({ on: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spy).toHaveBeenCalledTimes(3);

    rerender({ on: false });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('stops polling on unmount', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(api, 'getMetricsCosts').mockResolvedValue(snapshot());
    const { unmount } = renderHook(() => useTeamCosts(15_000));
    await vi.advanceTimersByTimeAsync(0);
    unmount();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('warns ONCE on a dead endpoint, not on every tick', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const spy = vi.spyOn(api, 'getMetricsCosts').mockRejectedValue(
      new HttpError('HTTP 404 GET /metrics/costs', 404, null),
    );
    const { result } = renderHook(() => useTeamCosts(15_000));

    await vi.advanceTimersByTimeAsync(120_000);
    expect(spy.mock.calls.length).toBeGreaterThan(5);
    // The section renders `— no cost data yet —` from a null snapshot.
    expect(result.current).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good snapshot through a transient failure', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const spy = vi.spyOn(api, 'getMetricsCosts').mockResolvedValue(snapshot());
    const { result } = renderHook(() => useTeamCosts(15_000));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current?.teams).toHaveLength(1);

    spy.mockRejectedValueOnce(new Error('network blip'));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(result.current?.teams).toHaveLength(1);
  });

  it('passes a null cost through untouched — never defaulting it to 0', async () => {
    vi.spyOn(api, 'getMetricsCosts').mockResolvedValue(snapshot(null));
    const { result } = renderHook(() => useTeamCosts(15_000));
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.teams[0]?.total.costUsd).toBeNull();
  });
});

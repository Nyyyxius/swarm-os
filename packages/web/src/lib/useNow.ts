// S6 — `useNow` hook.
//
// Returns `Date.now()` and re-renders the calling component on a steady
// interval. Used by `StatusBadge` (and other ambient indicators) to drive
// derived UI state that depends on the *current* time rather than on a
// server event — most notably the `running → idle` transition in
// `enrichWithIdle`.
//
// We keep this in `lib/` rather than `hooks/` because (a) the consumers
// pulling it in already import `sessionStatus` from `lib/`, and (b) the
// hook is purely time-based — no API, no transport — so it sits closer to
// the pure helpers than to the data-fetching `useEvents`/`useSession`
// family.
//
// Cost: one `setInterval` per mounted consumer. For the current single
// `OrchestratorView` mount with ~5-20 visible session badges, two
// re-renders per second total is negligible. If/when a list view ever
// renders hundreds of badges, hoist the hook once at the page level and
// pass `now` down.

import { useEffect, useState } from 'react';

/**
 * Subscribes to the wall clock and re-renders every `intervalMs`. Default
 * cadence is 5 s — fast enough that the idle transition feels prompt at a
 * 30 s threshold (≤5 s of jitter, imperceptible), slow enough to avoid
 * burning re-renders.
 */
export function useNow(intervalMs: number = 5_000): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    // Set immediately on (re)mount so a remounted consumer doesn't keep a
    // stale `now` from a previous instance.
    setNow(Date.now());
    const t = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

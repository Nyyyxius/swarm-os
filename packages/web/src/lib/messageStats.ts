// S4 — Global message-flow stats (frontend-only, v1 low-effort).
//
// Aggregates the per-orchestrator `msgCount` field (introduced by S1) into
// the three numbers required by the desktop LeftPanel `MESSAGE FLOW`
// section (cf. `docs/update_system/04_compteur_global_messages.md`):
//
//   - `total`     : sum of `msgCount` across all live orchestrators.
//   - `perMinute` : delta of `total` between two consecutive 60 s ticks.
//   - `history`   : ring buffer of the last 60 deltas (one per minute).
//
// IMPORTANT — persistence:
//   The 60-entry ring buffer lives **purely in client memory** (React
//   `useState`). It is reset to all-zeros every time the React tree
//   unmounts or the browser tab is reloaded. The big `total` number
//   recovers immediately (it is a pure reduce over the latest
//   `/orchestrators` payload), but the sparkline will visually fill back
//   up over the next 60 minutes. This is an explicit trade-off vs the v2
//   server-side aggregator (see §3 of the design doc); the operator UI
//   makes it clear by the gradient fading from empty.
//
// Server-state expectation: every `OrchestratorView` exposes a monotone
// `msgCount` (S1). The helpers below clamp negative deltas to 0 so a
// transient race (e.g. orchestrator removed from the list between two
// snapshots) cannot inject a spurious downward spike.

import { useEffect, useRef, useState } from 'react';
import type { OrchestratorView } from '../api/client';

/** Number of entries kept in the rolling history (one per tick). */
export const HISTORY_SIZE = 60;

/** Default tick cadence — one snapshot per minute. */
export const DEFAULT_TICK_MS = 60_000;

export interface GlobalMessageStats {
  /** Σ of `msgCount` across the supplied orchestrators. */
  total: number;
  /** Delta between the two most recent ticks (clamped to ≥ 0). */
  perMinute: number;
  /** Ring buffer of the last `HISTORY_SIZE` per-tick deltas (oldest first). */
  history: number[];
}

/**
 * Sum the `msgCount` of every orchestrator in the snapshot. Tolerant to
 * the field being undefined (history rows recovered from SQLite expose
 * `0` per S1, but this guards against any other shape drift).
 */
export function sumMsgCount(orchestrators: readonly OrchestratorView[]): number {
  let acc = 0;
  for (const o of orchestrators) acc += o.msgCount ?? 0;
  return acc;
}

/**
 * Pure helper — given the current orchestrators list, the previous
 * snapshot total, and the previous history buffer, return the new stats
 * **as if a tick had just fired**. Exposed so callers (e.g. tests, or a
 * future scheduler) can drive the rotation deterministically without
 * relying on the React hook.
 *
 * The returned `history` is always exactly `HISTORY_SIZE` long; the
 * oldest entry is dropped and the freshly computed delta is appended at
 * the end (newest last).
 */
export function computeGlobalMessageStats(
  orchestrators: readonly OrchestratorView[],
  prevSnapshotTotal: number,
  prevHistory: readonly number[],
): GlobalMessageStats {
  const total = sumMsgCount(orchestrators);
  const delta = Math.max(0, total - prevSnapshotTotal);
  const trimmed = prevHistory.slice(Math.max(0, prevHistory.length - (HISTORY_SIZE - 1)));
  const padded =
    trimmed.length < HISTORY_SIZE - 1
      ? new Array(HISTORY_SIZE - 1 - trimmed.length).fill(0).concat(trimmed)
      : trimmed;
  const history = [...padded, delta];
  return { total, perMinute: delta, history };
}

/**
 * Create an initial all-zeros history buffer. Helper exported for tests
 * and consumers that want to seed their own state without hard-coding
 * the size.
 */
export function emptyHistory(): number[] {
  return new Array(HISTORY_SIZE).fill(0);
}

/**
 * React hook — wraps `computeGlobalMessageStats` with the ring-buffer
 * state management and a `setInterval` tick.
 *
 * Behaviour:
 *  - `total` is recomputed on every render (cheap O(N) reduce) — the
 *    big number on the LeftPanel updates the instant `useOrchestrators`
 *    re-polls (every 3 s).
 *  - The ring buffer rotates on a `setInterval(intervalMs)` schedule.
 *    Each tick reads the *latest* total via a ref (so the interval is
 *    created exactly once on mount), computes the delta vs the previous
 *    tick's snapshot, and shifts the buffer.
 *  - `perMinute` is the last entry of the buffer (== the most recent
 *    delta). It stays at `0` until the first tick fires.
 *
 * The history is **not** persisted across reloads — see the file
 * preamble. Callers wanting persistence should switch to the v2
 * server-side aggregator described in the design doc.
 *
 * @param orchestrators current orchestrator snapshot, typically from
 *                      `useOrchestrators()`.
 * @param intervalMs    tick cadence in ms (default 60 000). Exposed for
 *                      tests; production callers should rely on the
 *                      default to match the `+N/min` semantics.
 */
export function useGlobalMessageStats(
  orchestrators: readonly OrchestratorView[],
  intervalMs: number = DEFAULT_TICK_MS,
): GlobalMessageStats {
  const total = sumMsgCount(orchestrators);

  // Mirror `total` into a ref so the interval callback always reads the
  // freshest value without us recreating the interval on every render.
  const totalRef = useRef<number>(total);
  useEffect(() => {
    totalRef.current = total;
  }, [total]);

  // Initial snapshot = current total. First tick therefore yields
  // `delta === 0` (cf. §7.5 of the design doc, recommendation "b"): we
  // only ever measure the last 60 s, never an unbounded historical sum.
  const lastSnapshotRef = useRef<number>(total);
  const [history, setHistory] = useState<number[]>(emptyHistory);

  useEffect(() => {
    const id = setInterval(() => {
      const t = totalRef.current;
      const delta = Math.max(0, t - lastSnapshotRef.current);
      lastSnapshotRef.current = t;
      setHistory((prev) => {
        const next = prev.slice(1);
        next.push(delta);
        return next;
      });
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  const perMinute = history[history.length - 1] ?? 0;
  return { total, perMinute, history };
}

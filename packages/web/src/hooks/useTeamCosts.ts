import { useEffect, useRef, useState } from 'react';
import { api, apiErrorMessage, HttpError, type TeamCostsSnapshot } from '../api/client';

/**
 * Poll `GET /metrics/costs` every `intervalMs` while `enabled`
 * (docs/monitoring-agents.md § Lot 12). Returns the latest successful
 * snapshot, or `null` until the first one lands.
 *
 * Structurally `useSystemMetrics`, down to the failure policy — same gate,
 * same warn-once, same "keep the last snapshot" rule — for the same reasons:
 * `MonitoringPage` is always mounted, and a server predating Lot 12 answers
 * 404 on every single tick.
 *
 * What differs is the CADENCE: 15 s, not the gauges' 3 s. These numbers are
 * cumulative SQL aggregates over the whole session table, hidden rows
 * included; they move slowly by construction, and nothing an operator decides
 * from a bill changes in three seconds. The cheaper poll is the point, not a
 * compromise.
 *
 * The per-team ventilation behind an expanded row is deliberately NOT part of
 * this hook: it is fetched once on expand by the section itself. Polling a
 * list of dead workers whose counters are frozen would be pure noise.
 */
export function useTeamCosts(
  intervalMs: number,
  enabled = true,
): TeamCostsSnapshot | null {
  const [snap, setSnap] = useState<TeamCostsSnapshot | null>(null);
  const cancelledRef = useRef(false);
  const warnedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    cancelledRef.current = false;
    const fetchOnce = async () => {
      try {
        const s = await api.getMetricsCosts();
        if (!cancelledRef.current) {
          setSnap(s);
          // The endpoint answered: a LATER outage is news again.
          warnedRef.current = false;
        }
      } catch (err) {
        // 404 = the endpoint is GONE (monitoring off, or a server predating
        // Lot 12). Blank the section rather than freezing dead totals (patron
        // `useMemoryNotes`); a transient non-404 keeps the last read.
        if (err instanceof HttpError && err.status === 404 && !cancelledRef.current) {
          setSnap(null);
        }
        if (!warnedRef.current) {
          warnedRef.current = true;
          console.warn(
            `[monitoring] team costs unavailable: ${apiErrorMessage(err)}`,
          );
        }
      }
    };
    void fetchOnce();
    const t = setInterval(() => void fetchOnce(), intervalMs);
    return () => {
      cancelledRef.current = true;
      clearInterval(t);
    };
  }, [intervalMs, enabled]);

  return snap;
}

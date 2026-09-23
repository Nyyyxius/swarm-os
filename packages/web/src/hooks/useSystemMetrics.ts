import { useEffect, useRef, useState } from 'react';
import { api, apiErrorMessage, HttpError, type SystemMetricsSnapshot } from '../api/client';

/**
 * Poll `GET /metrics/system` every `intervalMs` while `enabled`
 * (docs/monitoring-agents.md § Lot 10). Returns the latest successful
 * snapshot, or `null` until the first one lands.
 *
 * Structure is `useBusHealth`'s, with the `enabled` gate the page-scoped
 * hooks already carry (`useApprovals(orchId, 5000, open)`). The gate is not a
 * nicety here: `MonitoringPage` is ALWAYS mounted and renders `null` while
 * closed, so an ungated poll would hit the server every 3 s behind every
 * other screen in the app, forever.
 *
 * Failure policy — silent `—`, never a toast, never a retreat to zero:
 * a server built before Lot 10 has no such route and answers 404 on every
 * single tick. At 3 s that is 1 200 identical console lines an hour, which is
 * how a console stops being read at all. So the warning fires ONCE per mount
 * and the rest are swallowed; `errorRef` also lets a recovered endpoint
 * (server redeployed under a page left open) warn again if it breaks later.
 *
 * A failed tick keeps the previous snapshot rather than blanking the gauges:
 * one dropped request during a redeploy should not make the band flicker to
 * `—` and back. The snapshot is only ever replaced by a newer real one.
 */
export function useSystemMetrics(
  intervalMs: number,
  enabled = true,
): SystemMetricsSnapshot | null {
  const [snap, setSnap] = useState<SystemMetricsSnapshot | null>(null);
  const cancelledRef = useRef(false);
  const warnedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    cancelledRef.current = false;
    const fetchOnce = async () => {
      try {
        const s = await api.getMetricsSystem();
        if (!cancelledRef.current) {
          setSnap(s);
          // The endpoint answered: a LATER outage is news again.
          warnedRef.current = false;
        }
      } catch (err) {
        // 404 = the endpoint is GONE (monitoring off, or a server predating
        // Lot 10). Blank the gauges rather than freezing on dead numbers
        // (patron `useMemoryNotes`); a transient non-404 keeps the last read.
        if (err instanceof HttpError && err.status === 404 && !cancelledRef.current) {
          setSnap(null);
        }
        if (!warnedRef.current) {
          warnedRef.current = true;
          console.warn(
            `[monitoring] system metrics unavailable: ${apiErrorMessage(err)}`,
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

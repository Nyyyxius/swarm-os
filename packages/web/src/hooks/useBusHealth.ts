import { useEffect, useRef, useState } from 'react';
import { api, HttpError, type BusMetricsSnapshot } from '../api/client';

/**
 * Poll `/metrics/bus` every `intervalMs` while `enabled`. Returns the latest
 * successful snapshot, or `null` until the first response arrives.
 *
 * Two error policies, split by status (patron `useMemoryNotes`):
 *   - **404** — the monitoring surface is absent (disabled feature, or a
 *     server built without `BusMetricsCollector`). The snapshot is BLANKED to
 *     `null` so the cells fall back to `—` rather than freezing on dead values.
 *   - **anything else** (transient 5xx, 401 expiring, network) — the previous
 *     snapshot is kept so one dropped tick does not flicker the grid.
 *
 * `enabled` (default `true`) cuts the poll entirely — the caller passes the
 * monitoring feature flag, so a disabled feature stops hitting a 404'd route
 * every 3 s. Extracted from LeftPanel so the desktop panel and the mobile
 * StatsSheet share one implementation (and one polling contract).
 */
export function useBusHealth(
  intervalMs: number,
  enabled = true,
): BusMetricsSnapshot | null {
  const [snap, setSnap] = useState<BusMetricsSnapshot | null>(null);
  const cancelledRef = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    cancelledRef.current = false;
    const fetchOnce = async () => {
      try {
        const s = await api.getMetricsBus();
        if (!cancelledRef.current) setSnap(s);
      } catch (err) {
        // 404 = surface gone → stop showing dead values; else keep previous.
        if (err instanceof HttpError && err.status === 404 && !cancelledRef.current) {
          setSnap(null);
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

import { useEffect, useRef, useState } from 'react';
import { api, type BusMetricsSnapshot } from '../api/client';

/**
 * Poll `/metrics/bus` every `intervalMs`. Returns the latest successful
 * snapshot, or `null` until the first response arrives. Tolerates errors
 * (404 if the server was built without `BusMetricsCollector`, 401 token
 * expired, etc.) — callers render `—` while `null`/missing.
 *
 * Extracted from LeftPanel so both the desktop panel and the mobile
 * StatsSheet share one implementation (and one polling contract).
 */
export function useBusHealth(intervalMs: number): BusMetricsSnapshot | null {
  const [snap, setSnap] = useState<BusMetricsSnapshot | null>(null);
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    const fetchOnce = async () => {
      try {
        const s = await api.getMetricsBus();
        if (!cancelledRef.current) setSnap(s);
      } catch {
        /* keep previous, transient errors OK */
      }
    };
    void fetchOnce();
    const t = setInterval(() => void fetchOnce(), intervalMs);
    return () => {
      cancelledRef.current = true;
      clearInterval(t);
    };
  }, [intervalMs]);
  return snap;
}

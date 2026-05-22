/**
 * S9 + S8 — `/metrics/*` REST surface.
 *
 * Returns the {@link MessagesMetricsSnapshot} (S9) and the
 * {@link BusMetricsSnapshot} (S8) from the in-memory collectors. Mounted
 * **after** the X-Auth-Token middleware in `http/main.ts` so anonymous
 * callers get 401 (parity with `/orchestrators`).
 *
 * `busMetrics` is optional: when omitted (tests that don't care about
 * `/metrics/bus`) the route simply isn't registered, so unauth'd / wrong
 * callers still hit the express default 404.
 */
import { Router, type Request, type Response } from 'express';
import type { MessagesAggregator } from '../../modules/metrics/aggregator.js';
import type { BusMetricsCollector } from '../../modules/metrics/busMetrics.js';

export function createMetricsRouter(
  aggregator: MessagesAggregator,
  busMetrics?: BusMetricsCollector,
): Router {
  const router = Router();

  router.get('/metrics/messages', (_req: Request, res: Response) => {
    res.json(aggregator.snapshot());
  });

  if (busMetrics) {
    router.get('/metrics/bus', (_req: Request, res: Response) => {
      res.json(busMetrics.snapshot());
    });
  }

  return router;
}

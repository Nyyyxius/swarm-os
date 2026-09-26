/**
 * S9 + S8 + Lot 10 — `/metrics/*` REST surface.
 *
 * Returns the {@link MessagesMetricsSnapshot} (S9), the
 * {@link BusMetricsSnapshot} (S8) and the {@link SystemMetricsSnapshot}
 * (Lot 10) from the in-memory collectors. Mounted **after** the X-Auth-Token
 * middleware in `http/main.ts` so anonymous callers get 401 (parity with
 * `/orchestrators`).
 *
 * `busMetrics` is optional: when omitted (tests that don't care about
 * `/metrics/bus`) the route simply isn't registered, so unauth'd / wrong
 * callers still hit the express default 404.
 *
 * `systemMetrics` defaults to the process-wide collector — it carries the
 * previous CPU sample the lazy delta is computed from, so it MUST outlive the
 * request; tests pass their own instance with injected fixtures.
 */
import { Router, type Request, type Response } from 'express';
import type { MessagesAggregator } from '../../modules/metrics/aggregator.js';
import type { BusMetricsCollector } from '../../modules/metrics/busMetrics.js';
import {
  getSystemMetricsCollector,
  type SystemMetricsCollector,
} from '../../modules/metrics/systemMetrics.js';
import {
  buildTeamCostRows,
  type CostRateLookup,
  type LiveCostTeam,
  type TeamBudgetLookup,
} from '../../modules/metrics/costs.js';
import {
  parseCostExportQuery,
  costExportSinceDay,
  costExportFilename,
  toCostExportCsv,
  toCostExportJson,
  type CostExportRow,
} from '../../modules/metrics/cost-export.js';
import type { OrchestratorTokenSumRow } from '../../modules/db/index.js';
import {
  parseCallBucket,
  parseCallWindow,
  type CallBucket,
  type CallUsageView,
  type CallWindow,
} from '../../modules/metrics/call-usage.js';

/**
 * Lot 12 — everything `/metrics/costs` needs, as a structural type rather than
 * the `Spawner` itself.
 *
 * Same reason as `systemMetrics`: this router is the thinnest layer in the
 * stack and its test suite should be able to serve a fixture without standing
 * up a spawner, a database and a model catalogue. `main.ts` passes the three
 * lambdas that read the real ones.
 */
export interface TeamCostsDeps {
  /** The fleet-wide token aggregate — hidden rows included. One query. */
  sumTokenUsage(): readonly OrchestratorTokenSumRow[];
  /** Live teams, in whatever order the spawner holds them (the client sorts). */
  listActive(): readonly LiveCostTeam[];
  rateLookup: CostRateLookup;
  /**
   * Lot 14 — resolves each team's cost budget against the spend just computed
   * for it. Optional: without it no row carries a `budget` field, which is how a
   * caller says "this deployment has no opinion" rather than "no team has a
   * budget". `main.ts` wires `createTeamBudgetLookup(spawner, roleStore)`.
   */
  teamBudget?: TeamBudgetLookup;
  /**
   * Lot 15 — the daily ledger from `sinceDay` (`YYYY-MM-DD`) onward, backing
   * `GET /metrics/costs/export`. Optional for the same reason as `teamBudget`:
   * a caller that does not wire it gets no export route at all, and a 404 is a
   * truer answer than a route that 500s. `main.ts` wires
   * `db.sessionTokenDailySince`.
   */
  dailySince?: (sinceDay: string) => readonly CostExportRow[];
  /**
   * Per-call ledger — the fleet-wide series behind `GET /metrics/call-usage`
   * (`CallLedger.callUsage(null, …)`, teams named). `null` ⇒ the window ×
   * bucket combination is too fine (400). Optional: absent ⇒ no route.
   */
  callUsage?: (window: CallWindow, bucket: CallBucket) => CallUsageView | null;
}

export function createMetricsRouter(
  aggregator: MessagesAggregator,
  busMetrics?: BusMetricsCollector,
  systemMetrics: SystemMetricsCollector = getSystemMetricsCollector(),
  teamCosts?: TeamCostsDeps,
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

  // Lot 10 — container CPU / memory gauges. Always mounted: the collector has
  // no dependency to be missing, and reads its own cgroup (outside a
  // container every field is simply null).
  router.get('/metrics/system', (_req: Request, res: Response) => {
    res.json(systemMetrics.snapshot());
  });

  // Lot 12 — cost per team. Polled every 15 s while the MONITORING page is
  // open, and only then; the work is one GROUP BY over `sessions` plus a
  // multiplication per team, so it needs no cache and holds no state. Mounted
  // only when the deps are wired, for the same reason as `/metrics/bus`: a 404
  // is a truer answer than a route that 500s.
  if (teamCosts) {
    router.get('/metrics/costs', (_req: Request, res: Response) => {
      const teams = buildTeamCostRows(
        teamCosts.sumTokenUsage(),
        teamCosts.listActive(),
        teamCosts.rateLookup,
        teamCosts.teamBudget,
      );
      res.json({ teams });
    });
  }

  // Lot 15 — the daily ledger as a document the operator saves. NOT polled:
  // this is a button, and every hit is a window scan over `session_token_daily`
  // capped at 90 days. Mounted only when the ledger is wired, like
  // `/metrics/costs` above.
  //
  // The two formats are ONE dataset (`modules/metrics/cost-export`): the JSON
  // rows carry the CSV header's field names verbatim, so a script and a
  // spreadsheet reading the same window can be diffed against each other.
  if (teamCosts?.dailySince) {
    const dailySince = teamCosts.dailySince;
    router.get('/metrics/costs/export', (req: Request, res: Response) => {
      const parsed = parseCostExportQuery(req.query as { format?: unknown; days?: unknown });
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      const rows = dailySince(costExportSinceDay(parsed.days));
      if (parsed.format === 'json') {
        res.json(toCostExportJson(parsed.days, rows));
        return;
      }
      // `send`, not `json`: the body is already the exact bytes the operator
      // will save, and Express must not re-encode them.
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${costExportFilename('csv')}"`,
      );
      res.send(toCostExportCsv(rows));
    });
  }

  // Per-call ledger — calls and tokens per bucket for EVERY team, lead and
  // workers apart, plus one total per team (the MONITORING panel's selector).
  // Aggregated in SQL; polled by the panel only while the page is open.
  if (teamCosts?.callUsage) {
    const callUsage = teamCosts.callUsage;
    router.get('/metrics/call-usage', (req: Request, res: Response) => {
      const window = parseCallWindow(req.query.window);
      const bucket = parseCallBucket(req.query.bucket);
      if (window === null || bucket === null) {
        res.status(400).json({
          error: "query.window must be '1h', '24h', '3d' or '14d'; query.bucket '5m', 'hour' or 'day'",
        });
        return;
      }
      const view = callUsage(window, bucket);
      if (view === null) {
        res.status(400).json({ error: 'TOO_MANY_BUCKETS' });
        return;
      }
      res.json(view);
    });
  }

  return router;
}

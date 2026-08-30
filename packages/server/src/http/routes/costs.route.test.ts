/**
 * Lot 12 — the two cost endpoints, at their boundary.
 *
 * `GET /metrics/costs` is the team roll-up the MONITORING page polls every
 * 15 s; `GET /orchestrators/:id/cost` is the per-session drill-down behind an
 * expanded row. The web half of this lot is already shipped against these
 * shapes, so what is pinned here is the CONTRACT: field names, and — far more
 * important — every place a `null` must not become a `0`.
 *
 * The database and the spawner are faked. What the SQL itself does with hidden
 * rows is pinned in `modules/db/team-costs.test.ts`; what belongs to this layer
 * is the pricing, the null-rules and the 404.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { createMetricsRouter, type TeamCostsDeps } from './metrics.js';
import { createOrchestratorsRouter } from './orchestrators.js';
import type { MessagesAggregator } from '../../modules/metrics/aggregator.js';
import type { OrchestratorTokenSumRow, SessionCostRow } from '../../modules/db/index.js';
import type { Spawner } from '../../modules/spawner/index.js';
import type { Config } from '../../config.js';
import type { TokenCostRates } from '../../modules/providers/catalogue.js';

let listening: Server | null = null;

afterEach(async () => {
  if (listening) {
    await new Promise<void>((resolve) => listening!.close(() => resolve()));
    listening = null;
  }
});

const aggregator = { snapshot: () => ({ total: 0 }) } as unknown as MessagesAggregator;

/** $5/M in, $25/M out. Only `claude-opus-5` is priced — everything else is `—`. */
const RATES: Record<string, TokenCostRates> = {
  'claude:claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};
const rateLookup = (providerId: string, modelId: string): TokenCostRates | null =>
  RATES[`${providerId}:${modelId}`] ?? null;

function sumRow(over: Partial<OrchestratorTokenSumRow> = {}): OrchestratorTokenSumRow {
  return {
    orchestrator_id: 'orch-1',
    provider: 'claude',
    model: 'claude-opus-5',
    in: 0,
    out: 0,
    cache_read: 0,
    cache_write: 0,
    removed_count: 0,
    removed_in: null,
    removed_out: null,
    removed_cache_read: null,
    removed_cache_write: null,
    has_null_counters: 0,
    removed_has_null: 0,
    ...over,
  };
}

function dbRow(over: Partial<SessionCostRow> = {}): SessionCostRow {
  return {
    id: 'sess-1',
    orchestrator_id: 'orch-1',
    name: 'team-lead',
    type: 'lead',
    status: 'running',
    hidden_at: null,
    model: 'claude-opus-5',
    provider: 'claude',
    tokens_in: 1_000_000,
    tokens_out: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    ...over,
  };
}

/** A live team, as `buildTeamCostRows` sees one. */
function team(id: string, name: string, burns: (number | null)[]) {
  return {
    id,
    name,
    listSessions: () => burns.map((burnPerHourUsd) => ({ burnPerHourUsd })),
  };
}

async function serveMetrics(deps: TeamCostsDeps): Promise<string> {
  const app = express();
  app.use(createMetricsRouter(aggregator, undefined, undefined, deps));
  return listen(app);
}

async function serveOrchestrators(spawner: Spawner): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(createOrchestratorsRouter(spawner, { maxPromptSizeBytes: 1024 } as unknown as Config));
  return listen(app);
}

async function listen(app: express.Express): Promise<string> {
  const server = createServer(app);
  listening = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

// ---------------------------------------------------------------------------
// GET /metrics/costs
// ---------------------------------------------------------------------------

describe('GET /metrics/costs', () => {
  it('serves one row per LIVE team, priced from the DB aggregate', async () => {
    const base = await serveMetrics({
      sumTokenUsage: () => [
        sumRow({ in: 2_000_000, out: 40_000, removed_count: 3 }),
        // A team the spawner no longer holds: its rows are in the aggregate,
        // but the operations view only lists what is running.
        sumRow({ orchestrator_id: 'orch-dead', in: 9_000_000 }),
      ],
      listActive: () => [team('orch-1', 'CALM-A', [0.5, 1.25, null])],
      rateLookup,
    });
    const body = await (await fetch(`${base}/metrics/costs`)).json();

    expect(body.teams).toHaveLength(1);
    expect(body.teams[0]).toMatchObject({
      orchId: 'orch-1',
      name: 'CALM-A',
      live: 3,
      total: { in: 2_000_000, out: 40_000, cacheRead: 0, cacheWrite: 0, costUsd: 11 },
      removed: { count: 3 },
      // Σ over the live sessions that could be measured; the `null` one is not
      // a zero and does not drag the sum down.
      burnPerHour: 1.75,
    });
  });

  it('prices each (provider, model) bucket with ITS OWN rates', async () => {
    const base = await serveMetrics({
      sumTokenUsage: () => [
        sumRow({ in: 1_000_000 }),
        // Same team, a model nothing can price: it contributes tokens to the
        // totals and 0 to the cost — a lower bound, never a guess.
        sumRow({ provider: 'codex', model: 'gpt-5', in: 4_000_000 }),
      ],
      listActive: () => [team('orch-1', 'MIXED', [])],
      rateLookup,
    });
    const body = await (await fetch(`${base}/metrics/costs`)).json();
    expect(body.teams[0].total.in).toBe(5_000_000);
    expect(body.teams[0].total.costUsd).toBe(5);
  });

  it('answers costUsd: null for a team whose rows carry no counters', async () => {
    const base = await serveMetrics({
      sumTokenUsage: () => [
        sumRow({
          in: null,
          out: null,
          cache_read: null,
          cache_write: null,
          has_null_counters: 1,
        }),
      ],
      listActive: () => [team('orch-1', 'PRE-LOT-11', [])],
      rateLookup,
    });
    const body = await (await fetch(`${base}/metrics/costs`)).json();
    // The counters are `number` on the wire, so they read 0 — but the field
    // that says "we measured nothing" is `costUsd`, and it must be null.
    expect(body.teams[0].total).toEqual({
      in: 0,
      out: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: null,
    });
    expect(body.teams[0].removed).toEqual({ count: 0, costUsd: null });
    expect(body.teams[0].burnPerHour).toBeNull();
  });

  it('prices removed.costUsd from the removed columns ALONE', async () => {
    const base = await serveMetrics({
      sumTokenUsage: () => [
        sumRow({
          in: 3_000_000,
          removed_count: 2,
          removed_in: 1_000_000,
          removed_out: 0,
          removed_cache_read: 0,
          removed_cache_write: 0,
        }),
      ],
      listActive: () => [team('orch-1', 'REAPED', [])],
      rateLookup,
    });
    const body = await (await fetch(`${base}/metrics/costs`)).json();
    expect(body.teams[0].total.costUsd).toBe(15);
    expect(body.teams[0].removed).toEqual({ count: 2, costUsd: 5 });
  });

  it('reports removed workers that have a count but no counters as null, not $0', async () => {
    const base = await serveMetrics({
      sumTokenUsage: () => [
        sumRow({ in: 1_000_000, removed_count: 4, removed_has_null: 1 }),
      ],
      listActive: () => [team('orch-1', 'OLD-REAPED', [])],
      rateLookup,
    });
    const body = await (await fetch(`${base}/metrics/costs`)).json();
    expect(body.teams[0].removed).toEqual({ count: 4, costUsd: null });
  });

  // Lot 14 — the `budget` half of a row. The lookup is the seam `main.ts` fills
  // with `createTeamBudgetLookup(spawner, roleStore)`; what matters at this
  // layer is that the verdict is resolved against the SAME `total.costUsd` the
  // row carries, and that "no budget" reaches the wire as `null`, never as
  // `exceeded: false`.
  it('carries the team budget, resolved against the cost in the same row', async () => {
    const base = await serveMetrics({
      sumTokenUsage: () => [sumRow({ in: 2_000_000 })], // $10 at the fixture rates
      listActive: () => [team('orch-1', 'CALM-A', [])],
      rateLookup,
      teamBudget: (orchId, costUsd) =>
        orchId === 'orch-1'
          ? { usd: 50, action: 'pause', exceeded: costUsd !== null && costUsd >= 50 }
          : null,
    });
    const body = await (await fetch(`${base}/metrics/costs`)).json();
    expect(body.teams[0].total.costUsd).toBe(10);
    expect(body.teams[0].budget).toEqual({ usd: 50, action: 'pause', exceeded: false });
  });

  it('reports exceeded once the team has reached its ceiling', async () => {
    const seen: (number | null)[] = [];
    const base = await serveMetrics({
      sumTokenUsage: () => [sumRow({ in: 12_000_000 })], // $60
      listActive: () => [team('orch-1', 'OVER', [])],
      rateLookup,
      teamBudget: (_orchId, costUsd) => {
        seen.push(costUsd);
        return { usd: 50, action: 'notify', exceeded: costUsd !== null && costUsd >= 50 };
      },
    });
    const body = await (await fetch(`${base}/metrics/costs`)).json();
    expect(body.teams[0].budget).toEqual({ usd: 50, action: 'notify', exceeded: true });
    // The lookup was handed the row's own priced total, not a re-derivation.
    expect(seen).toEqual([60]);
  });

  it('sends budget: null for a team with no role or no ceiling', async () => {
    const base = await serveMetrics({
      sumTokenUsage: () => [sumRow({ in: 1_000_000 })],
      listActive: () => [team('orch-1', 'NO-ROLE', [])],
      rateLookup,
      teamBudget: () => null,
    });
    const body = await (await fetch(`${base}/metrics/costs`)).json();
    expect(body.teams[0].budget).toBeNull();
  });

  it('omits the field entirely when no budget lookup is wired', async () => {
    const base = await serveMetrics({
      sumTokenUsage: () => [],
      listActive: () => [team('orch-1', 'NO-LOOKUP', [])],
      rateLookup,
    });
    const body = await (await fetch(`${base}/metrics/costs`)).json();
    expect('budget' in body.teams[0]).toBe(false);
  });

  it('degrades a throwing budget lookup to null instead of losing the row', async () => {
    const base = await serveMetrics({
      sumTokenUsage: () => [sumRow({ in: 1_000_000 })],
      listActive: () => [team('orch-1', 'BROKEN', [])],
      rateLookup,
      teamBudget: () => {
        throw new Error('role store exploded');
      },
    });
    const res = await fetch(`${base}/metrics/costs`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.teams[0].total.costUsd).toBe(5);
    expect(body.teams[0].budget).toBeNull();
  });

  it('gives a brand-new team an honest empty line rather than omitting it', async () => {
    const base = await serveMetrics({
      sumTokenUsage: () => [],
      listActive: () => [team('orch-new', 'JUST-SPAWNED', [null])],
      rateLookup,
    });
    const body = await (await fetch(`${base}/metrics/costs`)).json();
    expect(body.teams).toEqual([
      {
        orchId: 'orch-new',
        name: 'JUST-SPAWNED',
        live: 1,
        total: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, costUsd: null },
        removed: { count: 0, costUsd: null },
        burnPerHour: null,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// GET /orchestrators/:id/cost
// ---------------------------------------------------------------------------

function fakeSpawner(rows: SessionCostRow[], liveIds: string[] = []): Spawner {
  return {
    get: (id: string) => (liveIds.includes(id) ? { id } : undefined),
    modelCatalogue: { costRates: rateLookup },
    persistence: {
      db: {
        sessionCostRowsForOrchestrator: (orchId: string) =>
          rows.filter((r) => r.orchestrator_id === orchId),
      },
    },
  } as unknown as Spawner;
}

describe('GET /orchestrators/:id/cost', () => {
  it('ventilates live and removed sessions, each priced by its own model', async () => {
    const base = await serveOrchestrators(
      fakeSpawner(
        [
          dbRow({ id: 's1' }),
          dbRow({
            id: 's2',
            name: 'worker-a',
            type: 'worker',
            status: 'killed',
            hidden_at: '2026-08-30T10:00:00.000Z',
            tokens_in: 200_000,
          }),
          dbRow({
            id: 's3',
            name: 'worker-b',
            type: 'worker',
            provider: 'codex',
            model: 'gpt-5',
            tokens_in: 900_000,
          }),
        ],
        ['orch-1'],
      ),
    );
    const body = await (await fetch(`${base}/orchestrators/orch-1/cost`)).json();

    expect(body.sessions).toEqual([
      {
        id: 's1',
        name: 'team-lead',
        type: 'lead',
        status: 'running',
        removed: false,
        tokens: { in: 1_000_000, out: 0, cacheRead: 0, cacheWrite: 0 },
        costUsd: 5,
      },
      {
        id: 's2',
        name: 'worker-a',
        type: 'worker',
        status: 'killed',
        removed: true,
        tokens: { in: 200_000, out: 0, cacheRead: 0, cacheWrite: 0 },
        costUsd: 1,
      },
      {
        id: 's3',
        name: 'worker-b',
        type: 'worker',
        status: 'running',
        removed: false,
        tokens: { in: 900_000, out: 0, cacheRead: 0, cacheWrite: 0 },
        // Measured, but unpriceable: tokens without a price, never a fake one.
        costUsd: null,
      },
    ]);
  });

  it('renders a pre-Lot-11 session as tokens: null, not four zeroes', async () => {
    const base = await serveOrchestrators(
      fakeSpawner(
        [
          dbRow({
            id: 's1',
            tokens_in: null,
            tokens_out: null,
            tokens_cache_read: null,
            tokens_cache_write: null,
          }),
        ],
        ['orch-1'],
      ),
    );
    const body = await (await fetch(`${base}/orchestrators/orch-1/cost`)).json();
    expect(body.sessions[0]).toMatchObject({ tokens: null, costUsd: null });
  });

  it('treats a partially-reported session as measured', async () => {
    // opencode reports four buckets, gemini none, codex folds cache into input:
    // a bucket a provider never reports is genuinely 0, and must not erase the
    // buckets beside it.
    const base = await serveOrchestrators(
      fakeSpawner(
        [dbRow({ id: 's1', tokens_cache_read: null, tokens_cache_write: null })],
        ['orch-1'],
      ),
    );
    const body = await (await fetch(`${base}/orchestrators/orch-1/cost`)).json();
    expect(body.sessions[0].tokens).toEqual({ in: 1_000_000, out: 0, cacheRead: 0, cacheWrite: 0 });
    expect(body.sessions[0].costUsd).toBe(5);
  });

  it('answers for a team that only exists in the DB — its history is the point', async () => {
    const base = await serveOrchestrators(
      fakeSpawner([dbRow({ id: 's1', orchestrator_id: 'orch-dead', status: 'exited' })], []),
    );
    const res = await fetch(`${base}/orchestrators/orch-dead/cost`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessions).toHaveLength(1);
  });

  it('404s for a team that exists neither in the spawner nor in the DB', async () => {
    const base = await serveOrchestrators(fakeSpawner([], []));
    const res = await fetch(`${base}/orchestrators/nope/cost`);
    expect(res.status).toBe(404);
  });

  it('answers a live team with no rows yet rather than 404ing it', async () => {
    const base = await serveOrchestrators(fakeSpawner([], ['orch-1']));
    const res = await fetch(`${base}/orchestrators/orch-1/cost`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: [] });
  });
});

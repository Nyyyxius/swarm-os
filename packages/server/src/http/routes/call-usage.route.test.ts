/**
 * Per-call ledger — the three read endpoints, at their boundary:
 *
 *   GET /sessions/:id/calls              one agent's calls (the band chart)
 *   GET /orchestrators/:id/call-usage    one team, lead / workers per bucket
 *   GET /metrics/call-usage              every team, plus one total per team
 *
 * The ledger underneath is REAL (a temp SQLite file); only the spawner is a
 * fake. The aggregation itself is pinned in `modules/metrics/call-usage.test.ts`
 * — what belongs here is the query vocabulary, the 400s, and the 404 rules
 * (known live OR known in the DB, because a removed agent keeps its history).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { createSessionsRouter } from './sessions.js';
import { createOrchestratorsRouter } from './orchestrators.js';
import { createMetricsRouter } from './metrics.js';
import { SwarmDb } from '../../modules/db/index.js';
import { CallLedger } from '../../modules/metrics/call-usage.js';
import type { TranscriptCall } from '../../modules/orchestrator/context-usage.js';
import type { MessagesAggregator } from '../../modules/metrics/aggregator.js';
import type { Spawner } from '../../modules/spawner/index.js';
import type { Config } from '../../config.js';

let listening: Server | null = null;
let dir: string;
let db: SwarmDb;
let ledger: CallLedger;

const LIVE_SESSION = 'sess-live';
const GONE_SESSION = 'sess-gone';
const LIVE_ORCH = 'orch-live';

function call(id: string, agoMs: number, over: Partial<TranscriptCall> = {}): TranscriptCall {
  return {
    messageId: id,
    ts: Date.now() - agoMs,
    model: 'claude-opus-5-5',
    input: 1,
    cacheWrite: 10,
    cacheRead: 100,
    output: 5,
    isSidechain: false,
    ...over,
  };
}

function fakeSpawner(): Spawner {
  return {
    findSession: (id: string) =>
      id === LIVE_SESSION ? { session: { id }, orchestrator: { id: LIVE_ORCH } } : null,
    get: (id: string) => (id === LIVE_ORCH ? { id, name: 'LIVE' } : undefined),
    persistence: {
      db: {
        getSession: (id: string) => (id === GONE_SESSION ? { id } : null),
        getOrchestrator: (id: string) => (id === 'orch-ended' ? { id, name: 'ENDED' } : null),
      },
    },
    callLedger: ledger,
  } as unknown as Spawner;
}

async function serve(): Promise<string> {
  const app = express();
  app.use(express.json());
  const spawner = fakeSpawner();
  const config = { maxPromptSizeBytes: 1024 } as unknown as Config;
  app.use(createSessionsRouter(spawner, config));
  app.use(createOrchestratorsRouter(spawner, config));
  app.use(
    createMetricsRouter(
      { snapshot: () => ({ total: 0 }) } as unknown as MessagesAggregator,
      undefined,
      undefined,
      {
        sumTokenUsage: () => [],
        listActive: () => [],
        rateLookup: () => null,
        callUsage: (window, bucket) =>
          ledger.callUsage(null, window, bucket, (id) => (id === LIVE_ORCH ? 'LIVE' : null)),
      },
    ),
  );
  const server = createServer(app);
  listening = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

// A test navigates whatever JSON the route answered; typing every shape again
// here would only duplicate `modules/metrics/call-usage.ts`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function get(base: string, url: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${url}`);
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-calls-route-'));
  db = new SwarmDb(dir);
  ledger = new CallLedger(db);
  ledger.record({ id: LIVE_SESSION, orchestratorId: LIVE_ORCH, type: 'lead' }, [
    call('m1', 2 * 3_600_000),
    call('m2', 60_000, { cacheRead: 5_000 }),
  ]);
  ledger.record({ id: 'sess-w', orchestratorId: LIVE_ORCH, type: 'worker' }, [call('w1', 30_000)]);
  ledger.record({ id: GONE_SESSION, orchestratorId: 'orch-ended', type: 'worker' }, [call('g1', 30_000)]);
});

afterEach(async () => {
  if (listening) {
    await new Promise<void>((resolve) => listening!.close(() => resolve()));
    listening = null;
  }
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('GET /sessions/:id/calls', () => {
  it('serves the calls of the window, 24h by default', async () => {
    const base = await serve();
    const dflt = await get(base, `/sessions/${LIVE_SESSION}/calls`);
    expect(dflt.status).toBe(200);
    expect(dflt.json.window).toBe('24h');
    expect(dflt.json.aggregated).toBe(false);
    expect(dflt.json.calls.map((c: { context: number }) => c.context)).toEqual([111, 5_011]);
    expect(dflt.json.totals.calls).toBe(2);
    const hour = await get(base, `/sessions/${LIVE_SESSION}/calls?window=1h`);
    expect(hour.json.calls).toHaveLength(1);
    expect(hour.json.calls[0]).toMatchObject({ n: 1, model: 'claude-opus-5-5', cacheRead: 5_000, output: 5 });
  });

  it('400s a window outside the closed set; an empty one is the default', async () => {
    const base = await serve();
    for (const q of ['?window=7d', '?window=1H', '?window=1h&window=3d']) {
      expect((await get(base, `/sessions/${LIVE_SESSION}/calls${q}`)).status, q).toBe(400);
    }
    expect((await get(base, `/sessions/${LIVE_SESSION}/calls?window=`)).status).toBe(200);
    expect((await get(base, `/sessions/${LIVE_SESSION}/calls?window=14d`)).status).toBe(200);
  });

  it('answers for a removed agent known only to the DB, 404s an unknown id', async () => {
    const base = await serve();
    const gone = await get(base, `/sessions/${GONE_SESSION}/calls`);
    expect(gone.status).toBe(200);
    expect(gone.json.totals.calls).toBe(1);
    expect((await get(base, '/sessions/nope/calls')).status).toBe(404);
  });
});

describe('GET /orchestrators/:id/call-usage', () => {
  it('splits the team into lead and workers per hour', async () => {
    const base = await serve();
    const res = await get(base, `/orchestrators/${LIVE_ORCH}/call-usage?window=24h&bucket=hour`);
    expect(res.status).toBe(200);
    expect(res.json.bucketMs).toBe(3_600_000);
    expect(res.json.totals.lead.calls).toBe(2);
    expect(res.json.totals.workers.calls).toBe(1);
    expect(res.json.lead.length).toBe(res.json.workers.length);
    expect(res.json.teams).toBeUndefined();
  });

  it('answers for an ended team known to the DB, 404s an unknown one', async () => {
    const base = await serve();
    const ended = await get(base, '/orchestrators/orch-ended/call-usage');
    expect(ended.status).toBe(200);
    expect(ended.json.totals.workers.calls).toBe(1);
    expect((await get(base, '/orchestrators/nope/call-usage')).status).toBe(404);
  });

  it('400s a bad bucket and a too-fine window × bucket', async () => {
    const base = await serve();
    expect((await get(base, `/orchestrators/${LIVE_ORCH}/call-usage?bucket=week`)).status).toBe(400);
    const fine = await get(base, `/orchestrators/${LIVE_ORCH}/call-usage?window=14d&bucket=5m`);
    expect(fine.status).toBe(400);
    expect(fine.json.error).toBe('TOO_MANY_BUCKETS');
  });
});

describe('GET /metrics/call-usage', () => {
  it('serves every team, with a total per team, busiest first', async () => {
    const base = await serve();
    const res = await get(base, '/metrics/call-usage?window=24h');
    expect(res.status).toBe(200);
    expect(res.json.totals.lead.calls).toBe(2);
    expect(res.json.totals.workers.calls).toBe(2);
    expect(res.json.teams.map((t: { orchestratorId: string; name: string | null; calls: number }) =>
      [t.orchestratorId, t.name, t.calls])).toEqual([
      [LIVE_ORCH, 'LIVE', 3],
      ['orch-ended', null, 1],
    ]);
  });

  it('400s a window outside the closed set', async () => {
    const base = await serve();
    expect((await get(base, '/metrics/call-usage?window=30d')).status).toBe(400);
  });
});

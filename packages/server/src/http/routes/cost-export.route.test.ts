/**
 * Lot 15 — `GET /metrics/costs/export`, at its boundary.
 *
 * The web half is already shipped against this endpoint and saves the response
 * BYTES verbatim to the operator's disk, so what is pinned here is the
 * document, not just the status code: the CSV header character for character,
 * the quoting rule, the empty case, and the fact that the JSON flavour is the
 * SAME dataset under the same field names rather than a second shape.
 *
 * The database is faked. What the SQL does with the join and the window is
 * pinned in `modules/db/session-token-daily.test.ts`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { createMetricsRouter, type TeamCostsDeps } from './metrics.js';
import type { MessagesAggregator } from '../../modules/metrics/aggregator.js';
import { COST_EXPORT_HEADER, type CostExportRow } from '../../modules/metrics/cost-export.js';

let listening: Server | null = null;

afterEach(async () => {
  if (listening) {
    await new Promise<void>((resolve) => listening!.close(() => resolve()));
    listening = null;
  }
});

const aggregator = { snapshot: () => ({ total: 0 }) } as unknown as MessagesAggregator;

function row(over: Partial<CostExportRow> = {}): CostExportRow {
  return {
    day: '2026-08-29',
    orchestrator_id: 'orch-1',
    team: 'CALM-A',
    session_id: 'sess-1',
    agent: 'lead',
    tokens_in: 1_000_000,
    tokens_out: 100_000,
    cache_read: 0,
    cache_write: 0,
    cost_usd: 7.5,
    ...over,
  };
}

/** Mounts the router with a `dailySince` that records the window it was asked for. */
async function serve(
  rows: CostExportRow[] = [],
): Promise<{ base: string; asked: string[] }> {
  const asked: string[] = [];
  const deps: TeamCostsDeps = {
    sumTokenUsage: () => [],
    listActive: () => [],
    rateLookup: () => null,
    dailySince: (sinceDay) => {
      asked.push(sinceDay);
      return rows;
    },
  };
  const app = express();
  app.use(createMetricsRouter(aggregator, undefined, undefined, deps));
  return { base: await listen(app), asked };
}

async function listen(app: express.Express): Promise<string> {
  const server = createServer(app);
  listening = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

/** Whole days between two `YYYY-MM-DD` strings. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

const todayUtc = (): string => new Date().toISOString().slice(0, 10);

describe('GET /metrics/costs/export — validation', () => {
  it('refuses a format outside the whitelist', async () => {
    const { base, asked } = await serve();
    const res = await fetch(`${base}/metrics/costs/export?format=xlsx`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'format must be one of csv, json' });
    // And never touched the database for it.
    expect(asked).toEqual([]);
  });

  it('defaults to csv when no format is given — a pasted URL still works', async () => {
    const { base } = await serve([row()]);
    const res = await fetch(`${base}/metrics/costs/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
  });

  it('defaults to a 30-day window, today included', async () => {
    const { base, asked } = await serve();
    await fetch(`${base}/metrics/costs/export?format=csv`);
    expect(daysBetween(asked[0]!, todayUtc())).toBe(29);
  });

  it('CAPS an over-long window at 90 days rather than refusing it', async () => {
    // "Give me a year" has an honest answer — the 90 days we keep — and a 400
    // would be a worse one.
    const { base, asked } = await serve();
    const res = await fetch(`${base}/metrics/costs/export?format=json&days=365`);
    expect(res.status).toBe(200);
    expect(daysBetween(asked[0]!, todayUtc())).toBe(89);
    // The body reports the EFFECTIVE window, so a client can see it was clamped.
    expect(await res.json()).toMatchObject({ days: 90 });
  });

  it('refuses a days that is not a positive whole number', async () => {
    const { base } = await serve();
    for (const bad of ['abc', '0', '-3', '1.5', '30abc']) {
      const res = await fetch(`${base}/metrics/costs/export?format=csv&days=${bad}`);
      expect([bad, res.status]).toEqual([bad, 400]);
    }
  });

  it('honours a window inside the cap', async () => {
    const { base, asked } = await serve();
    await fetch(`${base}/metrics/costs/export?format=csv&days=7`);
    expect(daysBetween(asked[0]!, todayUtc())).toBe(6);
  });

  it('404s when the deployment wires no ledger at all', async () => {
    const app = express();
    app.use(
      createMetricsRouter(aggregator, undefined, undefined, {
        sumTokenUsage: () => [],
        listActive: () => [],
        rateLookup: () => null,
      }),
    );
    const base = await listen(app);
    expect((await fetch(`${base}/metrics/costs/export?format=csv`)).status).toBe(404);
    // …while the sibling route it must not shadow still answers.
    expect((await fetch(`${base}/metrics/costs`)).status).toBe(200);
  });
});

describe('GET /metrics/costs/export — the CSV document', () => {
  it('emits the contract header, byte for byte', async () => {
    const { base } = await serve([]);
    const text = await (await fetch(`${base}/metrics/costs/export?format=csv`)).text();
    // The shipped web half is written against THIS string.
    expect(text.split('\n')[0]).toBe(
      'day,orchestrator_id,team,session_id,agent,tokens_in,tokens_out,cache_read,cache_write,cost_usd',
    );
    expect(COST_EXPORT_HEADER).toBe(text.split('\n')[0]);
  });

  it('returns the header ALONE for an empty window — a valid one-line file', async () => {
    const { base } = await serve([]);
    const text = await (await fetch(`${base}/metrics/costs/export?format=csv`)).text();
    expect(text).toBe(`${COST_EXPORT_HEADER}\n`);
  });

  it('writes one line per row, in the header order', async () => {
    const { base } = await serve([row(), row({ day: '2026-08-30', session_id: 'sess-2', agent: 'worker-1', cost_usd: 0 })]);
    const text = await (await fetch(`${base}/metrics/costs/export?format=csv`)).text();
    expect(text).toBe(
      `${COST_EXPORT_HEADER}\n` +
        '2026-08-29,orch-1,CALM-A,sess-1,lead,1000000,100000,0,0,7.5\n' +
        '2026-08-30,orch-1,CALM-A,sess-2,worker-1,1000000,100000,0,0,0\n',
    );
  });

  it('leaves an unpriced day EMPTY, never `0`', async () => {
    // `0` in a money column reads as "this day was free"; empty reads as "we
    // could not price it", which is what `cost_usd IS NULL` means.
    const { base } = await serve([row({ cost_usd: null })]);
    const text = await (await fetch(`${base}/metrics/costs/export?format=csv`)).text();
    expect(text.split('\n')[1]).toBe('2026-08-29,orch-1,CALM-A,sess-1,lead,1000000,100000,0,0,');
  });

  it('quotes a name that would otherwise break the grid — and only that name', async () => {
    const { base } = await serve([row({ team: 'ops,prod', agent: 'the "lead"' })]);
    const text = await (await fetch(`${base}/metrics/costs/export?format=csv`)).text();
    expect(text.split('\n')[1]).toBe(
      '2026-08-29,orch-1,"ops,prod",sess-1,"the ""lead""",1000000,100000,0,0,7.5',
    );
  });

  it('defuses a spreadsheet formula hiding in an agent-controlled name', async () => {
    // `team` and `agent` are names AGENTS choose. A cell opening with = + - @
    // is executed as a formula by Excel/Sheets: a worker named
    // `=HYPERLINK(...)` would fire on the operator's machine at open. The
    // apostrophe is the spreadsheet "treat as text" marker — and a defused
    // value that also carries a comma must still be quoted.
    const { base } = await serve([
      row({ team: '=HYPERLINK("http://evil";"x")', agent: '+SUM(A1,B1)' }),
    ]);
    const text = await (await fetch(`${base}/metrics/costs/export?format=csv`)).text();
    expect(text.split('\n')[1]).toBe(
      `2026-08-29,orch-1,"'=HYPERLINK(""http://evil"";""x"")",sess-1,"'+SUM(A1,B1)",1000000,100000,0,0,7.5`,
    );
  });

  it('names the file after the day it was taken', async () => {
    const { base } = await serve([row()]);
    const res = await fetch(`${base}/metrics/costs/export?format=csv`);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="swarm-costs-${todayUtc()}.csv"`,
    );
  });
});

describe('GET /metrics/costs/export — the JSON flavour', () => {
  it('is the SAME dataset under the SAME field names', async () => {
    const rows = [row(), row({ session_id: 'sess-2', cost_usd: null })];
    const { base } = await serve(rows);
    const res = await fetch(`${base}/metrics/costs/export?format=json&days=7`);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();
    expect(body).toEqual({ days: 7, rows });
    // Snake_case is contractual: the JSON keys ARE the CSV header.
    expect(Object.keys(body.rows[0])).toEqual(COST_EXPORT_HEADER.split(','));
  });

  it('answers an empty window with rows: [] — not with an error', async () => {
    const { base } = await serve([]);
    const body = await (await fetch(`${base}/metrics/costs/export?format=json`)).json();
    expect(body).toEqual({ days: 30, rows: [] });
  });
});

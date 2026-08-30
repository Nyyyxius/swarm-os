/**
 * `POST /sessions/:id/context-reset` — the operator compact/clear entrypoint
 * (docs/monitoring-agents.md, Lot 3) — and `GET /sessions/:id/context-history`,
 * the context graph's only endpoint (Lot 9).
 *
 * The orchestrator is faked here on purpose: everything the route owns is the
 * boundary — whitelisting the wire vocabulary, capping the instructions, and
 * turning a `SessionActionError` into a status code. What the orchestrator
 * does with the call is pinned in `modules/orchestrator/context-reset.test.ts`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { SessionActionError } from '../../modules/orchestrator/index.js';
import type { ContextUsageHistory } from '../../modules/orchestrator/context-usage.js';
import type { Spawner } from '../../modules/spawner/index.js';
import type { Config } from '../../config.js';
import { createSessionsRouter } from './sessions.js';

const SESSION = 'sess-1';
const MAX_PROMPT_BYTES = 1024;

let listening: Server | null = null;

interface ResetCall {
  sessionId: string;
  cmd: string;
  instructions: string | undefined;
}

/**
 * Fake spawner whose orchestrator records every accepted call, or throws the
 * supplied typed error (the refusal path the route has to map).
 */
function fakeSpawner(
  opts: {
    present?: boolean;
    throws?: SessionActionError;
    /** Lot 9 — what `Session.contextHistory` answers; `null` ⇒ no tracker. */
    history?: ContextUsageHistory | null;
  } = {},
): {
  spawner: Spawner;
  calls: ResetCall[];
} {
  const present = opts.present ?? true;
  const calls: ResetCall[] = [];
  const orchestrator = {
    id: 'orch-1',
    requestContextReset(sessionId: string, cmd: string, instructions?: string) {
      if (opts.throws) throw opts.throws;
      calls.push({ sessionId, cmd, instructions });
      return { id: sessionId };
    },
  };
  const spawner = {
    findSession: (id: string) =>
      present && id === SESSION
        ? { session: { id, contextHistory: opts.history ?? null }, orchestrator }
        : null,
  } as unknown as Spawner;
  return { spawner, calls };
}

function makeConfig(): Config {
  return {
    logsDir: '/nonexistent/logs',
    maxPromptSizeBytes: MAX_PROMPT_BYTES,
  } as unknown as Config;
}

async function serve(spawner: Spawner): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(createSessionsRouter(spawner, makeConfig()));
  const server = createServer(app);
  listening = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

async function post(
  base: string,
  id: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/sessions/${id}/context-reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

afterEach(async () => {
  if (listening) {
    await new Promise<void>((resolve) => listening!.close(() => resolve()));
    listening = null;
  }
});

describe('POST /sessions/:id/context-reset', () => {
  it('maps the wire vocabulary onto the provider-agnostic commands', async () => {
    const { spawner, calls } = fakeSpawner();
    const base = await serve(spawner);

    const compact = await post(base, SESSION, { cmd: 'compact' });
    expect(compact.status).toBe(200);
    expect(compact.json).toEqual({ scheduled: true });

    await post(base, SESSION, { cmd: 'clear' });
    expect(calls.map((c) => c.cmd)).toEqual(['/compact', '/clear']);
    expect(calls[0]?.sessionId).toBe(SESSION);
  });

  it('forwards instructions, and treats an empty string as none', async () => {
    const { spawner, calls } = fakeSpawner();
    const base = await serve(spawner);

    await post(base, SESSION, { cmd: 'compact', instructions: 'keep the API contract' });
    await post(base, SESSION, { cmd: 'compact', instructions: '' });
    await post(base, SESSION, { cmd: 'compact' });

    expect(calls.map((c) => c.instructions)).toEqual([
      'keep the API contract',
      undefined,
      undefined,
    ]);
  });

  it('404s an unknown session', async () => {
    const { spawner } = fakeSpawner({ present: false });
    const base = await serve(spawner);
    const res = await post(base, 'ghost', { cmd: 'compact' });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('SESSION_UNKNOWN');
  });

  it('400s anything outside the cmd whitelist', async () => {
    const { spawner, calls } = fakeSpawner();
    const base = await serve(spawner);
    for (const body of [
      {},
      { cmd: '/compact' }, // the internal spelling is NOT the wire spelling
      { cmd: 'COMPACT' },
      { cmd: 'reset' },
      { cmd: 42 },
      { cmd: null },
      // A prototype key must not resolve to a command — hence the explicit
      // comparisons rather than a lookup table.
      { cmd: 'constructor' },
      { cmd: 'toString' },
    ]) {
      const res = await post(base, SESSION, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('400s non-string instructions and 413s oversized ones', async () => {
    const { spawner, calls } = fakeSpawner();
    const base = await serve(spawner);

    const bad = await post(base, SESSION, { cmd: 'compact', instructions: { a: 1 } });
    expect(bad.status).toBe(400);

    const huge = await post(base, SESSION, {
      cmd: 'compact',
      instructions: 'x'.repeat(MAX_PROMPT_BYTES + 1),
    });
    expect(huge.status).toBe(413);
    expect(String(huge.json.error)).toContain('instructions too large');

    // Multi-byte characters count as bytes, not as characters.
    const multibyte = await post(base, SESSION, {
      cmd: 'compact',
      instructions: 'é'.repeat(MAX_PROMPT_BYTES / 2 + 1),
    });
    expect(multibyte.status).toBe(413);

    expect(calls).toHaveLength(0);
  });

  it('maps a typed refusal onto its status code and stable code token', async () => {
    for (const [code, status] of [
      ['RESET_ALREADY_PENDING', 409],
      ['PROVIDER_NO_RESET', 409],
      ['SESSION_NOT_ACTIVE', 409],
    ] as const) {
      const { spawner } = fakeSpawner({
        throws: new SessionActionError(code, `refused: ${code}`, status),
      });
      const base = await serve(spawner);
      const res = await post(base, SESSION, { cmd: 'clear' });
      expect(res.status).toBe(status);
      expect(res.json.error).toBe(code);
      expect(res.json.message).toBe(`refused: ${code}`);
      await new Promise<void>((resolve) => listening!.close(() => resolve()));
      listening = null;
    }
  });
});

// ---------------------------------------------------------------------------
// Lot 9 — the context graph endpoint
// ---------------------------------------------------------------------------

interface HistoryBody {
  limitTokens: number | null;
  points: Array<{ t: string; min: number; max: number; last: number }>;
  resets: Array<{ t: string; cmd: string }>;
}

async function getHistory(
  base: string,
  id: string,
  query = '',
): Promise<{ status: number; json: HistoryBody }> {
  const res = await fetch(`${base}/sessions/${id}/context-history${query}`);
  return { status: res.status, json: (await res.json()) as HistoryBody };
}

describe('GET /sessions/:id/context-history', () => {
  it('400s a window outside the closed set, and defaults to 1h without one', async () => {
    const now = Date.now();
    const { spawner } = fakeSpawner({
      history: {
        limitTokens: 200_000,
        // One point inside the hour, one two hours back: the default window is
        // what decides whether the old one shows up.
        samples: [
          { t: now - 2 * 60 * 60 * 1000, used: 10_000 },
          { t: now - 60_000, used: 90_000 },
        ],
        resets: [],
      },
    });
    const base = await serve(spawner);

    for (const q of ['?window=7d', '?window=1H', '?window=', '?window=1h&window=3d']) {
      // `?window=` is the one that must NOT 400 — an empty query string is a
      // client that did not choose, i.e. the default.
      const res = await getHistory(base, SESSION, q);
      expect(res.status, q).toBe(q === '?window=' ? 200 : 400);
    }

    const dflt = await getHistory(base, SESSION);
    expect(dflt.status).toBe(200);
    expect(dflt.json.points.map((p) => p.last)).toEqual([90_000]);

    const wide = await getHistory(base, SESSION, '?window=24h');
    expect(wide.json.points.map((p) => p.last)).toEqual([10_000, 90_000]);
  });

  it('404s an unknown session — the history is memory-only, a row cannot answer', async () => {
    const { spawner } = fakeSpawner({ present: false });
    const base = await serve(spawner);
    const res = await getHistory(base, 'ghost');
    expect(res.status).toBe(404);
  });

  it('200s with empty arrays for a session with no tracker (gemini)', async () => {
    const { spawner } = fakeSpawner({ history: null });
    const base = await serve(spawner);
    const res = await getHistory(base, SESSION, '?window=3d');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ limitTokens: null, points: [], resets: [] });
  });

  it('200s with empty arrays for a tracker that has read nothing yet', async () => {
    const { spawner } = fakeSpawner({
      history: { limitTokens: 200_000, samples: [], resets: [] },
    });
    const base = await serve(spawner);
    const res = await getHistory(base, SESSION);
    expect(res.status).toBe(200);
    // The limit is known even before the first sample — the panel can already
    // scale its axis.
    expect(res.json).toEqual({ limitTokens: 200_000, points: [], resets: [] });
  });

  it('serves points and resets in bare vocabulary, ISO stamps, chronological', async () => {
    const now = Date.now();
    const { spawner } = fakeSpawner({
      history: {
        limitTokens: 200_000,
        samples: [
          { t: now - 600_000, used: 120_000 },
          { t: now - 300_000, used: 180_000 },
          { t: now - 240_000, used: 20_000 },
        ],
        resets: [
          // Older than the 1h window: filtered out.
          { t: now - 90 * 60 * 1000, cmd: 'clear' },
          { t: now - 270_000, cmd: 'compact' },
        ],
      },
    });
    const base = await serve(spawner);
    const res = await getHistory(base, SESSION, '?window=1h');

    expect(res.status).toBe(200);
    expect(res.json.limitTokens).toBe(200_000);
    expect(res.json.points.map((p) => p.last)).toEqual([120_000, 180_000, 20_000]);
    const stamps = res.json.points.map((p) => Date.parse(p.t));
    expect(stamps.every((s) => !Number.isNaN(s))).toBe(true);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
    // Bare words, never `/compact`.
    expect(res.json.resets).toEqual([
      { t: new Date(now - 270_000).toISOString(), cmd: 'compact' },
    ]);

    // The same resets are still in range on the wider window.
    const wide = await getHistory(base, SESSION, '?window=3d');
    expect(wide.json.resets.map((r) => r.cmd)).toEqual(['clear', 'compact']);
  });
});

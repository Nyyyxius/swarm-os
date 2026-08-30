import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  OpencodeControlPlaneSource,
  basicAuthHeader,
  lookupOpencodeContextLimit,
  opencodeCostDelta,
  selectCurrentOpencodeSession,
  sessionCostUsd,
  selectLastCompletedAssistant,
  sessionTokens,
  type OpencodeControlTarget,
} from './context-usage-opencode.js';
import { ContextUsageTracker } from './context-usage.js';
import { Session } from './session.js';
import { Orchestrator } from './index.js';
import { NoOpPersistence } from './persistence.js';
import { FakeAgentProcess } from './agent-process.js';
import { FakeProvider } from '../providers/fake.js';
import { ProviderRegistry } from '../providers/registry.js';
import type { Config } from '../../config.js';

/**
 * Monitoring, Lot 7 (docs/monitoring-agents.md) — context usage of an opencode
 * session, read over the HTTP control plane swarm-os already starts and
 * password-protects for every opencode agent.
 *
 * Fixtures are verbatim shapes from `scripts/verify-opencode-tokens.report.md`
 * (§T1/T2/T3/T5), and the suite is organised around its three silent traps: the
 * cumulative aggregate that looks like an occupancy, the in-flight message that
 * reports zero for the busiest agent, and the session id that stops being the
 * current one at the first `/clear`.
 */

// ---------------------------------------------------------------------------
// Control-plane fixtures
// ---------------------------------------------------------------------------

const MODEL_ID = 'google/gemini-2.5-flash-lite';
const PROVIDER_ID = 'openrouter';
const SESSION_OLD = 'ses_fad0d6a71ffee9bYYBcTGOiZRD';
const SESSION_NEW = 'ses_fad0cdbb8ffeHjzJHT2j5sEsgO';

function sessionRow(opts: {
  id: string;
  created: number;
  /** Lot 11 — override the billing aggregate; `null` drops it entirely. */
  tokens?: Record<string, unknown> | null;
  /** Lot 13 — override the reported cost; `null` drops it entirely. */
  cost?: number | null;
}): Record<string, unknown> {
  return {
    id: opts.id,
    slug: 'swift-comet',
    projectID: 'global',
    directory: '/work',
    // TRAP 1 — the cumulative billing aggregate. Deliberately absurd for the
    // GAUGE, so a test that ever divides by it fails loudly. Lot 11 reads it on
    // purpose for the BILL, where a cumulative sum is exactly the right shape.
    ...(opts.cost === null ? {} : { cost: opts.cost ?? 0.00016725 }),
    ...(opts.tokens === null
      ? {}
      : {
          tokens: opts.tokens ?? {
            input: 999_999,
            output: 888_888,
            reasoning: 0,
            cache: { read: 777_777, write: 0 },
          },
        }),
    title: 'Ping pong response test',
    agent: 'build',
    model: { id: MODEL_ID, providerID: PROVIDER_ID },
    version: '1.18.5',
    time: { created: opts.created, updated: opts.created + 7_000 },
  };
}

function assistantMessage(opts: {
  id: string;
  total: number | null;
  completed: number | null;
  summary?: boolean;
}): Record<string, unknown> {
  return {
    id: opts.id,
    role: 'assistant',
    modelID: MODEL_ID,
    providerID: PROVIDER_ID,
    cost: 0.00008415,
    ...(opts.summary ? { summary: true } : {}),
    tokens:
      opts.total === null
        ? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        : { total: opts.total, input: 38, output: 2, reasoning: 0, cache: { read: 7_955, write: 0 } },
    finish: 'stop',
    time: { created: 1_788_098_030_761, ...(opts.completed === null ? {} : { completed: opts.completed }) },
  };
}

/** User messages carry no `tokens` at all — which is why the scan cannot take the last element. */
const USER_MESSAGE = {
  id: 'msg_user_1',
  role: 'user',
  time: { created: 1_788_098_030_000 },
};

const PROVIDERS_BODY = {
  providers: [
    {
      id: PROVIDER_ID,
      models: {
        [MODEL_ID]: {
          id: MODEL_ID,
          limit: { context: 1_048_576, output: 65_535 },
          cost: { input: 0.1, output: 0.4 },
        },
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// 1. The selectors — where the three traps are actually paid
// ---------------------------------------------------------------------------

describe('selectCurrentOpencodeSession', () => {
  it('takes max(time.created), never [0]', () => {
    // TRAP 3. `/session` was observed newest-first, but nothing documents that
    // and opencode ids do not sort chronologically as plain strings.
    const rows = [
      sessionRow({ id: SESSION_OLD, created: 1_788_098_024_846 }),
      sessionRow({ id: SESSION_NEW, created: 1_788_098_061_383 }),
    ];
    expect(selectCurrentOpencodeSession(rows)?.id).toBe(SESSION_NEW);
    expect(selectCurrentOpencodeSession([...rows].reverse())?.id).toBe(SESSION_NEW);
  });

  it('carries the model join keys the limit lookup needs', () => {
    const current = selectCurrentOpencodeSession([sessionRow({ id: SESSION_OLD, created: 1 })]);
    expect(current).toMatchObject({ providerID: PROVIDER_ID, modelID: MODEL_ID });
  });

  it('answers null for an empty list, a non-array, and rows with no id', () => {
    expect(selectCurrentOpencodeSession([])).toBeNull();
    expect(selectCurrentOpencodeSession({ sessions: [] })).toBeNull();
    expect(selectCurrentOpencodeSession(null)).toBeNull();
    expect(selectCurrentOpencodeSession([{ time: { created: 5 } }])).toBeNull();
  });
});

describe('selectLastCompletedAssistant', () => {
  it('skips the in-flight message that reports zero for a busy agent', () => {
    // TRAP 2, measured at t+1760 ms: the assistant message ALREADY EXISTS with
    // all-zero counters and no `time.completed`. Taking it unconditionally
    // reports 0 % exactly when the gauge is most likely to be consulted.
    const messages = [
      assistantMessage({ id: 'msg_done', total: 8_251, completed: 1_788_098_034_497 }),
      USER_MESSAGE,
      assistantMessage({ id: 'msg_running', total: null, completed: null }),
    ];
    expect(selectLastCompletedAssistant(messages)).toEqual({
      usedTokens: 8_251,
      completedAt: 1_788_098_034_497,
    });
  });

  it('unwraps the {info, parts} envelope form', () => {
    const messages = [
      { info: assistantMessage({ id: 'm1', total: 7_989, completed: 1_788_098_030_752 }), parts: [] },
    ];
    expect(selectLastCompletedAssistant(messages)?.usedTokens).toBe(7_989);
  });

  it('answers null when nothing has completed yet (a fresh /clear)', () => {
    expect(
      selectLastCompletedAssistant([
        USER_MESSAGE,
        assistantMessage({ id: 'm', total: null, completed: null }),
      ]),
    ).toBeNull();
    expect(selectLastCompletedAssistant([])).toBeNull();
    expect(selectLastCompletedAssistant('nope')).toBeNull();
  });
});

describe('lookupOpencodeContextLimit', () => {
  it('joins provider + model through the catalogue', () => {
    expect(lookupOpencodeContextLimit(PROVIDERS_BODY, PROVIDER_ID, MODEL_ID)).toBe(1_048_576);
  });

  it('accepts a providers MAP as readily as a providers ARRAY', () => {
    const asMap = { providers: { [PROVIDER_ID]: PROVIDERS_BODY.providers[0] } };
    expect(lookupOpencodeContextLimit(asMap, PROVIDER_ID, MODEL_ID)).toBe(1_048_576);
  });

  it('answers null rather than a wrong denominator', () => {
    expect(lookupOpencodeContextLimit(PROVIDERS_BODY, 'anthropic', MODEL_ID)).toBeNull();
    expect(lookupOpencodeContextLimit(PROVIDERS_BODY, PROVIDER_ID, 'gpt-nope')).toBeNull();
    expect(lookupOpencodeContextLimit(PROVIDERS_BODY, null, MODEL_ID)).toBeNull();
    expect(lookupOpencodeContextLimit('garbage', PROVIDER_ID, MODEL_ID)).toBeNull();
  });
});

it('builds the Authorization header the adapter already provisioned', () => {
  expect(basicAuthHeader('swarm', 'deadbeef')).toBe(
    `Basic ${Buffer.from('swarm:deadbeef').toString('base64')}`,
  );
});

// ---------------------------------------------------------------------------
// 2. The source — three calls, one number, never a throw
// ---------------------------------------------------------------------------

const PLANE: OpencodeControlTarget = {
  baseUrl: 'http://127.0.0.1:47915',
  username: 'swarm',
  password: 'pw',
};

/** A fetch double that answers a route table and records every call. */
function scriptedPlane(routes: Record<string, () => unknown>): {
  fetchImpl: typeof fetch;
  calls: string[];
  headers: string[];
} {
  const calls: string[] = [];
  const headers: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const route = url.slice(PLANE.baseUrl.length);
    calls.push(route);
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (auth) headers.push(auth);
    const handler = routes[route];
    if (!handler) return new Response('not found', { status: 404 });
    const body = handler();
    if (body instanceof Error) throw body;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, headers };
}

function messagesRoute(id: string): string {
  return `/session/${encodeURIComponent(id)}/message`;
}

describe('OpencodeControlPlaneSource', () => {
  it('reads the last completed message, NOT the session aggregate', () => {
    // TRAP 1 restated as an assertion: the fixture's aggregate is 999 999 input
    // + 888 888 output + 777 777 cache. The answer must be 8 251.
    const { fetchImpl, calls, headers } = scriptedPlane({
      '/session': () => [sessionRow({ id: SESSION_OLD, created: 1 })],
      [messagesRoute(SESSION_OLD)]: () => [
        assistantMessage({ id: 'm', total: 8_251, completed: 1_788_098_034_497 }),
      ],
      '/config/providers': () => PROVIDERS_BODY,
    });
    const source = new OpencodeControlPlaneSource({ controlPlane: () => PLANE, fetchImpl });
    return source.read().then((reading) => {
      expect(reading).toMatchObject({
        kind: 'sample',
        usedTokens: 8_251,
        limitTokens: 1_048_576,
      });
      expect(calls).toEqual(['/session', messagesRoute(SESSION_OLD), '/config/providers']);
      expect(headers.every((h) => h === basicAuthHeader('swarm', 'pw'))).toBe(true);
      expect(source.basis).toBe('control-plane');
    });
  });

  it('re-resolves the session on EVERY poll — /clear creates a new one lazily', async () => {
    // An id resolved once freezes the gauge at the first `/clear`, while the
    // agent happily fills a fresh window.
    const sessions = [sessionRow({ id: SESSION_OLD, created: 1_788_098_024_846 })];
    const { fetchImpl } = scriptedPlane({
      '/session': () => sessions,
      [messagesRoute(SESSION_OLD)]: () => [
        assistantMessage({ id: 'm1', total: 8_251, completed: 1_788_098_034_497 }),
      ],
      [messagesRoute(SESSION_NEW)]: () => [
        assistantMessage({ id: 'm2', total: 7_989, completed: 1_788_098_070_000 }),
      ],
      '/config/providers': () => PROVIDERS_BODY,
    });
    const source = new OpencodeControlPlaneSource({ controlPlane: () => PLANE, fetchImpl });
    expect(await source.read()).toMatchObject({ usedTokens: 8_251 });

    // `/clear`, then the next prompt: opencode materialises a NEW session and
    // leaves the old one listed forever, frozen at its final counters.
    sessions.push(sessionRow({ id: SESSION_NEW, created: 1_788_098_061_383 }));
    expect(await source.read()).toMatchObject({ usedTokens: 7_989 });
  });

  it('fetches the provider catalogue once and caches it for the session', async () => {
    const { fetchImpl, calls } = scriptedPlane({
      '/session': () => [sessionRow({ id: SESSION_OLD, created: 1 })],
      [messagesRoute(SESSION_OLD)]: () => [
        assistantMessage({ id: 'm', total: 8_251, completed: 1_788_098_034_497 }),
      ],
      '/config/providers': () => PROVIDERS_BODY,
    });
    const source = new OpencodeControlPlaneSource({ controlPlane: () => PLANE, fetchImpl });
    await source.read();
    await source.read();
    expect(calls.filter((c) => c === '/config/providers')).toHaveLength(1);
  });

  it('answers `empty` while a turn is in flight', async () => {
    const { fetchImpl } = scriptedPlane({
      '/session': () => [sessionRow({ id: SESSION_OLD, created: 1 })],
      [messagesRoute(SESSION_OLD)]: () => [
        assistantMessage({ id: 'm', total: null, completed: null }),
      ],
      '/config/providers': () => PROVIDERS_BODY,
    });
    const source = new OpencodeControlPlaneSource({ controlPlane: () => PLANE, fetchImpl });
    // No occupancy — and yet the bill still moves. The two answers come from
    // two different payloads (Lot 11): `/session`'s aggregate is already final
    // for the turns that HAVE completed, while the message that is still
    // running is what keeps the gauge silent.
    expect(await source.read()).toEqual({
      kind: 'empty',
      tokens: { in: 999_999, out: 888_888, cacheRead: 777_777, cacheWrite: 0 },
      // Lot 13 — and so does the price opencode put on those same tokens.
      reportedCostUsd: 0.00016725,
    });
  });

  it('answers `empty` — never an error — when the session has no plane at all', async () => {
    // The port that lost a race with TIME_WAIT: opencode's TUI carries on
    // perfectly well WITHOUT its control plane, silently.
    const source = new OpencodeControlPlaneSource({ controlPlane: () => null });
    expect(await source.read()).toEqual({ kind: 'empty' });
  });

  it('answers `unavailable` when the plane refuses the connection or the auth', async () => {
    const refusing = new OpencodeControlPlaneSource({
      controlPlane: () => PLANE,
      fetchImpl: (() => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    expect(await refusing.read()).toEqual({
      kind: 'unavailable',
      reason: 'control-plane-unreachable',
    });

    const unauthorized = new OpencodeControlPlaneSource({
      controlPlane: () => PLANE,
      fetchImpl: (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch,
    });
    expect(await unauthorized.read()).toMatchObject({ kind: 'unavailable' });
  });

  it('refuses to re-report the PRE-compaction message, then reports the summary', async () => {
    // `/compact` keeps the same session id and the per-message counter drops on
    // its own — but only once the compaction's own summary message completes.
    // Until then the pre-reset number is still the last completed one.
    const messages = [assistantMessage({ id: 'm1', total: 8_251, completed: 1_788_098_034_497 })];
    const { fetchImpl } = scriptedPlane({
      '/session': () => [sessionRow({ id: SESSION_OLD, created: 1 })],
      [messagesRoute(SESSION_OLD)]: () => messages,
      '/config/providers': () => PROVIDERS_BODY,
    });
    const source = new OpencodeControlPlaneSource({ controlPlane: () => PLANE, fetchImpl });
    expect(await source.read()).toMatchObject({ usedTokens: 8_251 });

    source.invalidate();
    expect(await source.read()).toEqual({ kind: 'empty' });

    messages.push(
      assistantMessage({ id: 'm2', total: 798, completed: 1_788_098_050_000, summary: true }),
    );
    expect(await source.read()).toMatchObject({ kind: 'sample', usedTokens: 798 });
  });
});

// ---------------------------------------------------------------------------
// 2b. Lot 11 — the BILL, off the very aggregate trap 1 forbids for the gauge
// ---------------------------------------------------------------------------

describe('sessionTokens', () => {
  it('folds reasoning into output and keeps the four buckets disjoint', () => {
    expect(
      sessionTokens({
        input: 100,
        output: 40,
        reasoning: 7,
        cache: { read: 2_000, write: 500 },
      }),
    ).toEqual({ in: 100, out: 47, cacheRead: 2_000, cacheWrite: 500 });
  });

  it('reads a missing bucket as zero and a missing aggregate as null', () => {
    expect(sessionTokens({ input: 100 })).toEqual({
      in: 100,
      out: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(sessionTokens(undefined)).toBeNull();
    expect(sessionTokens('nope')).toBeNull();
  });
});

describe('OpencodeControlPlaneSource — token deltas', () => {
  const aggregate = (input: number, output = 0, read = 0, write = 0): Record<string, unknown> => ({
    input,
    output,
    reasoning: 0,
    cache: { read, write },
  });

  /** A plane whose `/session` body can be rewritten between reads. */
  function movablePlane(): {
    source: OpencodeControlPlaneSource;
    sessions: Record<string, unknown>[];
    messages: Record<string, Record<string, unknown>[]>;
  } {
    const sessions: Record<string, unknown>[] = [];
    const messages: Record<string, Record<string, unknown>[]> = {};
    const fetchImpl = (async (input: string | URL) => {
      const route = String(input).slice(PLANE.baseUrl.length);
      let body: unknown = null;
      if (route === '/session') body = sessions;
      else if (route === '/config/providers') body = PROVIDERS_BODY;
      else {
        const found = Object.entries(messages).find(([id]) => route === messagesRoute(id));
        body = found ? found[1] : [];
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return {
      sessions,
      messages,
      source: new OpencodeControlPlaneSource({ controlPlane: () => PLANE, fetchImpl }),
    };
  }

  it('bills the whole aggregate first, then only what it grew by', async () => {
    const { source, sessions, messages } = movablePlane();
    sessions.push(sessionRow({ id: SESSION_OLD, created: 1, tokens: aggregate(1_000, 200, 50, 10) }));
    messages[SESSION_OLD] = [assistantMessage({ id: 'm1', total: 1_260, completed: 10 })];
    expect(await source.read()).toMatchObject({
      tokens: { in: 1_000, out: 200, cacheRead: 50, cacheWrite: 10 },
    });

    sessions[0] = sessionRow({ id: SESSION_OLD, created: 1, tokens: aggregate(1_500, 260, 90, 10) });
    messages[SESSION_OLD] = [assistantMessage({ id: 'm2', total: 1_850, completed: 20 })];
    expect(await source.read()).toMatchObject({
      tokens: { in: 500, out: 60, cacheRead: 40, cacheWrite: 0 },
    });
  });

  it('carries the totals across a `/clear`, which opens a NEW session', async () => {
    const { source, sessions, messages } = movablePlane();
    sessions.push(sessionRow({ id: SESSION_OLD, created: 1, tokens: aggregate(1_000, 200) }));
    messages[SESSION_OLD] = [assistantMessage({ id: 'm1', total: 1_200, completed: 10 })];
    await source.read();

    // TRAP 3's other half: `/clear` materialises a new session and leaves the
    // old one listed forever, frozen at its final counters. Its aggregate
    // starts near zero, which is NOT a refund — it is spend we have not billed.
    sessions.push(sessionRow({ id: SESSION_NEW, created: 2, tokens: aggregate(300, 40) }));
    messages[SESSION_NEW] = [assistantMessage({ id: 'm2', total: 340, completed: 20 })];
    expect(await source.read()).toMatchObject({ tokens: { in: 300, out: 40 } });

    // …and going back to a session we already billed does not re-bill it: the
    // base is per session id, so only ITS own growth counts.
    sessions[1] = sessionRow({ id: SESSION_NEW, created: 2, tokens: aggregate(320, 40) });
    expect(await source.read()).toMatchObject({ tokens: { in: 20 } });
  });

  it('says nothing when the aggregate has not moved', async () => {
    const { source, sessions, messages } = movablePlane();
    sessions.push(sessionRow({ id: SESSION_OLD, created: 1, tokens: aggregate(1_000) }));
    messages[SESSION_OLD] = [assistantMessage({ id: 'm1', total: 1_000, completed: 10 })];
    await source.read();
    expect(await source.read()).not.toHaveProperty('tokens');
  });

  it('bills even when the message listing fails right after', async () => {
    // The two answers come from two calls. Losing the second must not lose the
    // first: `/session` already told us, truthfully, what has been spent.
    const { fetchImpl } = scriptedPlane({
      '/session': () => [
        sessionRow({ id: SESSION_OLD, created: 1, tokens: aggregate(700, 80) }),
      ],
      '/config/providers': () => PROVIDERS_BODY,
      // messages route: absent ⇒ 404 ⇒ `unavailable`
    });
    const source = new OpencodeControlPlaneSource({ controlPlane: () => PLANE, fetchImpl });
    expect(await source.read()).toEqual({
      kind: 'unavailable',
      reason: 'messages-unreadable',
      tokens: { in: 700, out: 80, cacheRead: 0, cacheWrite: 0 },
      reportedCostUsd: 0.00016725,
    });
  });

  it('adopts the pre-restart aggregate as a BASE on a resumed session', async () => {
    // Trap 3 is what makes this reachable: an abandoned session stays listed
    // for ever, frozen at its final counters. After a restart the running total
    // comes back from SQLite while the base died with the process, so billing
    // that aggregate again would double the agent's cost at every redeploy.
    const sessions: Record<string, unknown>[] = [
      sessionRow({ id: SESSION_OLD, created: 1, tokens: aggregate(2_000_000, 300_000) }),
    ];
    const messages: Record<string, Record<string, unknown>[]> = {
      [SESSION_OLD]: [assistantMessage({ id: 'm1', total: 8_000, completed: 10 })],
    };
    const fetchImpl = (async (input: string | URL) => {
      const route = String(input).slice(PLANE.baseUrl.length);
      const body =
        route === '/session'
          ? sessions
          : route === '/config/providers'
            ? PROVIDERS_BODY
            : (messages[SESSION_OLD] ?? []);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const source = new OpencodeControlPlaneSource({
      controlPlane: () => PLANE,
      fetchImpl,
      resumed: true,
    });

    expect(await source.read()).not.toHaveProperty('tokens');

    // The next turn is billed normally, from that base.
    sessions[0] = sessionRow({
      id: SESSION_OLD,
      created: 1,
      tokens: aggregate(2_010_000, 300_000),
    });
    expect(await source.read()).toMatchObject({ tokens: { in: 10_000 } });
  });

  it('reports nothing for a session row with no aggregate at all', async () => {
    const { source, sessions, messages } = movablePlane();
    sessions.push(sessionRow({ id: SESSION_OLD, created: 1, tokens: null }));
    messages[SESSION_OLD] = [assistantMessage({ id: 'm1', total: 1_000, completed: 10 })];
    expect(await source.read()).not.toHaveProperty('tokens');
  });
});

describe('ContextUsageTracker on an opencode source', () => {
  it("prefers the plane's own limit.context over the catalogue pin", async () => {
    const { fetchImpl } = scriptedPlane({
      '/session': () => [sessionRow({ id: SESSION_OLD, created: 1 })],
      [messagesRoute(SESSION_OLD)]: () => [
        assistantMessage({ id: 'm', total: 8_251, completed: 1_788_098_034_497 }),
      ],
      '/config/providers': () => PROVIDERS_BODY,
    });
    const tracker = new ContextUsageTracker({
      sessionId: 'sess-oc',
      ttlMs: 15_000,
      limitTokens: () => 200_000,
      source: new OpencodeControlPlaneSource({ controlPlane: () => PLANE, fetchImpl }),
    });
    tracker.maybeRefresh();
    await new Promise((r) => setTimeout(r, 30));
    expect(tracker.snapshot()).toMatchObject({
      usedTokens: 8_251,
      limitTokens: 1_048_576,
      basis: 'control-plane',
      stale: false,
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Session wiring — against a REAL loopback server, over the real `fetch`
// ---------------------------------------------------------------------------

let tmpRoot: string;
let logsDir: string;
let dataDir: string;
let mcpRuntimeDir: string;
let openSessions: Session[] = [];
let planes: http.Server[] = [];

/**
 * A stand-in for opencode's `--port` control plane: real HTTP, real basic auth,
 * ephemeral port. Worth the twenty lines — it exercises the production `fetch`
 * path, the Authorization header and the JSON decoding, none of which a fetch
 * double would.
 */
async function startPlane(state: {
  sessions: unknown[];
  messages: Record<string, unknown[]>;
  password: string;
}): Promise<{ port: number; auths: string[] }> {
  const auths: string[] = [];
  const server = http.createServer((req, res) => {
    auths.push(req.headers.authorization ?? '');
    if (req.headers.authorization !== basicAuthHeader('swarm', state.password)) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    const url = req.url ?? '';
    const send = (body: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    if (url === '/session') return send(state.sessions);
    if (url === '/config/providers') return send(PROVIDERS_BODY);
    const match = /^\/session\/([^/]+)\/message$/.exec(url);
    if (match) return send(state.messages[decodeURIComponent(match[1]!)] ?? []);
    res.writeHead(404).end('nope');
  });
  planes.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { port: typeof address === 'object' && address ? address.port : 0, auths };
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 8787,
    host: '127.0.0.1',
    mcpPort: 8788,
    projectName: 'test',
    defaultModel: `openrouter/${MODEL_ID}`,
    defaultEffort: 'low',
    defaultPermissionMode: 'bypassPermissions',
    defaultProvider: 'opencode',
    maxOrchestrators: 10,
    maxPromptSizeBytes: 64 * 1024,
    claudeStartTimeoutMs: 30_000,
    workspaceRoot: tmpRoot,
    dataDir,
    logsDir,
    mcpRuntimeDir,
    claudeSourceDir: path.join(tmpRoot, 'claude-source'),
    claudeRuntimeDir: path.join(tmpRoot, 'claude-runtime'),
    claudeJsonSource: null,
    maxWorkersPerOrch: 5,
    maxMessageSizeBytes: 1024,
    maxInboxSize: 100,
    idleThresholdMs: 50,
    // Short on purpose — these tests drive the heartbeat by hand.
    contextUsageTtlMs: 5,
    token: 'tk',
    hookToken: 'hk',
    discordWebhookUrl: null,
    publicUrl: null,
    logLevel: 'fatal',
    logPretty: false,
    startedAt: new Date().toISOString(),
    version: 'test',
    ...overrides,
  } as unknown as Config;
}

function makeTeam(opts: {
  providerId?: string;
  controlPlane?: () => OpencodeControlTarget | null;
  config?: Partial<Config>;
}): { orch: Orchestrator; lead: Session } {
  const config = makeConfig(opts.config ?? {});
  const registry = new ProviderRegistry();
  const providerId = opts.providerId ?? 'opencode';
  registry.register(
    new FakeProvider({
      id: providerId,
      sessionConfig: () => ({ configDir: path.join(tmpRoot, 'oc-home'), cleanupPaths: [] }),
      ...(opts.controlPlane ? { controlPlane: opts.controlPlane } : {}),
    }),
    { builtin: true },
  );
  const orch = new Orchestrator(
    {
      name: 'monitoring',
      role: 'co',
      defaultModel: config.defaultModel,
      defaultEffort: config.defaultEffort,
      defaultPermissionMode: config.defaultPermissionMode,
      defaultProvider: providerId,
      leadPreamble: null,
      workerPreamble: null,
      lead: { cwd: tmpRoot, prompt: 'hi', preamble: null },
    },
    config,
    { persistence: new NoOpPersistence(), providerRegistry: registry },
  );
  const lead = orch.start({
    agentProcessOverride: new FakeAgentProcess({ command: 'fake', args: [], cwd: tmpRoot }),
  });
  openSessions.push(lead);
  return { orch, lead };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-ctxoc-'));
  logsDir = path.join(tmpRoot, 'logs');
  dataDir = path.join(tmpRoot, 'data');
  mcpRuntimeDir = path.join(tmpRoot, 'mcp-runtime');
  for (const d of [logsDir, dataDir, mcpRuntimeDir]) fs.mkdirSync(d, { recursive: true });
  openSessions = [];
  planes = [];
});

afterEach(async () => {
  for (const s of openSessions) {
    try {
      s.stop('test-cleanup', 0);
    } catch {
      /* ignore */
    }
  }
  await new Promise((r) => setTimeout(r, 30));
  openSessions = [];
  for (const p of planes) await new Promise<void>((resolve) => p.close(() => resolve()));
  planes = [];
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('Session + Orchestrator — opencode context usage', () => {
  it('polls the live control plane and serializes the reading', async () => {
    const state = {
      sessions: [sessionRow({ id: SESSION_OLD, created: 1_788_098_024_846 })],
      messages: {
        [SESSION_OLD]: [assistantMessage({ id: 'm', total: 8_251, completed: 1_788_098_034_497 })],
      },
      password: 'deadbeefdeadbeef',
    };
    const { port, auths } = await startPlane(state);
    const { orch, lead } = makeTeam({
      controlPlane: () => ({
        baseUrl: `http://127.0.0.1:${port}`,
        username: 'swarm',
        password: state.password,
      }),
    });

    orch.toView();
    await waitUntil(() => lead.contextUsage !== null);
    expect(lead.toView().contextUsage).toMatchObject({
      usedTokens: 8_251,
      limitTokens: 1_048_576,
      basis: 'control-plane',
      stale: false,
    });
    // The credentials the adapter already provisioned — no new secret anywhere.
    expect(auths[0]).toBe(basicAuthHeader('swarm', state.password));
  });

  it('builds NO tracker under SSH — the plane is on the host loopback', async () => {
    // `SshAgentProcess` only sets up a REVERSE forward (`-R`, for MCP); reaching
    // this port would need `ssh -L`, the same gap as the `/event` consumer.
    // No measurement is the honest answer, and it must never be an error.
    const state = {
      sessions: [sessionRow({ id: SESSION_OLD, created: 1 })],
      messages: {
        [SESSION_OLD]: [assistantMessage({ id: 'm', total: 8_251, completed: 1_788_098_034_497 })],
      },
      password: 'pw',
    };
    const { port, auths } = await startPlane(state);
    const { orch, lead } = makeTeam({
      controlPlane: () => ({
        baseUrl: `http://127.0.0.1:${port}`,
        username: 'swarm',
        password: 'pw',
      }),
      config: {
        agentTransport: 'ssh',
        sshTarget: 'user@host',
        hostDataDir: '/host/data',
        hostWorkspaceRoot: '/host/work',
      } as Partial<Config>,
    });

    orch.toView();
    await new Promise((r) => setTimeout(r, 200));
    expect(lead.contextUsage).toBeNull();
    expect('contextUsage' in lead.toView()).toBe(false);
    expect(auths).toEqual([]);
  });

  it('shows nothing, and throws nothing, when the plane never bound', async () => {
    // A fixed port can lose a race with TIME_WAIT and the TUI carries on
    // silently. The adapter then has no plane to hand over.
    const { orch, lead } = makeTeam({ controlPlane: () => null });
    orch.toView();
    await new Promise((r) => setTimeout(r, 150));
    expect(lead.contextUsage).toBeNull();
    expect(lead.status).toBe('running');
  });

  it('tracks nothing for a provider with no control plane at all', async () => {
    const { orch, lead } = makeTeam({ providerId: 'gemini' });
    orch.toView();
    await new Promise((r) => setTimeout(r, 150));
    expect(lead.contextUsage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Lot 13 — the price opencode itself put on those tokens
// ---------------------------------------------------------------------------

/**
 * `cost` sits right beside `tokens` on the same `/session` row, in dollars
 * opencode computed from the provider catalogue it already holds
 * (`scripts/verify-opencode-tokens.report.md` §T2: `0.00016725` for the two
 * assistant messages of the spike run, matching their per-message
 * `0.0000831 + 0.00008415` exactly).
 *
 * It is cumulative and monotonic, so it is billed by the SAME delta-and-rebase
 * machinery as the counters — and every trap that machinery pays for applies to
 * it unchanged.
 */
describe('OpencodeControlPlaneSource — reported cost', () => {
  const aggregate = (input: number, output = 0, read = 0, write = 0): Record<string, unknown> => ({
    input,
    output,
    reasoning: 0,
    cache: { read, write },
  });

  function movablePlane(): {
    source: OpencodeControlPlaneSource;
    sessions: Record<string, unknown>[];
    messages: Record<string, Record<string, unknown>[]>;
    resumedSource: () => OpencodeControlPlaneSource;
  } {
    const sessions: Record<string, unknown>[] = [];
    const messages: Record<string, Record<string, unknown>[]> = {};
    const fetchImpl = (async (input: string | URL) => {
      const route = String(input).slice(PLANE.baseUrl.length);
      let body: unknown = null;
      if (route === '/session') body = sessions;
      else if (route === '/config/providers') body = PROVIDERS_BODY;
      else {
        const found = Object.entries(messages).find(([id]) => route === messagesRoute(id));
        body = found ? found[1] : [];
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return {
      source: new OpencodeControlPlaneSource({ controlPlane: () => PLANE, fetchImpl }),
      sessions,
      messages,
      resumedSource: () =>
        new OpencodeControlPlaneSource({ controlPlane: () => PLANE, fetchImpl, resumed: true }),
    };
  }

  it('bills the whole cost first, then only what it grew by', async () => {
    const { source, sessions, messages } = movablePlane();
    sessions.push(sessionRow({ id: SESSION_OLD, created: 1, cost: 0.25 }));
    messages[SESSION_OLD] = [assistantMessage({ id: 'm1', total: 1_260, completed: 10 })];
    expect(await source.read()).toMatchObject({ reportedCostUsd: 0.25 });

    sessions[0] = sessionRow({ id: SESSION_OLD, created: 1, cost: 0.4 });
    messages[SESSION_OLD] = [assistantMessage({ id: 'm2', total: 1_850, completed: 20 })];
    const grown = await source.read();
    expect(grown.reportedCostUsd).toBeCloseTo(0.15, 10);

    // A poll that measured no new spend says nothing at all — the mirror it
    // would trigger costs a state notification.
    const still = await source.read();
    expect('reportedCostUsd' in still).toBe(false);
  });

  it('opens a NEW base at a `/clear`, and keeps nothing of the old one', async () => {
    const { source, sessions, messages } = movablePlane();
    sessions.push(sessionRow({ id: SESSION_OLD, created: 1, cost: 0.9 }));
    messages[SESSION_OLD] = [assistantMessage({ id: 'm1', total: 1_200, completed: 10 })];
    expect(await source.read()).toMatchObject({ reportedCostUsd: 0.9 });

    // TRAP 3 — `/clear` opens a new session whose `cost` restarts near zero.
    // That is not a refund: it is spend we have never billed.
    sessions.push(sessionRow({ id: SESSION_NEW, created: 2, cost: 0.05 }));
    messages[SESSION_NEW] = [assistantMessage({ id: 'm2', total: 340, completed: 20 })];
    expect(await source.read()).toMatchObject({ reportedCostUsd: 0.05 });

    // The base is per session id, so the abandoned session is never re-billed
    // and the new one only ever contributes its own growth.
    sessions[1] = sessionRow({ id: SESSION_NEW, created: 2, cost: 0.08 });
    const next = await source.read();
    expect(next.reportedCostUsd).toBeCloseTo(0.03, 10);
  });

  it('treats a cost of ZERO as a base, not as an absence', async () => {
    // A session that has not spent anything yet, or a free model. Reading it as
    // "no cost known" would leave the base unset and bill the first paying turn
    // twice — once in full, once as its own delta.
    const { source, sessions, messages } = movablePlane();
    sessions.push(sessionRow({ id: SESSION_OLD, created: 1, cost: 0 }));
    messages[SESSION_OLD] = [assistantMessage({ id: 'm1', total: 100, completed: 10 })];
    const first = await source.read();
    expect('reportedCostUsd' in first).toBe(false);

    sessions[0] = sessionRow({ id: SESSION_OLD, created: 1, cost: 0.02 });
    expect(await source.read()).toMatchObject({ reportedCostUsd: 0.02 });
  });

  it('bills the tokens even when the row carries no cost at all', async () => {
    const { source, sessions, messages } = movablePlane();
    sessions.push(
      sessionRow({ id: SESSION_OLD, created: 1, cost: null, tokens: aggregate(10, 2) }),
    );
    messages[SESSION_OLD] = [assistantMessage({ id: 'm1', total: 12, completed: 10 })];
    const reading = await source.read();
    expect(reading).toMatchObject({ tokens: { in: 10, out: 2 } });
    expect('reportedCostUsd' in reading).toBe(false);
  });

  it('adopts the pre-restart cost as a BASE on a resumed session', async () => {
    // The same hazard as the counters, one degree sharper: the running total
    // came back from SQLite while the base it was measured against died with
    // the process, and an abandoned session stays listed with its final `cost`.
    // Billing it again would double every opencode agent's bill at every
    // redeploy, compounding.
    const { sessions, messages, resumedSource } = movablePlane();
    const source = resumedSource();
    sessions.push(sessionRow({ id: SESSION_OLD, created: 1, cost: 4.2 }));
    messages[SESSION_OLD] = [assistantMessage({ id: 'm1', total: 1_200, completed: 10 })];
    const first = await source.read();
    expect('reportedCostUsd' in first).toBe(false);
    expect('tokens' in first).toBe(false);

    // Everything AFTER the resume is new spend, and is billed in full.
    sessions[0] = sessionRow({ id: SESSION_OLD, created: 1, cost: 4.5 });
    const next = await source.read();
    expect(next.reportedCostUsd).toBeCloseTo(0.3, 10);
  });

  it('carries the cost off `/session` even when the message listing fails', async () => {
    // The bill comes from the `/session` payload alone. Making it wait for the
    // two calls the GAUGE needs would drop real spend on every failure.
    const { fetchImpl } = scriptedPlane({
      '/session': () => [sessionRow({ id: SESSION_OLD, created: 1, cost: 1.25 })],
      '/config/providers': () => PROVIDERS_BODY,
    });
    const source = new OpencodeControlPlaneSource({ controlPlane: () => PLANE, fetchImpl });
    expect(await source.read()).toMatchObject({
      kind: 'unavailable',
      reportedCostUsd: 1.25,
    });
  });
});

describe('opencode cost selectors', () => {
  it('reads a real spike payload, to the cent-millionth', () => {
    expect(sessionCostUsd(0.00016725)).toBe(0.00016725);
    // `0` is a value; everything unreadable is an absence.
    expect(sessionCostUsd(0)).toBe(0);
    expect(sessionCostUsd(-1)).toBeNull();
    expect(sessionCostUsd('0.5')).toBeNull();
    expect(sessionCostUsd(undefined)).toBeNull();
    expect(sessionCostUsd(Number.NaN)).toBeNull();
  });

  it('bills the whole total against an unknown base, and NOTHING on a recede', () => {
    expect(opencodeCostDelta(0.5, null)).toBe(0.5);
    expect(opencodeCostDelta(0.5, 0.2)).toBeCloseTo(0.3, 10);
    // Same-key regression: already billed up to the base — a `/clear` shows up
    // under a NEW session id (base null), so this is a rewritten counter and
    // the honest delta is zero (the caller re-bases).
    expect(opencodeCostDelta(0.1, 0.9)).toBe(0);
    expect(opencodeCostDelta(0.5, 0.5)).toBe(0);
  });
});

// Tests for `agentContext.ts` — the one ranking shared by the LeftPanel's
// AGENT CONTEXT top-4 and the `#/monitoring` table.
//
// Two contracts matter here:
//   1. Absent telemetry must never be coerced into a number. A backend
//      predating the feature omits every field; a gemini agent never reports
//      usage. `pct: null` / `messagesProcessed: null` are how the UI knows to
//      render `—`, and turning them into 0 would rank an unread agent as the
//      emptiest in the swarm.
//   2. The order must be STABLE. Both surfaces re-derive it from a 3 s poll;
//      an unstable tie-break would make the list reshuffle under the cursor.

import { describe, it, expect } from 'vitest';
import {
  AGENT_SORT_OPTIONS, buildAgentContextRows, sortAgentRows, sortByContextDesc,
  sortByCostDesc, topContextRows,
} from './agentContext';
import type {
  ContextUsageView, OrchestratorView, SessionView, TokenUsageView,
} from '../api/client';

function usage(over: Partial<ContextUsageView> = {}): ContextUsageView {
  return {
    usedTokens: 100_000,
    limitTokens: 200_000,
    pct: 0.5,
    basis: 'transcript',
    updatedAt: '2026-05-22T10:00:00.000Z',
    stale: false,
    ...over,
  };
}

function tokens(over: Partial<TokenUsageView> = {}): TokenUsageView {
  return {
    in: 18_200_000,
    out: 141_000,
    cacheRead: 1_204_556,
    cacheWrite: 88_120,
    costUsd: 5.61,
    costBasis: 'estimated',
    ...over,
  };
}

function sess(over: Partial<SessionView> = {}): SessionView {
  return {
    id: 's1',
    orchestratorId: 'o1',
    name: 'AGENT-1',
    role: 'BUILDER',
    type: 'worker',
    cwd: '/tmp',
    model: 'sonnet',
    effort: 'medium',
    permissionMode: 'default',
    status: 'running',
    pid: 1,
    startedAt: '2026-05-22T10:00:00.000Z',
    endedAt: null,
    exitCode: null,
    lastError: null,
    stopReason: null,
    logPath: '/var/log',
    lastActivityAt: '2026-05-22T10:00:00.000Z',
    ...over,
  };
}

function orch(over: Partial<OrchestratorView> = {}): OrchestratorView {
  return {
    id: 'o1',
    name: 'ATLAS',
    role: 'ORCHESTRATOR',
    roleId: null,
    status: 'running',
    leadSessionId: 'lead-1',
    defaultModel: 'sonnet',
    defaultEffort: 'medium',
    defaultPermissionMode: 'default',
    leadPreamble: null,
    workerPreamble: null,
    createdAt: '2026-05-22T09:00:00.000Z',
    endedAt: null,
    lastError: null,
    sessions: [],
    msgCount: 0,
    health: 'ok',
    resumeCount: 0,
    lastResumedAt: null,
    ...over,
  };
}

describe('buildAgentContextRows', () => {
  it('emits one row per session, carrying the team identity', () => {
    const rows = buildAgentContextRows([
      orch({
        id: 'o1', name: 'ATLAS', leadSessionId: 'lead-1',
        sessions: [
          sess({ id: 'lead-1', type: 'lead', name: 'LEAD' }),
          sess({ id: 'w1', name: 'W1' }),
        ],
      }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.teamName).toBe('ATLAS');
    expect(rows[0]?.isLead).toBe(true);
    expect(rows[1]?.isLead).toBe(false);
  });

  it('keeps absent telemetry as null / 0 / false — never as an invented value', () => {
    const rows = buildAgentContextRows([
      orch({ sessions: [sess({ id: 'w1' })] }),
    ]);
    const r = rows[0]!;
    expect(r.usage).toBeNull();
    expect(r.pct).toBeNull();
    // Both counters stay null so the table can render `—`. A confident `0`
    // for a queue nobody reported is exactly the fabricated number this UI
    // forbids — the map glyph coerces separately, where `—` cannot be drawn.
    expect(r.messagesProcessed).toBeNull();
    expect(r.inbox).toBeNull();
    expect(r.resetPending).toBe(false);
    // Lot 11 — same rule for spend: gemini, a pre-Lot-11 backend and a
    // session that has produced nothing yet are all `null`, which is what
    // makes the EST. COST total announce itself as a lower bound.
    expect(r.tokens).toBeNull();
  });

  it('carries the token usage through untouched when the backend reports it', () => {
    const tokenUsage = {
      in: 18_200_000, out: 141_000, cacheRead: 1_204_556, cacheWrite: 88_120,
      costUsd: 5.61, costBasis: 'estimated' as const,
    };
    const rows = buildAgentContextRows([
      orch({ sessions: [sess({ id: 'w1', tokenUsage })] }),
    ]);
    expect(rows[0]?.tokens).toEqual(tokenUsage);
  });

  it('carries the provider quota through, and null when there is none', () => {
    // Lot 13 — an ACCOUNT reading that rides on a session. Absent for every
    // provider but codex, so `null` is the normal case, not an error one.
    const providerQuota = {
      usedPercent: 62, resetsAt: '2026-08-30T18:00:00.000Z', plan: 'pro',
    };
    const rows = buildAgentContextRows([
      orch({
        sessions: [
          sess({ id: 'c1', provider: 'codex', providerQuota }),
          sess({ id: 'c2', provider: 'claude' }),
        ],
      }),
    ]);
    expect(rows[0]?.providerQuota).toEqual(providerQuota);
    expect(rows[1]?.providerQuota).toBeNull();
  });

  it('keeps a real zero distinct from an unreported count', () => {
    const rows = buildAgentContextRows([
      orch({ sessions: [sess({ id: 'w1', inboxCount: 0, messagesProcessed: 0 })] }),
    ]);
    expect(rows[0]?.inbox).toBe(0);
    expect(rows[0]?.messagesProcessed).toBe(0);
  });

  it('normalises a non-finite pct to null instead of ranking it as a number', () => {
    // Belt-and-braces against backend drift: NaN sorts unpredictably and
    // would occupy a LeftPanel top-4 slot while `contextLevel` buckets it as
    // NO TELEMETRY — the two surfaces would disagree about the same agent.
    const rows = buildAgentContextRows([
      orch({
        sessions: [
          sess({ id: 'a', contextUsage: usage({ pct: Number.NaN }) }),
          sess({ id: 'b', contextUsage: usage({ pct: Number.POSITIVE_INFINITY }) }),
        ],
      }),
    ]);
    expect(rows[0]?.pct).toBeNull();
    expect(rows[1]?.pct).toBeNull();
    // …and therefore never reach the panel's top-N list.
    expect(topContextRows([
      orch({ sessions: [sess({ id: 'a', contextUsage: usage({ pct: Number.NaN }) })] }),
    ], 4).rows).toEqual([]);
  });

  it('forwards telemetry when present', () => {
    const rows = buildAgentContextRows([
      orch({
        sessions: [sess({
          id: 'w1',
          contextUsage: usage({ pct: 0.83 }),
          inboxCount: 4,
          messagesProcessed: 128,
          contextResetPending: true,
        })],
      }),
    ]);
    const r = rows[0]!;
    expect(r.pct).toBe(0.83);
    expect(r.inbox).toBe(4);
    expect(r.messagesProcessed).toBe(128);
    expect(r.resetPending).toBe(true);
  });

  it('marks terminal statuses inactive', () => {
    const rows = buildAgentContextRows([
      orch({
        sessions: [
          sess({ id: 'a', status: 'running' }),
          sess({ id: 'b', status: 'exited' }),
          sess({ id: 'c', status: 'killed' }),
          sess({ id: 'd', status: 'failed' }),
          sess({ id: 'e', status: 'interrupted' }),
          sess({ id: 'f', status: 'waiting' }),
          sess({ id: 'g', status: 'paused' }),
        ],
      }),
    ]);
    const byId = Object.fromEntries(rows.map((r) => [r.sessionId, r.active]));
    expect(byId).toEqual({
      a: true, b: false, c: false, d: false, e: false, f: true, g: true,
    });
  });

  it('marks every session of an ENDED team inactive, whatever its own status', () => {
    // The team is gone; a session still reading `running` is a leftover from
    // the last snapshot before the teardown, not a live agent.
    const rows = buildAgentContextRows([
      orch({ endedAt: '2026-05-22T11:00:00.000Z', sessions: [sess({ status: 'running' })] }),
    ]);
    expect(rows[0]?.active).toBe(false);
  });

  // ── Lot 9: the SPARK column's series ────────────────────────────────────
  it('carries the context spark series through for the SPARK column', () => {
    const rows = buildAgentContextRows([
      orch({ sessions: [sess({ contextSpark: [10, 20, 30] })] }),
    ]);
    expect(rows[0]?.contextSpark).toEqual([10, 20, 30]);
  });

  it('renders no spark (null) when the backend omits the field', () => {
    const rows = buildAgentContextRows([orch({ sessions: [sess()] })]);
    expect(rows[0]?.contextSpark).toBeNull();
  });

  it('refuses a one-point series — a dot is not a trend', () => {
    const rows = buildAgentContextRows([
      orch({ sessions: [sess({ contextSpark: [42] })] }),
    ]);
    expect(rows[0]?.contextSpark).toBeNull();
  });

  it('never synthesises a spark from the current pct', () => {
    // An agent WITH a usage reading but no series must still render `—`:
    // repeating one number twenty times would draw a confident flat line.
    const rows = buildAgentContextRows([
      orch({ sessions: [sess({ contextUsage: usage({ pct: 0.8 }) })] }),
    ]);
    expect(rows[0]?.pct).toBe(0.8);
    expect(rows[0]?.contextSpark).toBeNull();
  });
});

describe('sortByContextDesc', () => {
  it('ranks the fullest context window first', () => {
    const rows = buildAgentContextRows([
      orch({
        sessions: [
          sess({ id: 'low', name: 'LOW', contextUsage: usage({ pct: 0.2 }) }),
          sess({ id: 'high', name: 'HIGH', contextUsage: usage({ pct: 0.94 }) }),
          sess({ id: 'mid', name: 'MID', contextUsage: usage({ pct: 0.55 }) }),
        ],
      }),
    ]);
    expect(sortByContextDesc(rows).map((r) => r.sessionId))
      .toEqual(['high', 'mid', 'low']);
  });

  it('pushes agents WITHOUT telemetry to the tail, not to the 0% end', () => {
    const rows = buildAgentContextRows([
      orch({
        sessions: [
          sess({ id: 'blind', name: 'BLIND' }),
          sess({ id: 'empty', name: 'EMPTY', contextUsage: usage({ pct: 0 }) }),
        ],
      }),
    ]);
    // An agent at a measured 0% is a real reading and outranks one we cannot
    // see at all — otherwise "nothing to worry about" and "no idea" would
    // look identical at the bottom of the list.
    expect(sortByContextDesc(rows).map((r) => r.sessionId))
      .toEqual(['empty', 'blind']);
  });

  it('breaks ties by name so the order is stable across polls', () => {
    const rows = buildAgentContextRows([
      orch({
        sessions: [
          sess({ id: 'z', name: 'ZULU', contextUsage: usage({ pct: 0.5 }) }),
          sess({ id: 'a', name: 'ALPHA', contextUsage: usage({ pct: 0.5 }) }),
        ],
      }),
    ]);
    expect(sortByContextDesc(rows).map((r) => r.name)).toEqual(['ALPHA', 'ZULU']);
    // …including among the untelemetered tail.
    const blind = buildAgentContextRows([
      orch({ sessions: [sess({ id: 'z', name: 'ZULU' }), sess({ id: 'a', name: 'ALPHA' })] }),
    ]);
    expect(sortByContextDesc(blind).map((r) => r.name)).toEqual(['ALPHA', 'ZULU']);
  });

  it('does not mutate its input', () => {
    const rows = buildAgentContextRows([
      orch({
        sessions: [
          sess({ id: 'a', name: 'A', contextUsage: usage({ pct: 0.1 }) }),
          sess({ id: 'b', name: 'B', contextUsage: usage({ pct: 0.9 }) }),
        ],
      }),
    ]);
    const before = rows.map((r) => r.sessionId);
    sortByContextDesc(rows);
    expect(rows.map((r) => r.sessionId)).toEqual(before);
  });
});

// ── Lot 13 · the COST ranking ───────────────────────────────────────────────
//
// Same three rules as the CTX one, applied to money — which is the point of
// keeping both here: an operator flipping the SORT control is looking at the
// same list re-ranked, not at a second list with its own idea of what
// "unknown" means.

describe('sortByCostDesc', () => {
  it('ranks the dearest agent first', () => {
    const rows = buildAgentContextRows([
      orch({
        sessions: [
          sess({ id: 'cheap', name: 'CHEAP', tokenUsage: tokens({ costUsd: 0.42 }) }),
          sess({ id: 'dear', name: 'DEAR', tokenUsage: tokens({ costUsd: 91.5 }) }),
          sess({ id: 'mid', name: 'MID', tokenUsage: tokens({ costUsd: 5.61 }) }),
        ],
      }),
    ]);
    expect(sortByCostDesc(rows).map((r) => r.sessionId))
      .toEqual(['dear', 'mid', 'cheap']);
  });

  it('sinks unpriced agents to the tail, below a measured $0.00', () => {
    const rows = buildAgentContextRows([
      orch({
        sessions: [
          // No counters at all (gemini, a session with no turn yet).
          sess({ id: 'blind', name: 'BLIND' }),
          // Counters, but no catalogue price for the model.
          sess({ id: 'unpriced', name: 'UNPRICED', tokenUsage: tokens({ costUsd: null }) }),
          // A real, measured zero — a fact, and it outranks both.
          sess({ id: 'free', name: 'FREE', tokenUsage: tokens({ costUsd: 0 }) }),
        ],
      }),
    ]);
    expect(sortByCostDesc(rows).map((r) => r.sessionId))
      .toEqual(['free', 'blind', 'unpriced']);
  });

  it('treats a drifting backend amount as unknown rather than ranking it', () => {
    const rows = buildAgentContextRows([
      orch({
        sessions: [
          sess({ id: 'nan', name: 'A-NAN', tokenUsage: tokens({ costUsd: Number.NaN }) }),
          sess({ id: 'neg', name: 'B-NEG', tokenUsage: tokens({ costUsd: -3 }) }),
          sess({ id: 'real', name: 'C-REAL', tokenUsage: tokens({ costUsd: 0.01 }) }),
        ],
      }),
    ]);
    expect(sortByCostDesc(rows).map((r) => r.sessionId))
      .toEqual(['real', 'nan', 'neg']);
  });

  it('breaks ties by name, priced and unpriced alike', () => {
    const rows = buildAgentContextRows([
      orch({
        sessions: [
          sess({ id: 'z', name: 'ZULU', tokenUsage: tokens({ costUsd: 5 }) }),
          sess({ id: 'a', name: 'ALPHA', tokenUsage: tokens({ costUsd: 5 }) }),
        ],
      }),
    ]);
    expect(sortByCostDesc(rows).map((r) => r.name)).toEqual(['ALPHA', 'ZULU']);

    const blind = buildAgentContextRows([
      orch({ sessions: [sess({ id: 'z', name: 'ZULU' }), sess({ id: 'a', name: 'ALPHA' })] }),
    ]);
    expect(sortByCostDesc(blind).map((r) => r.name)).toEqual(['ALPHA', 'ZULU']);
  });

  it('does not mutate its input', () => {
    const rows = buildAgentContextRows([
      orch({
        sessions: [
          sess({ id: 'a', name: 'A', tokenUsage: tokens({ costUsd: 1 }) }),
          sess({ id: 'b', name: 'B', tokenUsage: tokens({ costUsd: 9 }) }),
        ],
      }),
    ]);
    const before = rows.map((r) => r.sessionId);
    sortByCostDesc(rows);
    expect(rows.map((r) => r.sessionId)).toEqual(before);
  });
});

describe('sortAgentRows', () => {
  const rows = buildAgentContextRows([
    orch({
      sessions: [
        sess({
          id: 'hot', name: 'HOT',
          contextUsage: usage({ pct: 0.94 }), tokenUsage: tokens({ costUsd: 0.1 }),
        }),
        sess({
          id: 'rich', name: 'RICH',
          contextUsage: usage({ pct: 0.1 }), tokenUsage: tokens({ costUsd: 90 }),
        }),
      ],
    }),
  ]);

  it('routes each key to its ranking', () => {
    expect(sortAgentRows(rows, 'ctx').map((r) => r.sessionId)).toEqual(['hot', 'rich']);
    expect(sortAgentRows(rows, 'cost').map((r) => r.sessionId)).toEqual(['rich', 'hot']);
  });

  it('falls back to CTX on an unknown key', () => {
    const drifted = 'burn' as unknown as 'ctx';
    expect(sortAgentRows(rows, drifted).map((r) => r.sessionId)).toEqual(['hot', 'rich']);
  });

  it('offers exactly the two options the sidebar renders', () => {
    expect(AGENT_SORT_OPTIONS.map((o) => o.label)).toEqual(['CTX', 'COST']);
    expect(AGENT_SORT_OPTIONS.map((o) => o.key)).toEqual(['ctx', 'cost']);
  });
});

describe('topContextRows', () => {
  const many = orch({
    sessions: [
      sess({ id: 'a', name: 'A', contextUsage: usage({ pct: 0.95 }) }),
      sess({ id: 'b', name: 'B', contextUsage: usage({ pct: 0.85 }) }),
      sess({ id: 'c', name: 'C', contextUsage: usage({ pct: 0.75 }) }),
      sess({ id: 'd', name: 'D', contextUsage: usage({ pct: 0.65 }) }),
      sess({ id: 'e', name: 'E', contextUsage: usage({ pct: 0.55 }) }),
      sess({ id: 'f', name: 'F' }),                                   // no telemetry
      sess({ id: 'g', name: 'G', status: 'exited', contextUsage: usage({ pct: 0.99 }) }),
    ],
  });

  it('caps at the limit and reports how many are folded away', () => {
    const { rows, overflow } = topContextRows([many], 4);
    expect(rows.map((r) => r.sessionId)).toEqual(['a', 'b', 'c', 'd']);
    expect(overflow).toBe(1); // only `e` — `f` and `g` are excluded outright
  });

  it('excludes untelemetered and terminated agents from the panel list', () => {
    const { rows } = topContextRows([many], 10);
    expect(rows.map((r) => r.sessionId)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('never reports a negative overflow when there are fewer agents than the cap', () => {
    const { rows, overflow } = topContextRows(
      [orch({ sessions: [sess({ id: 'a', contextUsage: usage() })] })],
      4,
    );
    expect(rows).toHaveLength(1);
    expect(overflow).toBe(0);
  });

  it('returns an empty list (not a crash) when nothing has telemetry', () => {
    const { rows, overflow } = topContextRows(
      [orch({ sessions: [sess({ id: 'a' }), sess({ id: 'b' })] })],
      4,
    );
    expect(rows).toEqual([]);
    expect(overflow).toBe(0);
  });
});

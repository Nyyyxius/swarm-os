// Flatten the orchestrator snapshot into one row per AGENT, carrying the
// monitoring telemetry (context usage, inbox depth, messages processed,
// armed reset). See `docs/monitoring-agents.md`, Lots 4-5.
//
// Why one shared adapter rather than two local `.map()`s: the LeftPanel's
// "AGENT CONTEXT" top-4 and the `#/monitoring` table are the SAME ranking,
// truncated differently. If they derived it separately, the panel could show
// an agent as the hottest while the page — one tie-break apart — showed
// another, and the operator would have no way to tell which one lied. So the
// ordering lives here, once, and both surfaces slice the same list.
//
// Everything is pure: no hooks, no I/O. The data is already in memory from
// the shared `/orchestrators` poll (3 s) — the monitoring surfaces add no
// request of their own.

import type {
  ContextUsageView, OrchestratorView, ProviderQuotaView, TokenUsageView,
} from '../api/client';
import { normalizeContextSpark } from './contextHistory';

/** Statuses after which a session no longer runs — nothing to monitor, no
 *  context to reset. `stopped` is not in the server union today but is
 *  accepted by the UI status helpers, so we bucket it here too. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'exited', 'killed', 'failed', 'interrupted', 'stopped',
]);

export interface AgentContextRow {
  sessionId: string;
  name: string;
  role: string;
  type: 'lead' | 'worker';
  /** `SessionView.provider`, absent on a backend predating multi-provider. */
  provider: string | null;
  status: string;
  isLead: boolean;
  teamId: string;
  teamName: string;
  /** `null` when the provider/session offers no readable usage. */
  usage: ContextUsageView | null;
  /**
   * Convenience mirror of `usage.pct`, normalised: `null` means "no
   * measurement", and a non-finite value from a drifting backend is
   * normalised to `null` too rather than being ranked as a number.
   */
  pct: number | null;
  /**
   * Queued mailbox messages, or `null` when the backend omits the field
   * (pre-Lot-1 server). NOT coerced to 0: a table cell reading a confident
   * `0` for an unknown queue is exactly the fabricated number this UI
   * forbids. The map glyph coerces separately (`mapTeams.ts`) because a
   * badge has no way to draw `—`.
   */
  inbox: number | null;
  /** Drained mailbox messages, or `null` when the backend omits the field. */
  messagesProcessed: number | null;
  /**
   * Recent context readings as whole percents (Lot 9), ready for
   * `Sparkline`, or `null` when there is no usable series — see
   * `normalizeContextSpark`. Never synthesised from `pct`: one dot is not a
   * trend, and the SPARK cell renders `—` rather than a straight line.
   */
  contextSpark: number[] | null;
  /**
   * Cumulative token spend + estimated cost (Lot 11), or `null` when the
   * backend reports none. Unlike `usage`, this does NOT drop back after a
   * compact/clear — it is what the agent has cost so far, not what it is
   * holding. `null` is load-bearing for the `EST. COST` KPI: it is what makes
   * the total announce itself as partial rather than pretending to be
   * complete.
   */
  tokens: TokenUsageView | null;
  /**
   * Provider ACCOUNT quota this agent draws from (Lot 13), or `null` when the
   * provider reports none. Carried on the row rather than looked up per team
   * because it arrives per session, and the sidebar chip is built by
   * de-duplicating the readings of the rows currently ON SCREEN.
   */
  providerQuota: ProviderQuotaView | null;
  /** A compact/clear is armed and fires at this agent's next idle. */
  resetPending: boolean;
  startedAt: string;
  lastActivityAt: string;
  /** False for a terminated session (or one in an ended team). */
  active: boolean;
}

/**
 * One row per session across every orchestrator in the snapshot, ended teams
 * included — the caller filters. A session in an ended team is never
 * `active`, whatever its own last-known status says: the team is gone, so
 * the status is a leftover, not a live reading.
 */
export function buildAgentContextRows(
  orchestrators: readonly OrchestratorView[],
): AgentContextRow[] {
  const rows: AgentContextRow[] = [];
  for (const orch of orchestrators) {
    const teamEnded = orch.endedAt != null;
    for (const s of orch.sessions) {
      const usage = s.contextUsage ?? null;
      // Normalise here, once, so every consumer agrees on what "measured"
      // means. Without it a NaN would be ranked as a number by the sort yet
      // bucketed as NO TELEMETRY by `contextLevel`, and the LeftPanel top-4
      // would spend a slot rendering `—`.
      const pct =
        typeof usage?.pct === 'number' && Number.isFinite(usage.pct)
          ? usage.pct
          : null;
      rows.push({
        sessionId: s.id,
        name: s.name,
        role: s.role,
        type: s.type,
        provider: s.provider ?? null,
        status: s.status,
        isLead: s.id === orch.leadSessionId,
        teamId: orch.id,
        teamName: orch.name,
        usage,
        pct,
        inbox: s.inboxCount ?? null,
        messagesProcessed: s.messagesProcessed ?? null,
        contextSpark: normalizeContextSpark(s.contextSpark),
        tokens: s.tokenUsage ?? null,
        providerQuota: s.providerQuota ?? null,
        resetPending: s.contextResetPending ?? false,
        startedAt: s.startedAt,
        lastActivityAt: s.lastActivityAt,
        active: !teamEnded && !TERMINAL_STATUSES.has(s.status),
      });
    }
  }
  return rows;
}

/**
 * Rank by context pressure: fullest window first, agents WITHOUT telemetry
 * last (they are not "at 0%", we simply cannot see them — pushing them to
 * the bottom keeps the top of the list meaningful), ties broken by name so
 * the order is stable across polls rather than shuffling on every tick.
 *
 * Returns a new array; the input is not mutated.
 */
export function sortByContextDesc(
  rows: readonly AgentContextRow[],
): AgentContextRow[] {
  return [...rows].sort((a, b) => {
    if (a.pct === null && b.pct === null) return a.name.localeCompare(b.name);
    if (a.pct === null) return 1;
    if (b.pct === null) return -1;
    if (b.pct !== a.pct) return b.pct - a.pct;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Rank by MONEY: dearest agent first (Lot 13).
 *
 * Same shape of ranking as `sortByContextDesc` and same three rules, applied
 * to `tokens.costUsd` — unpriced agents last (gemini, an unlisted model, a
 * session with no turn yet: they are not "$0", we cannot see them), ties
 * broken by name for a list that does not reshuffle under the cursor on every
 * 3 s poll. A non-finite or negative amount from a drifting backend counts as
 * unknown rather than being ranked as a number.
 *
 * Cost, not burn: this is the table of AGENTS, and what an agent has cost so
 * far is a fact we hold per session. Rate-per-hour is a team-level figure and
 * already has its own column in TEAM COSTS.
 *
 * Returns a new array; the input is not mutated.
 */
export function sortByCostDesc(
  rows: readonly AgentContextRow[],
): AgentContextRow[] {
  const cost = (r: AgentContextRow): number | null => {
    const c = r.tokens?.costUsd;
    return typeof c === 'number' && Number.isFinite(c) && c >= 0 ? c : null;
  };
  return [...rows].sort((a, b) => {
    const ca = cost(a);
    const cb = cost(b);
    if (ca === null && cb === null) return a.name.localeCompare(b.name);
    if (ca === null) return 1;
    if (cb === null) return -1;
    if (cb !== ca) return cb - ca;
    return a.name.localeCompare(b.name);
  });
}

/** Which ranking the MONITORING table is showing. */
export type AgentSortKey = 'ctx' | 'cost';

/**
 * The SORT control's options, in display order, with the tooltip that says
 * what each one ranks on. Both are descending — there is no "least full
 * window" or "cheapest agent" question an operator opens this page to ask.
 */
export const AGENT_SORT_OPTIONS: readonly {
  readonly key: AgentSortKey; readonly label: string; readonly title: string;
}[] = [
  { key: 'ctx', label: 'CTX', title: 'fullest context window first' },
  { key: 'cost', label: 'COST', title: 'dearest agent first — unpriced agents last' },
] as const;

/** Apply one of the two rankings. Unknown keys fall back to CTX. */
export function sortAgentRows(
  rows: readonly AgentContextRow[],
  key: AgentSortKey,
): AgentContextRow[] {
  return key === 'cost' ? sortByCostDesc(rows) : sortByContextDesc(rows);
}

/**
 * The LeftPanel's "AGENT CONTEXT" list: live agents WITH a measurement, all
 * teams pooled, hottest first, capped. Agents without telemetry are dropped
 * entirely here (unlike the page, which counts them in a NO TELEMETRY
 * bucket) — four rows of `—` would tell the operator nothing.
 */
export function topContextRows(
  orchestrators: readonly OrchestratorView[],
  limit: number,
): { rows: AgentContextRow[]; overflow: number } {
  const measured = sortByContextDesc(
    buildAgentContextRows(orchestrators).filter((r) => r.active && r.pct !== null),
  );
  return {
    rows: measured.slice(0, limit),
    overflow: Math.max(0, measured.length - limit),
  };
}

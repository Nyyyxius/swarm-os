/**
 * Lot 12 — what a team has cost, and what it is costing right now
 * (docs/monitoring-agents.md, § Lot 12).
 *
 * TWO QUESTIONS, TWO SOURCES, and the split is the whole design:
 *
 *   TOTAL  is a SQL question. A killed or reaped worker keeps its row
 *          (`hidden_at IS NOT NULL`) and its Lot 11 counters, so the bill of a
 *          team is the sum over the agents it HAD. An in-memory sum over the
 *          live `Session`s would silently drop every worker the reaper cleaned
 *          up overnight — which, on a 24/7 swarm, is most of the bill.
 *   BURN   is a memory question. It is a derivative, it needs a ring of recent
 *          points, and nothing about it is worth persisting: a burn rate older
 *          than the process is not a fact anyone acts on.
 *
 * NO PRICE IS EVER STORED. Both halves multiply tokens by a LIVE rate card at
 * read time, so a repricing upstream — or a catalogue that was merely cold at
 * boot — fixes every figure retroactively. The corollary the UI depends on:
 * `costUsd: null` means "nothing here could be priced", never "this was free".
 *
 * Everything in this module is pure. The routes supply the rows, the live
 * teams and the rate lookup; the arithmetic and the null-rules live here, where
 * they can be tested without a database or an HTTP server.
 */
import {
  estimateTokenCostUsd,
  type TokenCostRates,
} from '../providers/catalogue.js';
import type {
  OrchestratorTokenSumRow,
  SessionCostRow as SessionCostDbRow,
} from '../db/index.js';

/** Looks up the per-million rates of one model. `null` ⇒ unpriceable. */
export type CostRateLookup = (
  providerId: string,
  modelId: string,
) => TokenCostRates | null;

/** The four counters, as they go on the wire. */
export interface TokenCounters {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TeamCostTotals extends TokenCounters {
  /**
   * Priced spend for the whole team, removed agents included, or `null` when
   * NOTHING under it could be priced. A non-null figure is always a LOWER
   * BOUND: a model with no published rate contributes 0 rather than a guess,
   * exactly as `estimateTokenCostUsd` does per bucket.
   */
  costUsd: number | null;
}

/**
 * Lot 14 — the budget half of a team row: the ceiling, what happens at the
 * crossing, and where the team stands against it. `exceeded` is a MEASURED
 * verdict; a team with no budget carries no `TeamBudgetView` at all rather than
 * an `exceeded: false`, because "not over" and "no ceiling" are different facts.
 *
 * The rule behind `exceeded` lives in `modules/orchestrator/budget-watch`
 * (`isBudgetExceeded`), with the janitor that acts on it — this module only
 * carries the shape onto the wire.
 */
export interface TeamBudgetView {
  usd: number;
  action: 'notify' | 'pause';
  exceeded: boolean;
}

/** One team's line in `GET /metrics/costs`. Mirrors `web`'s `TeamCostRow`. */
export interface TeamCostRow {
  orchId: string;
  name: string;
  /** Agents still in the team — the `N LIVE` denominator. */
  live: number;
  total: TeamCostTotals;
  removed: {
    count: number;
    /** `null` when the removed rows exist but carry no counters. */
    costUsd: number | null;
  };
  /** Σ of the live sessions' burns, or `null` when not one could be measured. */
  burnPerHour: number | null;
  /**
   * Lot 14 — the budget of the ROLE this team was spawned from, resolved
   * against `total.costUsd`. `null` when the team has no role, an unknown role,
   * or a role with no ceiling. ABSENT (not `null`) when no budget lookup was
   * wired at all — a server built without the feature says nothing rather than
   * asserting "no budget".
   */
  budget?: TeamBudgetView | null;
}

/**
 * Resolve one team's budget view from its id and its (already priced) spend.
 * Supplied by the route; see `modules/orchestrator/budget-watch`
 * (`createTeamBudgetLookup`) for the implementation the server wires.
 */
export type TeamBudgetLookup = (
  orchId: string,
  costUsd: number | null,
) => TeamBudgetView | null;

/** Narrow structural view of a live `Session` — all this module needs of one. */
export interface LiveCostSession {
  burnPerHourUsd: number | null;
}

/** Narrow structural view of a live `Orchestrator`. */
export interface LiveCostTeam {
  id: string;
  name: string;
  listSessions(): readonly LiveCostSession[];
}

/** One session's line in `GET /orchestrators/:id/cost`. */
export interface SessionCostView {
  id: string;
  name: string;
  type: 'lead' | 'worker';
  status: string;
  /** `true` once the session left the team (`hidden_at IS NOT NULL`). */
  removed: boolean;
  /** `null` for a session that predates the Lot 11 counters. */
  tokens: TokenCounters | null;
  costUsd: number | null;
}

/** Round to the micro-dollar — the same tail-noise guard as the catalogue. */
function usd(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Four nullable columns → counters, or `null` when ALL FOUR are NULL.
 *
 * The asymmetry is deliberate. All-null is the pre-Lot-11 row: nothing was ever
 * measured, so it must contribute nothing (not a zero) to a cost. A row with
 * SOME columns set was measured — a bucket the provider never reports is
 * genuinely zero, and reading it as "unknown" would erase the buckets that ARE
 * known alongside it.
 */
export function countersFromColumns(
  cols: {
    in: number | null;
    out: number | null;
    cache_read: number | null;
    cache_write: number | null;
  },
): TokenCounters | null {
  if (
    cols.in === null &&
    cols.out === null &&
    cols.cache_read === null &&
    cols.cache_write === null
  ) {
    return null;
  }
  return {
    in: cols.in ?? 0,
    out: cols.out ?? 0,
    cacheRead: cols.cache_read ?? 0,
    cacheWrite: cols.cache_write ?? 0,
  };
}

/**
 * Σ over buckets of `price(bucket counters, bucket rates)`, or `null` when NOT
 * ONE bucket could be priced.
 *
 * Never sums tokens across models and prices the sum: each bucket carries its
 * own `(provider, model)` and is priced with its own rate card, because a team
 * running an opus lead over sonnet workers has no single price.
 */
function priceBuckets(
  buckets: readonly { provider: string; model: string; counters: TokenCounters | null }[],
  rateLookup: CostRateLookup,
): number | null {
  let priced = false;
  let total = 0;
  for (const bucket of buckets) {
    if (bucket.counters === null) continue;
    let rates: TokenCostRates | null = null;
    try {
      rates = rateLookup(bucket.provider, bucket.model);
    } catch {
      rates = null;
    }
    const cost = estimateTokenCostUsd(bucket.counters, rates);
    if (cost === null) continue;
    priced = true;
    total += cost;
  }
  return priced ? usd(total) : null;
}

/**
 * Build the `/metrics/costs` body: ONE ROW PER LIVE TEAM, priced from the DB
 * aggregate.
 *
 * Live teams drive the list, not the aggregate rows: the page is an operations
 * view of what is running now. A team that has ended keeps its rows in SQLite
 * (and `GET /orchestrators/:id/cost` still answers for it), it simply has no
 * line here. The converse — a team just spawned, whose first throttled write
 * has not landed — gets a line with zeroes and a `null` cost, which is the
 * truth for about one second.
 */
export function buildTeamCostRows(
  sums: readonly OrchestratorTokenSumRow[],
  teams: readonly LiveCostTeam[],
  rateLookup: CostRateLookup,
  /**
   * Lot 14 — optional. When omitted the `budget` field is not emitted at all
   * (see `TeamCostRow.budget`); when supplied it is emitted for every row,
   * `null` included.
   */
  budgetLookup?: TeamBudgetLookup,
): TeamCostRow[] {
  const byOrch = new Map<string, OrchestratorTokenSumRow[]>();
  for (const row of sums) {
    const bucket = byOrch.get(row.orchestrator_id);
    if (bucket) bucket.push(row);
    else byOrch.set(row.orchestrator_id, [row]);
  }

  return teams.map((team) => {
    const rows = byOrch.get(team.id) ?? [];
    const total: TeamCostTotals = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, costUsd: null };
    let removedCount = 0;
    const totalBuckets: { provider: string; model: string; counters: TokenCounters | null }[] = [];
    const removedBuckets: typeof totalBuckets = [];

    for (const row of rows) {
      removedCount += row.removed_count ?? 0;
      // The counters on the wire are `number` by contract, so an all-NULL team
      // reads as four zeroes — with `costUsd: null` right beside them, which is
      // the field that actually says "we have no measurement".
      total.in += row.in ?? 0;
      total.out += row.out ?? 0;
      total.cacheRead += row.cache_read ?? 0;
      total.cacheWrite += row.cache_write ?? 0;
      totalBuckets.push({
        provider: row.provider,
        model: row.model,
        counters: countersFromColumns(row),
      });
      removedBuckets.push({
        provider: row.provider,
        model: row.model,
        counters: countersFromColumns({
          in: row.removed_in,
          out: row.removed_out,
          cache_read: row.removed_cache_read,
          cache_write: row.removed_cache_write,
        }),
      });
    }
    total.costUsd = priceBuckets(totalBuckets, rateLookup);

    // Burn is the live half: a removed worker's spend is in `total`, but it is
    // not burning anything any more.
    let sessions: readonly LiveCostSession[] = [];
    try {
      sessions = team.listSessions();
    } catch {
      sessions = [];
    }
    let burned = false;
    let burn = 0;
    for (const session of sessions) {
      const rate = session.burnPerHourUsd;
      if (rate === null || !Number.isFinite(rate)) continue;
      burned = true;
      burn += rate;
    }

    // The budget is resolved against the SAME `total.costUsd` the row carries,
    // so the page can never show a cost and a verdict that disagree. A throwing
    // lookup degrades to "no budget" rather than losing the whole row.
    let budget: TeamBudgetView | null = null;
    if (budgetLookup) {
      try {
        budget = budgetLookup(team.id, total.costUsd);
      } catch {
        budget = null;
      }
    }

    return {
      orchId: team.id,
      name: team.name,
      live: sessions.length,
      total,
      removed: { count: removedCount, costUsd: priceBuckets(removedBuckets, rateLookup) },
      burnPerHour: burned ? usd(burn) : null,
      ...(budgetLookup ? { budget } : {}),
    };
  });
}

/**
 * Build the `GET /orchestrators/:id/cost` body — one line per session the team
 * ever had, each priced with ITS OWN model's rates.
 */
export function buildSessionCostViews(
  rows: readonly SessionCostDbRow[],
  rateLookup: CostRateLookup,
): SessionCostView[] {
  return rows.map((row) => {
    const tokens = countersFromColumns({
      in: row.tokens_in,
      out: row.tokens_out,
      cache_read: row.tokens_cache_read,
      cache_write: row.tokens_cache_write,
    });
    let rates: TokenCostRates | null = null;
    if (tokens !== null) {
      try {
        rates = rateLookup(row.provider, row.model);
      } catch {
        rates = null;
      }
    }
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      status: row.status,
      removed: row.hidden_at !== null,
      tokens,
      costUsd: tokens === null ? null : estimateTokenCostUsd(tokens, rates),
    };
  });
}

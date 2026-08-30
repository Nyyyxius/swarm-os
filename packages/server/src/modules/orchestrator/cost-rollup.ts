/**
 * Daily cost roll-up (docs/monitoring-agents.md, Lot 15).
 *
 * `sessions` carries CUMULATIVE token counters. That answers "what has this
 * agent cost in total" and nothing else — the shape of a week is not derivable
 * from a running total read once, and keeping a week of samples in RAM would
 * lose them at every redeploy of a 24/7 swarm. So this janitor turns the
 * cumulative into a HISTORY: every hour it asks each live agent for its total,
 * subtracts the total it last recorded, and files the difference under today's
 * UTC date in `session_token_daily`.
 *
 * Patterned on `budget-watch.ts`: a pure `rollupOnce(deps)` plus an unref'd
 * `startCostRollup` around it, so the whole truth table can be exercised with no
 * timer, no Spawner and no database.
 *
 * THE WATERMARK IS IN SQLITE, NOT IN MEMORY, and everything else follows from
 * it. `cum_*` on the session's most recent row is the last cumulative we saw;
 * the next delta is `cumulative_now − cum_*`. Three properties fall out:
 *
 *   - **Midnight is not special.** The watermark is read from the session's
 *     LAST row whatever day it sits on, so the first tick after midnight files
 *     a delta against yesterday's watermark and opens today's row with it.
 *   - **A restart loses nothing.** The counters are seeded from the DB on
 *     resume, so a process that dies between two ticks leaves the delta intact
 *     for the next one to pick up — late, but whole.
 *   - **Ticking twice an hour, or ten times, changes no total.** Each tick files
 *     only what the previous one did not, and the day's row accumulates.
 *
 * WHAT IT REFUSES TO DO:
 *
 *   - **Never a negative delta.** A counter that goes DOWN is clamped to 0 and,
 *     deliberately, does NOT re-baseline the watermark. Re-baselining would
 *     handle a genuine reset, at the price of double-counting a transient dip
 *     (drop to 0, re-baseline, climb back → the same tokens filed twice). The
 *     whole cost feature errs low on purpose; this is that rule applied to the
 *     one case where the two directions conflict.
 *   - **Never a row for an agent with no counters.** `tokens: null` is "never
 *     measured", which is not "measured zero" — it contributes nothing, exactly
 *     as it does in `/metrics/costs`.
 *   - **Never an empty row.** A zero delta writes nothing at all, so an idle
 *     fleet costs the table nothing.
 *
 * `cost_usd` IS FROZEN AT WRITE TIME, and it is the one place in swarm-os where
 * a price is stored rather than recomputed. Everywhere else the tokens are
 * re-priced from the live rate card at read time, so a correction upstream fixes
 * yesterday too. Here that would be the bug: a rate change in September must not
 * silently rewrite what August cost. `null` (not `0`) when the delta could not
 * be priced, and a NULL day that later gains a priceable delta becomes that
 * amount — the merge rule lives in the SQL (`SwarmDb.upsertSessionTokenDaily`).
 */

import { withModule } from '../../logger.js';
import { estimateTokenCostUsd, type TokenCostRates } from '../providers/catalogue.js';
import type { SwarmDb, SessionTokenDailyRow } from '../db/index.js';
import type { Spawner } from '../spawner/index.js';

const log = withModule('orchestrator.costRollup');

/**
 * How long the daily history is kept. 90 days is the export's cap too, so the
 * table holds exactly what the widest export can ask for and not a row more.
 */
export const COST_ROLLUP_RETENTION_DAYS = 90;

/** The four counters, in the `TokenUsageView` spelling the session already uses. */
export interface RollupCounters {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * The minimal session shape the roll-up reads. A `SessionView` satisfies it,
 * with `tokens` = its optional `tokenUsage` (absent ⇒ `null` ⇒ skipped).
 */
export interface RollupSession {
  id: string;
  orchestratorId: string;
  provider: string;
  model: string;
  /** CUMULATIVE totals, or `null` for an agent that was never measured. */
  tokens: RollupCounters | null;
}

/** The watermark: the last cumulative recorded for a session, any day. */
export type RollupCum = RollupCounters;

export interface CostRollupDeps {
  /** Live agents to sweep. */
  sessions: () => Iterable<RollupSession>;
  /** Watermark lookup — `null` for a session with no row yet (its first ever). */
  lastCum: (sessionId: string) => RollupCum | null;
  /** Persist one day-row. Additive by contract; see the upsert statement. */
  write: (row: SessionTokenDailyRow) => void;
  /** Live rate card. `null` ⇒ the delta is filed with `cost_usd: null`. */
  rateLookup: (providerId: string, modelId: string) => TokenCostRates | null;
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * `YYYY-MM-DD` in UTC — the ledger's day boundary.
 *
 * UTC and not the host's zone, for the same reason the scheduler defaults to
 * UTC: this container is redeployed, moved and read from several timezones, and
 * a history whose day boundary follows `TZ` would gain or lose an hour on a
 * redeploy. The export says so; nothing here guesses a local day.
 */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A counter difference that can never be negative, and never `NaN`. */
function clamp0(now: number, before: number): number {
  const a = Number.isFinite(now) ? now : 0;
  const b = Number.isFinite(before) ? before : 0;
  const delta = a - b;
  return delta > 0 ? delta : 0;
}

/**
 * Run one roll-up pass. Pure with respect to the injected deps (the only side
 * effect is `write`). Returns the number of rows written — a sweep over an idle
 * fleet returns 0 and touches nothing.
 *
 * Exported for the unit test: two ticks in one day, the day boundary, a counter
 * reset, a simulated restart and an agent with no counters are all properties of
 * this function alone.
 */
export function rollupOnce(deps: CostRollupDeps): number {
  const day = utcDay(deps.now ? deps.now() : Date.now());
  let written = 0;

  for (const session of deps.sessions()) {
    try {
      const tokens = session.tokens;
      // Never measured ⇒ nothing to file. NOT a zero row: "no measurement" and
      // "measured zero" are different facts everywhere else in this feature.
      if (!tokens) continue;

      const before = deps.lastCum(session.id);
      const delta: RollupCounters = {
        in: clamp0(tokens.in, before?.in ?? 0),
        out: clamp0(tokens.out, before?.out ?? 0),
        cacheRead: clamp0(tokens.cacheRead, before?.cacheRead ?? 0),
        cacheWrite: clamp0(tokens.cacheWrite, before?.cacheWrite ?? 0),
      };
      // Nothing new since the last tick (an idle agent, or a counter that went
      // backwards and was clamped). No row, and the watermark stands — see the
      // "never re-baseline" rule in the module header.
      if (
        delta.in === 0 &&
        delta.out === 0 &&
        delta.cacheRead === 0 &&
        delta.cacheWrite === 0
      ) {
        continue;
      }

      // Priced at TODAY's card, for the delta only. A throwing lookup is a
      // missing price, not a lost row.
      let rates: TokenCostRates | null = null;
      try {
        rates = deps.rateLookup(session.provider, session.model);
      } catch {
        rates = null;
      }
      const costUsd = estimateTokenCostUsd(delta, rates);

      deps.write({
        day,
        session_id: session.id,
        orchestrator_id: session.orchestratorId,
        tokens_in: delta.in,
        tokens_out: delta.out,
        cache_read: delta.cacheRead,
        cache_write: delta.cacheWrite,
        cost_usd: costUsd,
        // The watermark moves to what we JUST observed, never to
        // `before + delta` — the two differ exactly when a counter was clamped,
        // and it is the observed figure that the next delta must be measured
        // against.
        cum_in: Number.isFinite(tokens.in) ? tokens.in : (before?.in ?? 0),
        cum_out: Number.isFinite(tokens.out) ? tokens.out : (before?.out ?? 0),
        cum_cache_read: Number.isFinite(tokens.cacheRead)
          ? tokens.cacheRead
          : (before?.cacheRead ?? 0),
        cum_cache_write: Number.isFinite(tokens.cacheWrite)
          ? tokens.cacheWrite
          : (before?.cacheWrite ?? 0),
      });
      written++;
    } catch (err) {
      log.warn({
        event: 'cost_rollup.session_failed',
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return written;
}

/**
 * Boot-time GC: drop daily rows older than `maxAgeDays`
 * (default {@link COST_ROLLUP_RETENTION_DAYS}). Same shape and same place in the
 * boot as `mailboxJanitor` — cheap, bounded, and the reason this table cannot
 * grow without limit.
 *
 * The cutoff is computed here rather than in SQL (`date('now','-90 days')` would
 * be the equivalent one-liner) so a test can pin a boundary without waiting 90
 * days, and so the day arithmetic uses the same UTC clock as `utcDay`.
 */
export function costRollupJanitor(
  db: SwarmDb,
  opts: { maxAgeDays?: number; now?: () => number } = {},
): { deleted: number } {
  const maxAgeDays = opts.maxAgeDays ?? COST_ROLLUP_RETENTION_DAYS;
  const now = opts.now ? opts.now() : Date.now();
  const cutoffDay = utcDay(now - maxAgeDays * 86_400_000);
  try {
    const deleted = db.deleteSessionTokenDailyBefore(cutoffDay);
    if (deleted > 0) {
      log.info({ event: 'cost_rollup.gc', deleted, cutoffDay, maxAgeDays });
    }
    return { deleted };
  } catch (err) {
    log.warn({
      event: 'cost_rollup.gc_failed',
      cutoffDay,
      error: err instanceof Error ? err.message : String(err),
    });
    return { deleted: 0 };
  }
}

export interface CostRollupHandle {
  stop(): void;
  /**
   * Run one pass now, guarded, returning the rows written.
   *
   * Exposed because the interval alone is not enough on this deployment: the
   * janitor starts before auto-resume, so its first pass sees an empty fleet,
   * and a container redeployed more often than the interval would never file a
   * row. `index.ts` calls it once the fleet is back — nothing is ever LOST
   * without it (the watermark makes the next tick pick the delta up whole), but
   * a delta straddling a restart would be filed under the day the tick lands
   * rather than the day it was billed.
   */
  tick(): number;
}

/**
 * Start the hourly roll-up. Unref'd interval, every tick guarded — a bad sweep
 * can never crash the 24/7 loop. `intervalMs <= 0` disables it (returns a no-op
 * handle whose `tick()` is a no-op too). Mirrors `startBudgetWatch`.
 *
 * ONE extra query per tick beside the writes, whatever the fleet size: the
 * watermarks of every session come back in a single statement and are indexed
 * by id here.
 */
export function startCostRollup(
  spawner: Spawner,
  db: SwarmDb,
  opts: { intervalMs: number },
): CostRollupHandle {
  const { intervalMs } = opts;
  if (intervalMs <= 0) {
    log.info({ event: 'cost_rollup.disabled', intervalMs });
    return { stop: () => undefined, tick: () => 0 };
  }

  const tick = (): number => {
    try {
      const cums = new Map<string, RollupCum>();
      for (const row of db.lastSessionTokenCums()) {
        cums.set(row.session_id, {
          in: row.cum_in,
          out: row.cum_out,
          cacheRead: row.cum_cache_read,
          cacheWrite: row.cum_cache_write,
        });
      }
      const written = rollupOnce({
        sessions: () => liveRollupSessions(spawner),
        lastCum: (id) => cums.get(id) ?? null,
        write: (row) => db.upsertSessionTokenDaily(row),
        // The SAME rate card `/metrics/costs` reads, looked up per tick and
        // never captured: the catalogue is cold at boot and warms up seconds
        // later, and a delta priced from a cold catalogue is filed as `null`
        // rather than as `$0`.
        rateLookup: (providerId, modelId) =>
          spawner.modelCatalogue?.costRates(providerId, modelId) ?? null,
      });
      if (written > 0) log.info({ event: 'cost_rollup.tick', rows: written });
      return written;
    } catch (err) {
      log.warn({
        event: 'cost_rollup.tick_failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  };

  // One pass NOW, not in an hour. On a fresh boot the fleet is not resumed yet
  // and this writes nothing; on a short-lived process (a test, a `docker run`
  // for a single job) it is the difference between a history and an empty table.
  tick();

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  log.info({ event: 'cost_rollup.started', intervalMs });
  return { stop: () => clearInterval(timer), tick };
}

/**
 * Every live agent of every live team, in the shape `rollupOnce` reads.
 *
 * `listActive()` rather than `list()`, like the budget watch: a destroyed team
 * has no counters left to move. A worker that EXITED but has not been reaped is
 * still listed by its team and is still swept — its final delta is filed on the
 * next tick, which is the only chance the ledger gets at it.
 *
 * Built from `toView()` so the roll-up reads the same `tokenUsage` the API and
 * the DB row are built from — including its "absent when never measured" rule,
 * which is exactly the `tokens: null` this module skips.
 */
function* liveRollupSessions(spawner: Spawner): Generator<RollupSession> {
  for (const orch of spawner.listActive()) {
    let views;
    try {
      views = orch.listSessions().map((s) => s.toView());
    } catch (err) {
      log.warn({
        event: 'cost_rollup.list_failed',
        orchId: orch.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    for (const view of views) {
      yield {
        id: view.id,
        orchestratorId: view.orchestratorId,
        provider: view.provider,
        model: view.model,
        tokens: view.tokenUsage
          ? {
              in: view.tokenUsage.in,
              out: view.tokenUsage.out,
              cacheRead: view.tokenUsage.cacheRead,
              cacheWrite: view.tokenUsage.cacheWrite,
            }
          : null,
      };
    }
  }
}

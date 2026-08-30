/**
 * Monitoring Lot 12 — the pure half of TEAM COSTS.
 *
 * Everything asserted here is an editorial rule that a "reasonable" refactor
 * would break silently:
 *
 *   1. Unknown is never zero. A team with no measurable burn is dropped from
 *      the median (not counted as 0, which would halve it and paint half the
 *      table amber), and removed workers with no counters render `—` rather
 *      than `$0.00`.
 *   2. The burn threshold is relative to the MEDIAN and strictly greater, so
 *      a single team can never light itself up.
 *   3. Cache hit is undefined at its own boundary (no input at all), and that
 *      is `—`, not 0%.
 */
import { describe, it, expect } from 'vitest';
import type { SessionCostRow, TeamCostRow } from '../api/client';
import {
  BURN_ANOMALY_FACTOR, formatBurn, formatCacheHit, formatRemovedCell,
  formatSessionTokenLine, isBurnAnomalous, medianBurn, removedBadge,
  removedSessions, sortTeamsByCostDesc,
} from './teamCost';
import { aggregateCostUsd, formatCostKpi } from './tokenCost';

function team(over: Partial<TeamCostRow> = {}): TeamCostRow {
  return {
    orchId: 'o1',
    name: 'ATLAS',
    live: 3,
    total: {
      in: 1_000, out: 200, cacheRead: 4_000, cacheWrite: 100, costUsd: 12.5,
    },
    removed: { count: 0, costUsd: null },
    burnPerHour: 1.84,
    ...over,
  };
}

function sess(over: Partial<SessionCostRow> = {}): SessionCostRow {
  return {
    id: 's1',
    name: 'WORKER-1',
    type: 'worker',
    status: 'killed',
    removed: true,
    tokens: { in: 1_000, out: 200, cacheRead: 3_000, cacheWrite: 50 },
    costUsd: 0.42,
    ...over,
  };
}

// ── median burn ─────────────────────────────────────────────────────────────

describe('medianBurn', () => {
  it('is null when not one team reports a rate', () => {
    expect(medianBurn([])).toBeNull();
    expect(medianBurn([team({ burnPerHour: null }), team({ burnPerHour: null })]))
      .toBeNull();
  });

  it('takes the middle value of an odd count', () => {
    const teams = [0.2, 9, 0.3].map((b) => team({ burnPerHour: b }));
    expect(medianBurn(teams)).toBe(0.3);
  });

  it('averages the two middles of an even count', () => {
    const teams = [1, 2, 3, 4].map((b) => team({ burnPerHour: b }));
    expect(medianBurn(teams)).toBe(2.5);
  });

  it('DROPS unmeasured teams instead of counting them as zero', () => {
    // With nulls folded in as 0 the median of [0, 0, 1, 5] would be 0.5 and
    // the 1 $/h team would look like a runaway. Dropping them gives 3.
    const teams = [
      team({ burnPerHour: null }), team({ burnPerHour: null }),
      team({ burnPerHour: 1 }), team({ burnPerHour: 5 }),
    ];
    expect(medianBurn(teams)).toBe(3);
  });

  it('ignores negative and non-finite rates from a drifting backend', () => {
    const teams = [
      team({ burnPerHour: -4 }),
      team({ burnPerHour: Number.NaN }),
      team({ burnPerHour: 2 }),
    ];
    expect(medianBurn(teams)).toBe(2);
  });
});

// ── the anomaly rule ────────────────────────────────────────────────────────

describe('isBurnAnomalous', () => {
  it('never fires on a single team — its own burn IS the median', () => {
    const teams = [team({ burnPerHour: 42 })];
    const m = medianBurn(teams);
    expect(isBurnAnomalous(42, m)).toBe(false);
  });

  it('fires strictly above the factor, not at it', () => {
    expect(isBurnAnomalous(3, 1)).toBe(false);
    expect(isBurnAnomalous(3.01, 1)).toBe(true);
    expect(BURN_ANOMALY_FACTOR).toBe(3);
  });

  it('never fires on an unknown burn or an unknown median', () => {
    expect(isBurnAnomalous(null, 1)).toBe(false);
    expect(isBurnAnomalous(99, null)).toBe(false);
  });
});

// ── cache hit ───────────────────────────────────────────────────────────────

describe('formatCacheHit', () => {
  it('is cacheRead / (in + cacheRead), rounded', () => {
    expect(formatCacheHit({ in: 1_000, out: 0, cacheRead: 3_000, cacheWrite: 0 }))
      .toBe('75%');
    expect(formatCacheHit({ in: 2, out: 0, cacheRead: 1, cacheWrite: 0 }))
      .toBe('33%');
  });

  it('renders both extremes as real numbers', () => {
    expect(formatCacheHit({ in: 500, out: 9, cacheRead: 0, cacheWrite: 0 }))
      .toBe('0%');
    expect(formatCacheHit({ in: 0, out: 9, cacheRead: 500, cacheWrite: 0 }))
      .toBe('100%');
  });

  it('is `—` when the denominator is 0 — never a fabricated 0%', () => {
    expect(formatCacheHit({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }))
      .toBe('—');
  });

  it('is `—` when there are no counters at all', () => {
    expect(formatCacheHit(null)).toBe('—');
  });
});

describe('formatSessionTokenLine', () => {
  it('reads IN · OUT · CACHE HIT', () => {
    expect(formatSessionTokenLine({
      in: 1_000, out: 200, cacheRead: 3_000, cacheWrite: 50,
    })).toBe('IN 1K · OUT 200 · CACHE HIT 75%');
  });
});

// ── the REMOVED cell ────────────────────────────────────────────────────────

describe('formatRemovedCell', () => {
  it('is a bare em-dash when nobody ever left the team', () => {
    expect(formatRemovedCell({ count: 0, costUsd: null })).toBe('—');
    expect(formatRemovedCell({ count: 0, costUsd: 0 })).toBe('—');
  });

  it('names the count and their share', () => {
    expect(formatRemovedCell({ count: 4, costUsd: 12.4 }))
      .toBe('INCL. 4 REMOVED · $12.40');
  });

  it('keeps the count when the share is unknown (pre-Lot-11 sessions)', () => {
    // The distinction that matters: four workers ARE folded into the total
    // above, we simply cannot say how much of it is theirs.
    expect(formatRemovedCell({ count: 4, costUsd: null }))
      .toBe('INCL. 4 REMOVED · —');
  });
});

describe('formatBurn', () => {
  it('formats a rate and em-dashes an unmeasured one', () => {
    expect(formatBurn(1.84)).toBe('$1.84');
    expect(formatBurn(0)).toBe('$0.00');
    expect(formatBurn(null)).toBe('—');
  });
});

// ── ordering ────────────────────────────────────────────────────────────────

describe('sortTeamsByCostDesc', () => {
  it('puts the biggest bill first and the unpriced teams last', () => {
    const teams = [
      team({ orchId: 'a', name: 'A', total: { ...team().total, costUsd: 3 } }),
      team({ orchId: 'b', name: 'B', total: { ...team().total, costUsd: null } }),
      team({ orchId: 'c', name: 'C', total: { ...team().total, costUsd: 30 } }),
    ];
    expect(sortTeamsByCostDesc(teams).map((t) => t.orchId)).toEqual(['c', 'a', 'b']);
  });

  it('breaks ties on name so the list does not reshuffle between polls', () => {
    const teams = [
      team({ orchId: 'z', name: 'ZULU', total: { ...team().total, costUsd: 5 } }),
      team({ orchId: 'a', name: 'ALPHA', total: { ...team().total, costUsd: 5 } }),
    ];
    expect(sortTeamsByCostDesc(teams).map((t) => t.name)).toEqual(['ALPHA', 'ZULU']);
  });

  it('does not mutate its input', () => {
    const teams = [
      team({ orchId: 'a', total: { ...team().total, costUsd: 1 } }),
      team({ orchId: 'b', total: { ...team().total, costUsd: 9 } }),
    ];
    sortTeamsByCostDesc(teams);
    expect(teams.map((t) => t.orchId)).toEqual(['a', 'b']);
  });
});

describe('removedSessions', () => {
  it('keeps removed sessions only, dearest first', () => {
    const rows = removedSessions([
      sess({ id: 'live', removed: false, costUsd: 99 }),
      sess({ id: 'cheap', costUsd: 0.1 }),
      sess({ id: 'dear', costUsd: 4 }),
    ]);
    expect(rows.map((s) => s.id)).toEqual(['dear', 'cheap']);
  });

  it('sinks the unpriced ones below the priced ones', () => {
    const rows = removedSessions([
      sess({ id: 'nodata', costUsd: null, tokens: null }),
      sess({ id: 'cheap', costUsd: 0.01 }),
    ]);
    expect(rows.map((s) => s.id)).toEqual(['cheap', 'nodata']);
  });
});

// ── the badge ───────────────────────────────────────────────────────────────

describe('removedBadge', () => {
  it('mutes a deliberate kill — it is the normal end of a worker', () => {
    expect(removedBadge('killed')).toEqual({
      label: 'KILLED', cls: 'badge-reason killed',
    });
  });

  it('keeps the warn register for anything else', () => {
    expect(removedBadge('failed')).toEqual({ label: 'REMOVED', cls: 'badge-reason' });
    expect(removedBadge('stopped')).toEqual({ label: 'REMOVED', cls: 'badge-reason' });
  });
});

// ── the BURN /H aggregate (Lot 11 machinery, reused verbatim) ───────────────

describe('BURN /H aggregate', () => {
  const burnKpi = (teams: TeamCostRow[]) =>
    formatCostKpi(aggregateCostUsd(teams.map((t) => t.burnPerHour)));

  it('sums the rates it knows', () => {
    expect(burnKpi([
      team({ burnPerHour: 1.84 }), team({ burnPerHour: 0.16 }),
    ])).toBe('$2.00');
  });

  it('marks the sum as a LOWER BOUND when a team is unmeasured', () => {
    expect(burnKpi([
      team({ burnPerHour: 1.84 }), team({ burnPerHour: null }),
    ])).toBe('≥$1.84');
  });

  it('is a bare em-dash when nothing at all is measurable', () => {
    expect(burnKpi([team({ burnPerHour: null })])).toBe('—');
    expect(burnKpi([])).toBe('—');
  });
});

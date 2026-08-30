// Tests for `tokenCost.ts` — the TOKENS · COST column and the EST. COST KPI
// (docs/monitoring-agents.md, Lot 11).
//
// Everything here defends one editorial rule: an amount this UI prints must
// be either measured or absent, never inferred. The three ways that rule can
// be broken are exactly the three groups below — rendering `$0.00` for money
// we cannot see, rounding real spend down to nothing, and summing a swarm
// that is only half priced into a total that looks complete.

import { describe, it, expect } from 'vitest';
import {
  aggregateCostUsd, costBasisTag, costBasisTitle, formatCacheHit,
  formatCostKpi, formatCostLine, formatTokenCount, formatTokenIoLine,
  formatUsd, tokenBreakdownTitle,
} from './tokenCost';
import type { TokenUsageView } from '../api/client';

function usage(over: Partial<TokenUsageView> = {}): TokenUsageView {
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

// ── compact token counts ────────────────────────────────────────────────────

describe('formatTokenCount', () => {
  it('prints counts below 1K raw', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(1)).toBe('1');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('switches to K at exactly 1000', () => {
    expect(formatTokenCount(1_000)).toBe('1K');
    expect(formatTokenCount(1_499)).toBe('1K');
    expect(formatTokenCount(141_000)).toBe('141K');
  });

  it('stays in K up to the megaton boundary', () => {
    // `1000K` rather than `1.0M`: 999 999 is below the M threshold, and the
    // CONTEXT column one cell to the left renders this same number the same
    // way (both go through `formatTokensShort`). A prettier rounding here
    // would make one agent look like two different measurements.
    expect(formatTokenCount(999_999)).toBe('1000K');
  });

  it('switches to M at exactly 1 000 000, with one decimal', () => {
    expect(formatTokenCount(1_000_000)).toBe('1.0M');
    expect(formatTokenCount(18_200_000)).toBe('18.2M');
  });

  it('renders the em-dash for anything that is not a count', () => {
    expect(formatTokenCount(null)).toBe('—');
    expect(formatTokenCount(undefined)).toBe('—');
    expect(formatTokenCount(Number.NaN)).toBe('—');
    expect(formatTokenCount(-1)).toBe('—');
  });
});

// ── money ───────────────────────────────────────────────────────────────────

describe('formatUsd', () => {
  it('prints two decimals and thousands separators', () => {
    expect(formatUsd(5.61)).toBe('$5.61');
    expect(formatUsd(5.6)).toBe('$5.60');
    expect(formatUsd(1_234.5)).toBe('$1,234.50');
    expect(formatUsd(5.615)).toBe('$5.62');
  });

  it('keeps a true zero as $0.00', () => {
    // A model priced at zero is a fact. Collapsing it into `<$0.01` would
    // report free spend as "some spend we rounded away".
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('never rounds real spend down to nothing', () => {
    expect(formatUsd(0.009)).toBe('<$0.01');
    expect(formatUsd(0.0001)).toBe('<$0.01');
    expect(formatUsd(0.01)).toBe('$0.01');
  });

  it('returns null — not a placeholder — when there is no amount', () => {
    // `null` lets the caller choose between `—` and `— EST`; a placeholder
    // string here would end up printed as `$—`.
    expect(formatUsd(null)).toBeNull();
    expect(formatUsd(undefined)).toBeNull();
    expect(formatUsd(Number.NaN)).toBeNull();
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatUsd(-3)).toBeNull();
  });
});

// ── the two cell lines + the tooltip ────────────────────────────────────────

describe('cell lines', () => {
  it('formats the IN · OUT line', () => {
    expect(formatTokenIoLine(usage())).toBe('IN 18.2M · OUT 141K');
  });

  it('formats the cost line, EST included', () => {
    expect(formatCostLine(usage())).toBe('$5.61 EST');
  });

  it('keeps EST when the tokens are counted but unpriced', () => {
    expect(formatCostLine(usage({ costUsd: null }))).toBe('— EST');
  });

  it('ventilates all four buckets at full precision in the title', () => {
    expect(tokenBreakdownTitle(usage())).toBe(
      'IN 18,200,000 · OUT 141,000 · CACHE READ 1,204,556 '
      + '· CACHE WRITE 88,120 · CACHE HIT 6% · EST $5.61',
    );
  });

  it('shows the unpriced title without inventing an amount', () => {
    expect(tokenBreakdownTitle(usage({ costUsd: null }))).toContain('EST —');
  });
});

// ── Lot 13 · where the amount came from ─────────────────────────────────────
//
// An unlabelled `$5.61` is the one rendering that lets an operator read an
// estimate as an invoice (or the reverse). The tag is therefore part of the
// amount, never an optional decoration, and it survives the amount going
// missing.

describe('cost basis', () => {
  it('tags an estimate EST and a provider figure RPT', () => {
    expect(costBasisTag('estimated')).toBe('EST');
    expect(costBasisTag('reported')).toBe('RPT');
  });

  it('spells the tag out for the tooltip', () => {
    expect(costBasisTitle('estimated')).toBe('estimated from catalogue rates');
    expect(costBasisTitle('reported')).toBe('reported by the provider');
  });

  it('falls back to the humbler claim on an unknown basis', () => {
    // A backend ahead of this build (a third basis) must never be rendered as
    // "reported by the provider" — the claim that promises the least wins.
    const drifted = 'invoiced' as unknown as 'estimated';
    expect(costBasisTag(drifted)).toBe('EST');
    expect(costBasisTitle(drifted)).toBe('estimated from catalogue rates');
  });

  it('suffixes the cell line with the basis, both ways', () => {
    expect(formatCostLine(usage({ costBasis: 'reported' }))).toBe('$5.61 RPT');
    expect(formatCostLine(usage({ costBasis: 'estimated' }))).toBe('$5.61 EST');
  });

  it('keeps the tag when a reported session carries no amount', () => {
    expect(formatCostLine(usage({ costBasis: 'reported', costUsd: null })))
      .toBe('— RPT');
  });

  it('labels the tooltip amount with the same tag as the line', () => {
    expect(tokenBreakdownTitle(usage({ costBasis: 'reported' })))
      .toContain('RPT $5.61');
    expect(tokenBreakdownTitle(usage({ costBasis: 'reported' })))
      .not.toContain('EST');
  });
});

// ── Lot 13 · cache hit, moved here from teamCost ─────────────────────────────
//
// The per-agent tooltip and the team drill-down now read the same function;
// `lib/teamCost.ts` re-exports it, and `teamCost.test.ts` still covers the
// team-shaped call. What matters here is that the ratio reaches the tooltip.

describe('formatCacheHit in the tooltip', () => {
  it('reports the share of input served from cache', () => {
    expect(formatCacheHit(usage({ in: 1_000, cacheRead: 3_000 }))).toBe('75%');
  });

  it('em-dashes a session that has read nothing at all', () => {
    // `in + cacheRead === 0`: a 0% here would read as "the cache is broken"
    // rather than "nothing was measured yet".
    expect(formatCacheHit(usage({ in: 0, cacheRead: 0 }))).toBe('—');
    expect(tokenBreakdownTitle(usage({ in: 0, cacheRead: 0 })))
      .toContain('CACHE HIT —');
  });

  it('ignores the out/cacheWrite buckets entirely', () => {
    // Cache WRITE is spend, not a hit: folding it into the denominator would
    // make a freshly primed agent look like a badly cached one.
    expect(formatCacheHit(usage({ in: 1, cacheRead: 1, out: 9_999, cacheWrite: 9_999 })))
      .toBe('50%');
  });
});

// ── the aggregate behind EST. COST ──────────────────────────────────────────

describe('aggregateCostUsd', () => {
  it('is null — never 0 — when nothing is priced', () => {
    expect(aggregateCostUsd([])).toEqual({ total: null, partial: false });
    expect(aggregateCostUsd([null, undefined])).toEqual({ total: null, partial: false });
  });

  it('sums a fully priced swarm without flagging it partial', () => {
    const agg = aggregateCostUsd([1.5, 2.25, 0]);
    expect(agg.total).toBeCloseTo(3.75, 10);
    expect(agg.partial).toBe(false);
  });

  it('flags a partial total when some agents report no cost', () => {
    const agg = aggregateCostUsd([1.5, null, 2.5]);
    expect(agg.total).toBeCloseTo(4, 10);
    expect(agg.partial).toBe(true);
  });

  it('treats a drifting backend value as unknown rather than poisoning the sum', () => {
    const agg = aggregateCostUsd([Number.NaN, 2, -1, Number.POSITIVE_INFINITY]);
    expect(agg.total).toBe(2);
    expect(agg.partial).toBe(true);
  });

  it('never reports partial without a total to qualify', () => {
    expect(aggregateCostUsd([null, Number.NaN]).partial).toBe(false);
  });
});

describe('formatCostKpi', () => {
  it('renders the em-dash when nothing is known', () => {
    expect(formatCostKpi({ total: null, partial: false })).toBe('—');
  });

  it('renders a plain total when every displayed agent is priced', () => {
    expect(formatCostKpi({ total: 12.4, partial: false })).toBe('$12.40');
  });

  it('prefixes ≥ when the total is only a lower bound', () => {
    expect(formatCostKpi({ total: 12.4, partial: true })).toBe('≥$12.40');
  });
});

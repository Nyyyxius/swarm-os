// Tests for `providerQuota.ts` — the PROVIDER QUOTA chip of `#/monitoring`
// (docs/monitoring-agents.md, Lot 13).
//
// The chip makes one claim and it has to be exactly right: this is the
// ACCOUNT's budget, shared by every agent on that provider. Three failure
// modes follow, and they are what the groups below defend:
//
//   1. Six codex workers must render ONE line. Six identical ones would read
//      as six independent budgets — and so would five slightly different
//      ones, which is what staggered per-session reads of a single account
//      actually produce.
//   2. A segment the provider did not report must vanish, not become `—`:
//      four words is the whole line's budget. And a "reading" that says
//      nothing about the budget is not a reading.
//   3. The tint must fire on what is DISPLAYED, at the quota thresholds
//      (80 / 95) — which have nothing to do with the context ones.

import { describe, it, expect } from 'vitest';
import {
  providerQuotaLines, quotaTint, QUOTA_BAD_PERCENT, QUOTA_WARN_PERCENT,
  type QuotaSource,
} from './providerQuota';
import type { ProviderQuotaView } from '../api/client';

function quota(over: Partial<ProviderQuotaView> = {}): ProviderQuotaView {
  return {
    usedPercent: 62,
    resetsAt: '2026-08-30T18:00:00.000Z',
    plan: 'pro',
    ...over,
  };
}

function row(over: Partial<QuotaSource> = {}): QuotaSource {
  return { provider: 'codex', providerQuota: quota(), ...over };
}

/** Local short clock, matching what the component renders. */
const resetLabel = (iso: string) => {
  const d = new Date(Date.parse(iso));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `RESETS ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

describe('providerQuotaLines', () => {
  it('renders nothing at all when no session reports a quota', () => {
    // The block is hidden by its own emptiness — a claude-only swarm never
    // sees an empty PROVIDER QUOTA heading.
    expect(providerQuotaLines([])).toEqual([]);
    expect(providerQuotaLines([
      { provider: 'claude', providerQuota: null },
      { provider: 'gemini' },
    ])).toEqual([]);
  });

  it('builds the full line, provider first', () => {
    const [line] = providerQuotaLines([row()]);
    expect(line?.text).toBe(
      `CODEX · 62% USED · ${resetLabel('2026-08-30T18:00:00.000Z')} · PRO`,
    );
    expect(line?.provider).toBe('codex');
  });

  it('says out loud that the budget belongs to the account', () => {
    // The whole point of the chip: `62% USED` read as an AGENT figure would
    // suggest spawning a second codex agent to spread the load.
    const [line] = providerQuotaLines([row()]);
    expect(line?.title).toBe(
      'codex account quota — shared across every codex agent',
    );
  });

  it('collapses identical readings from every agent on the account', () => {
    const lines = providerQuotaLines([
      row(), row(), row(),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain('62% USED');
  });

  it('collapses staggered readings of one account into the freshest', () => {
    // THE case this module exists for. Each session reads the account on its
    // own ~15 s TTL, so six codex workers report six nearby percentages.
    // Rendering them as six lines — each titled "shared across every codex
    // agent" — would be six contradictory claims about one budget.
    // Consumption only climbs inside a window, so the highest number is both
    // the most recent and the conservative one.
    const lines = providerQuotaLines([
      row({ providerQuota: quota({ usedPercent: 58 }) }),
      row({ providerQuota: quota({ usedPercent: 65 }) }),
      row({ providerQuota: quota({ usedPercent: 61 }) }),
      row({ providerQuota: quota({ usedPercent: 62 }) }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.segments[1]?.text).toBe('65% USED');
  });

  it('never averages the readings into a number nobody reported', () => {
    const [line] = providerQuotaLines([
      row({ providerQuota: quota({ usedPercent: 20 }) }),
      row({ providerQuota: quota({ usedPercent: 80 }) }),
    ]);
    expect(line?.segments[1]?.text).toBe('80% USED');
    expect(line?.text).not.toContain('50%');
  });

  it('keeps a percentless reading only until a real one turns up', () => {
    const withPct = providerQuotaLines([
      row({ providerQuota: quota({ usedPercent: null }) }),
      row({ providerQuota: quota({ usedPercent: 33 }) }),
    ]);
    expect(withPct[0]?.text).toContain('33% USED');
    // …and the other way round, so the result does not depend on row order.
    const reversed = providerQuotaLines([
      row({ providerQuota: quota({ usedPercent: 33 }) }),
      row({ providerQuota: quota({ usedPercent: null }) }),
    ]);
    expect(reversed[0]?.text).toContain('33% USED');
  });

  it('separates two DIFFERENT providers, which really are two budgets', () => {
    const lines = providerQuotaLines([
      row({ provider: 'codex', providerQuota: quota({ usedPercent: 40 }) }),
      row({ provider: 'opencode', providerQuota: quota({ usedPercent: 91 }) }),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.provider)).toEqual(['codex', 'opencode']);
  });

  it('orders deterministically, whatever order the rows arrive in', () => {
    // The rows follow the table's CTX/COST sort, which the operator flips at
    // will; the chip must not reshuffle underneath them when they do.
    const a = row({ provider: 'codex', providerQuota: quota({ usedPercent: 10 }) });
    const b = row({ provider: 'opencode', providerQuota: quota({ usedPercent: 88 }) });
    expect(providerQuotaLines([a, b]).map((l) => l.text))
      .toEqual(providerQuotaLines([b, a]).map((l) => l.text));
  });

  it('puts a provider-less reading last, whatever the collator thinks', () => {
    const lines = providerQuotaLines([
      { provider: null, providerQuota: quota({ usedPercent: 99, resetsAt: null, plan: null }) },
      row({ providerQuota: quota({ usedPercent: 5, resetsAt: null, plan: null }) }),
    ]);
    expect(lines.map((l) => l.text)).toEqual(['CODEX · 5% USED', '99% USED']);
  });

  it('drops the segments the provider did not report', () => {
    const [line] = providerQuotaLines([
      row({ providerQuota: quota({ resetsAt: null, plan: null }) }),
    ]);
    expect(line?.text).toBe('CODEX · 62% USED');
    expect(line?.text).not.toContain('—');
  });

  it('still reports a reset time for a plan-less, percentless account', () => {
    const [line] = providerQuotaLines([
      row({ providerQuota: quota({ usedPercent: null, plan: null }) }),
    ]);
    expect(line?.text).toBe(`CODEX · ${resetLabel('2026-08-30T18:00:00.000Z')}`);
  });

  it('ignores an unparseable reset timestamp instead of printing an em-dash', () => {
    const [line] = providerQuotaLines([
      row({ providerQuota: quota({ resetsAt: 'tomorrow-ish' }) }),
    ]);
    expect(line?.text).toBe('CODEX · 62% USED · PRO');
  });

  it('treats a drifting percentage as unreported', () => {
    const lines = providerQuotaLines([
      row({ providerQuota: quota({ usedPercent: Number.NaN, resetsAt: null, plan: null }) }),
      row({ providerQuota: quota({ usedPercent: -5, resetsAt: null, plan: null }) }),
    ]);
    // Nothing left to say once the only segment is gone — no bare `CODEX`
    // line claiming a quota exists and refusing to describe it.
    expect(lines).toEqual([]);
  });

  it('renders a quota with every field null as no line at all', () => {
    expect(providerQuotaLines([
      row({ providerQuota: { usedPercent: null, resetsAt: null, plan: null } }),
    ])).toEqual([]);
  });

  it('drops a reading that says nothing about the budget itself', () => {
    // A plan name is not a budget. `CODEX · PRO` would claim a quota exists
    // and then refuse to describe it — worse than rendering nothing.
    expect(providerQuotaLines([
      row({ providerQuota: quota({ usedPercent: null, resetsAt: null }) }),
    ])).toEqual([]);
    // Same with no provider to prefix it: still nothing worth a line.
    expect(providerQuotaLines([
      { provider: null, providerQuota: quota({ usedPercent: null, resetsAt: null }) },
    ])).toEqual([]);
  });

  it('survives a session that reports a quota but no provider', () => {
    const [line] = providerQuotaLines([
      { provider: null, providerQuota: quota({ resetsAt: null }) },
    ]);
    expect(line?.text).toBe('62% USED · PRO');
    expect(line?.title).toBe('account quota — shared across every agent on this provider');
  });

  it('rounds the percentage and uppercases the plan', () => {
    const [line] = providerQuotaLines([
      row({ providerQuota: quota({ usedPercent: 61.6, plan: ' plus ', resetsAt: null }) }),
    ]);
    expect(line?.text).toBe('CODEX · 62% USED · PLUS');
  });
});

describe('quotaTint', () => {
  it('leaves a healthy budget uncoloured', () => {
    expect(quotaTint(0)).toBeNull();
    expect(quotaTint(79)).toBeNull();
  });

  it('turns amber at 80 and red at 95, inclusive', () => {
    expect(QUOTA_WARN_PERCENT).toBe(80);
    expect(QUOTA_BAD_PERCENT).toBe(95);
    expect(quotaTint(80)).toBe('var(--warn)');
    expect(quotaTint(94)).toBe('var(--warn)');
    expect(quotaTint(95)).toBe('var(--bad)');
    expect(quotaTint(100)).toBe('var(--bad)');
  });

  it('judges the number the operator can actually see', () => {
    // 79.6 renders as `80% USED`; an uncoloured line saying 80 would be a
    // threshold the operator cannot reproduce.
    const [line] = providerQuotaLines([
      row({ providerQuota: quota({ usedPercent: 79.6, resetsAt: null, plan: null }) }),
    ]);
    expect(line?.segments[1]).toEqual({ text: '80% USED', tint: 'var(--warn)' });
  });
});

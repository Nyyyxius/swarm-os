// PROVIDER QUOTA — the sidebar chip of `#/monitoring`
// (docs/monitoring-agents.md, Lot 13).
//
// codex reports its `rate_limits` (used_percent / resets_at / plan) on the
// same `token_count` line the context tracker already reads, so the server
// hands it to us per session. It is nonetheless an ACCOUNT budget: every
// codex agent on this instance draws from the same bucket. Two consequences
// shape everything below.
//
//   1. ONE line per ACCOUNT, not one per agent — and not one per distinct
//      reading either. Each session reports the account from its own CLI
//      output, on its own ~15 s tracker TTL, so six codex workers realistically
//      say 58 / 61 / 62 / 62 / 64 / 65 %. De-duplicating on the rendered text
//      would then print FIVE lines, each titled "shared across every codex
//      agent" — six independent budgets, which is the exact misreading this
//      module exists to prevent, now self-contradictory as well.
//
//      So the readings of one provider are COLLAPSED, and the highest
//      percentage wins: consumption only climbs inside a window, so the
//      largest number is both the freshest reading and the conservative one.
//      Nothing is averaged — an average of six staggered reads of one counter
//      is a number nobody reported.
//   2. The line is chrome, not a row of the table. It sits in the sidebar
//      under the context counts, in the muted 9 px register, because it
//      describes the account rather than any agent the operator is looking at.
//
// Same `—`-not-zero discipline as the rest of the page, applied one notch
// further: a segment we cannot fill is DROPPED rather than em-dashed. A
// `RESETS —` would be noise in a four-word line, and a reading with nothing
// left to say about the BUDGET (no percentage, no reset time — a bare plan
// name says nothing) is not rendered at all.

import type { ProviderQuotaView } from '../api/client';
import { formatClockShort } from './format';

/** Consumed share at which the percentage turns amber. */
export const QUOTA_WARN_PERCENT = 80;
/** …and at which it turns red. */
export const QUOTA_BAD_PERCENT = 95;

/** One `·`-separated piece of the line, with the colour it must be painted. */
export interface QuotaSegment {
  text: string;
  /** A CSS colour token, or `null` for the line's own muted colour. */
  tint: string | null;
}

export interface ProviderQuotaLine {
  /** Stable identity — de-duplication key and React key. */
  key: string;
  /** Provider id as the session reports it (`codex`), or `null`. */
  provider: string | null;
  segments: QuotaSegment[];
  /** The whole line as text: `CODEX · 62% USED · RESETS 18:00 · PRO`. */
  text: string;
  /** Native `title`: says out loud that this is an account-wide budget. */
  title: string;
}

/** What a row has to carry to contribute a quota reading. */
export interface QuotaSource {
  provider: string | null;
  providerQuota?: ProviderQuotaView | null;
}

/**
 * `--warn` past 80%, `--bad` past 95%, nothing below.
 *
 * Thresholds on the DISPLAYED (rounded) number rather than the raw one, so a
 * line reading `80% USED` is never left uncoloured because the wire said
 * 79.6. What the operator sees is what got judged.
 */
export function quotaTint(usedPercent: number): string | null {
  if (usedPercent >= QUOTA_BAD_PERCENT) return 'var(--bad)';
  if (usedPercent >= QUOTA_WARN_PERCENT) return 'var(--warn)';
  return null;
}

function quotaTitle(provider: string | null): string {
  return provider
    ? `${provider} account quota — shared across every ${provider} agent`
    : 'account quota — shared across every agent on this provider';
}

/** One line per provider ACCOUNT among the rows currently on screen. */
export function providerQuotaLines(
  rows: readonly QuotaSource[],
): ProviderQuotaLine[] {
  type Candidate = ProviderQuotaLine & { pct: number | null };
  const byAccount = new Map<string, Candidate>();

  for (const row of rows) {
    const quota = row.providerQuota;
    if (!quota) continue;

    const provider = typeof row.provider === 'string' && row.provider.trim()
      ? row.provider.trim().toLowerCase()
      : null;

    const segments: QuotaSegment[] = [];
    if (provider) segments.push({ text: provider.toUpperCase(), tint: null });

    // The percentage is the only coloured thing on the page that is NOT a
    // context reading — hence the explicit `USED`: a bare `62%` two blocks
    // under the OK/WARN/HIGH context counts would be read as context.
    let pct: number | null = null;
    if (typeof quota.usedPercent === 'number'
      && Number.isFinite(quota.usedPercent)
      && quota.usedPercent >= 0) {
      pct = Math.round(quota.usedPercent);
      segments.push({ text: `${pct}% USED`, tint: quotaTint(pct) });
    }

    // Local short clock: the reset is something the operator waits for on
    // their own wall clock, so UTC would make them do the arithmetic.
    const resetsAt = quota.resetsAt ? Date.parse(quota.resetsAt) : Number.NaN;
    const hasReset = Number.isFinite(resetsAt);
    if (hasReset) {
      segments.push({ text: `RESETS ${formatClockShort(resetsAt)}`, tint: null });
    }

    const plan = typeof quota.plan === 'string' && quota.plan.trim()
      ? quota.plan.trim().toUpperCase()
      : null;
    if (plan) segments.push({ text: plan, tint: null });

    // A reading has to say something about the BUDGET to be one. Neither the
    // provider name nor the plan qualifies: `CODEX · PRO` claims a quota
    // exists and then refuses to describe it, which is worse than the silence
    // of not rendering the block at all.
    if (pct === null && !hasReset) continue;

    const text = segments.map((s) => s.text).join(' · ');
    // Keyed by ACCOUNT (the provider), never by the rendered text — see the
    // header note. Highest percentage wins; a reading with no percentage at
    // all only holds the slot while nothing better has arrived.
    const account = provider ?? '';
    const current = byAccount.get(account);
    const better = current === null || current === undefined
      || (pct !== null && (current.pct === null || pct > current.pct));
    if (better) {
      byAccount.set(account, {
        key: `quota:${account}`,
        provider,
        segments,
        text,
        title: quotaTitle(provider),
        pct,
      });
    }
  }

  // Deterministic order — the map's insertion order follows the TABLE's
  // current sort, which the operator can flip at will; the chip must not
  // reorder underneath them when they do.
  return [...byAccount.values()]
    .sort((a, b) => {
      // A provider-less reading goes last, and explicitly so: a sentinel
      // character would be at the mercy of the collator's idea of where it
      // sorts, which is not a thing to bet a stable list on.
      if ((a.provider === null) !== (b.provider === null)) {
        return a.provider === null ? 1 : -1;
      }
      if (a.provider !== null && b.provider !== null && a.provider !== b.provider) {
        return a.provider.localeCompare(b.provider);
      }
      // One line per account means two entries can no longer share a provider;
      // the text tie-break is here so the comparator is total anyway.
      return a.text.localeCompare(b.text);
    })
    .map(({ pct: _pct, ...line }) => line);
}

/**
 * Auto-compact at a context threshold (docs/auto-compact.md, D3) — the
 * DECISION, and nothing else.
 *
 * One pure function, called once per idle boundary per session by
 * `Orchestrator._onSessionIdle`. It reads a snapshot and answers "arm a
 * `/compact`, or don't, and say why". It holds no state, touches no PTY, reads
 * no clock and never throws, which is what makes the whole feature testable
 * without a live agent: every one of the eight refusals below is one call.
 *
 * The guards are ORDERED, and the order is the contract — the reason an
 * operator reads in `session.auto_compact_skipped` is the FIRST thing that
 * stopped the arming, so the order has to run from "this will never fire" to
 * "not yet". Each one exists for a failure that was actually reasoned about;
 * see the comment on each.
 */

import type { ContextUsageView } from './session.js';

/**
 * Minimum growth, in POINTS of the context window, between two automatic
 * compactions of the same agent.
 *
 * This is the anti-loop (docs/auto-compact.md, D3 — objection 3 of the
 * `http/routes/hooks.ts` header, "it can feed itself"). Without it, an agent
 * whose post-compaction floor (system prompt + MCP tool list + the summary) is
 * itself above the threshold would be compacted at every single idle boundary,
 * forever, each compaction costing a model call and degrading the agent's own
 * working memory. With it, such an agent is re-compacted every 10 points of
 * REAL growth instead — which is also the answer to objection 2 (cadence/cost).
 *
 * Absolute points, deliberately not a fraction of the headroom: 10 points of a
 * 200k window is ~20k tokens of new conversation, which is a meaningful amount
 * of work whatever the threshold is set to.
 */
export const AUTO_COMPACT_MIN_GROWTH_PCT = 10;

/**
 * What the server asks the model to preserve when IT is the one arming the
 * compaction (docs/auto-compact.md, D8).
 *
 * A server constant, never user or agent input: it is typed into a live prompt
 * buffer, and ONE LINE is structural — an embedded `\r` would submit the
 * slash command half-typed (`Session.notifySignal`'s JSDoc has the full story
 * on why the CR cannot ride the same chunk).
 *
 * Content-wise it names the things an agent loses in a summary and cannot
 * recover from the workspace: who it is working for, which teammate it asked
 * what, and what it still owes an answer to. The final clause is the other half
 * of guarantee G (docs/auto-compact.md §1): the server re-signals the inbox at
 * the boundary after the compaction, and the agent is told to look there first
 * regardless.
 *
 * claude and gemini forward it (`/compact <text>`); codex and opencode drop it
 * (their reset commands take no argument) — harmless, and the reason this is a
 * best-effort steer rather than a contract.
 */
export const AUTO_COMPACT_INSTRUCTIONS =
  'swarm-os auto-compact: keep your role, your current assignment and its exact state, ' +
  'every teammate or session id you talk to and what you asked of each, open decisions, ' +
  'and anything you still owe a reply to; after compaction, call team.read_inbox before anything else.';

/** Everything the decision needs, snapshotted by the caller at one instant. */
export interface AutoCompactInput {
  /**
   * Threshold in PERCENT (0..100) in force for this agent's role right now.
   * `0` — or anything that is not an integer — means "never".
   */
  thresholdPct: number;
  /** `Session.contextUsage` — the cached occupancy, `null` when never measured. */
  usage: ContextUsageView | null;
  /** `ContextUsageTracker.floorTokens` — the running minimum since the last reset. */
  floorTokens: number | null;
  /** `Mailbox.size(sessionId)` — messages this agent has not drained yet. */
  inboxCount: number;
  /** `Session.hasPendingContextReset` — a reset is armed or mid-write. */
  resetPending: boolean;
  /** `Session.dialogPending` — a dialog is on screen, nothing may be typed. */
  dialogPending: boolean;
}

export type AutoCompactSkipReason =
  | 'disabled'
  | 'reset-pending'
  | 'blocked'
  | 'inbox-pending'
  | 'no-usage'
  | 'stale'
  | 'below-threshold'
  | 'not-grown';

export type AutoCompactDecision =
  | { fire: true; pct: number }
  | { fire: false; reason: AutoCompactSkipReason };

/**
 * Decide whether to arm a `/compact` for one agent at one idle boundary.
 *
 * Pure: same input, same answer, no clock, no I/O, no throw.
 */
export function decideAutoCompact(input: AutoCompactInput): AutoCompactDecision {
  // `disabled` — the kill switch, and the shape guard that makes it safe.
  // `Number.isInteger` is not pedantry: a dozen test Configs (and any embedder
  // building a partial `Config`) leave `autoCompactPct` undefined, and
  // `undefined <= 0` is `false` — without this check every one of them would
  // fall through to a live `/compact` on a comparison against `NaN`.
  if (!Number.isInteger(input.thresholdPct) || input.thresholdPct <= 0) {
    return { fire: false, reason: 'disabled' };
  }
  // `reset-pending` — mono-occupancy (`Session.requestContextReset`). A reset
  // is already armed (possibly by the agent itself, or by the operator): taking
  // this boundary would be refused anyway, and the snapshot we are looking at
  // describes a context that is about to be thrown away.
  if (input.resetPending) return { fire: false, reason: 'reset-pending' };
  // `blocked` — a dialog is waiting for a human (D5). Anything injected into a
  // prompt buffer showing a permission dialog VALIDATES THE HIGHLIGHTED OPTION.
  // Never type here, whatever the context says.
  if (input.dialogPending) return { fire: false, reason: 'blocked' };
  // `inbox-pending` — C3 of the requirement: an agent with queued mail is not
  // "done", and compacting it now summarises away the state it needs to answer
  // that mail. The boundary handler signals the inbox instead, and we come back
  // at the next one.
  if (input.inboxCount > 0) return { fire: false, reason: 'inbox-pending' };
  // `no-usage` — nothing has ever been measured (gemini has no source at all,
  // a TTL of 0 disables reading, a fresh session has not produced a turn), or
  // no model window is known so there is no denominator. A threshold on a
  // number we do not have would be a guess, and this feature never guesses.
  const usage = input.usage;
  if (usage === null || usage.pct === null) return { fire: false, reason: 'no-usage' };
  // `stale` — the last figure is known NOT to describe the live context (a
  // reset landed, a read failed, the transcript rotated). Waiting one TTL costs
  // one boundary; acting on it costs a redundant compaction.
  if (usage.stale) return { fire: false, reason: 'stale' };
  // `below-threshold` — the ordinary answer. `usage.pct` is a FRACTION 0..1
  // (`ContextUsageTracker.snapshot`), the threshold is in percent, and the
  // rounding is done once here so the figure the operator reads in the log, in
  // the session line and on the bus is the very one that was compared.
  const pct = Math.round(usage.pct * 100);
  if (pct < input.thresholdPct) return { fire: false, reason: 'below-threshold' };
  // `not-grown` — the anti-loop, in tokens rather than points so it means the
  // same thing on every window size. `floorTokens` is the MINIMUM accepted
  // since the last generation bump, not the first sample: on claude the first
  // "fresh" reading after a `/compact` is still the PRE-compaction figure (the
  // transcript is rewritten in place and the gauge re-serves it), so a "first
  // sample" floor would freeze at the previous peak and the effective threshold
  // would drift +10 points at every compaction until it never fired again. With
  // the minimum, that bogus reading yields growth 0 → `not-grown` at the
  // post-compaction boundary, and the first real turn lowers the floor.
  //
  // Same mechanic covers a `/compact` the CLI REFUSES ("Not enough messages",
  // no hook at all — spike S1d): the same line is read back, growth is 0, and
  // nothing re-fires.
  if (input.floorTokens !== null && usage.limitTokens !== null) {
    const grown = usage.usedTokens - input.floorTokens;
    if (grown < (AUTO_COMPACT_MIN_GROWTH_PCT / 100) * usage.limitTokens) {
      return { fire: false, reason: 'not-grown' };
    }
  }
  return { fire: true, pct };
}

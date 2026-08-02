/**
 * Approval-gate P5 — route a Discord REACTION into a decision, the sibling of the
 * native-reply path (`modules/approvals/reply.ts`). Additive: it does NOT touch
 * the reply routing, it runs off a different Gateway event (`messageReactionAdd`).
 *
 * The bot pre-seeds three reactions under every approval card it posts, and an
 * operator resolves the approval simply by clicking one:
 *   - ✅  → approve                       (keystroke "1")
 *   - ♾️  → approve + don't-ask-again      (keystroke "2")
 *   - ❌  → deny                          (keystroke "3")
 * Any OTHER emoji is ignored (`consumed:false`). "First reaction wins" is FREE via
 * the shared core's idempotence: a second reaction on an already-resolved approval
 * is a no-op that just re-acknowledges (`already_resolved`).
 *
 * Same contract as the reply resolver: SYNC (store + resolve are synchronous
 * better-sqlite3 + PTY writes), returns `{consumed, confirmation?}`, and NEVER
 * throws. `consumed:false` means "not an approval decision" — but unlike a reply,
 * a reaction is NEVER pushed to the inbox, so the caller simply does nothing.
 */

import type { Spawner } from '../spawner/index.js';
import type { ApprovalStore } from './store.js';
import { resolveApproval, type ResolveApprovalOutcome } from './resolve.js';

/** The narrow slice of an inbound Discord reaction the resolver needs. */
export interface ApprovalReactionInput {
  /** `reaction.message.id` — the message the reaction was added to. */
  messageId: string;
  /** `reaction.emoji.name` — the unicode emoji (may carry the VS16 selector). */
  emoji: string | null | undefined;
  /** Reactor username, for audit provenance (`discord:<reactor>`). */
  reactor: string;
}

export interface ApprovalReactionResult {
  /** true → consumed as an approval decision. (A reaction is never inboxed.) */
  consumed: boolean;
  /** Short text for the bot to post back (omitted when not consumed). */
  confirmation?: string;
}

/** A sync resolver bound to one orch. Attached to that orch's subscription. */
export type ApprovalReactionResolver = (input: ApprovalReactionInput) => ApprovalReactionResult;

/** The decision an emoji maps to (shape mirrors `ParsedApprovalDecision`). */
interface ReactionDecision {
  decision: 'approve' | 'deny';
  dontAskAgain: boolean;
}

// The three accepted emojis, as their BASE codepoints (VS16 already stripped) so
// a name that arrives with OR without the U+FE0F presentation selector matches
// either way. ✅ / ❌ are unambiguous; ♾️ is the one that flips between `U+267E`
// and `U+267E U+FE0F` depending on the client. Written as explicit escapes so the
// invisible selector never sneaks into a literal.
const VS16 = /️/g;
const APPROVE_EMOJI = '✅'; // ✅
const APPROVE_ALWAYS_EMOJI = '♾'; // ♾ (base of ♾️, U+267E)
const DENY_EMOJI = '❌'; // ❌

/** Map an emoji name → decision, or `null` when it is not one of our three. */
function decisionForEmoji(emoji: string | null | undefined): ReactionDecision | null {
  if (typeof emoji !== 'string' || emoji.length === 0) return null;
  const normalized = emoji.replace(VS16, '');
  if (normalized === APPROVE_EMOJI) return { decision: 'approve', dontAskAgain: false };
  if (normalized === APPROVE_ALWAYS_EMOJI) return { decision: 'approve', dontAskAgain: true };
  if (normalized === DENY_EMOJI) return { decision: 'deny', dontAskAgain: false };
  return null;
}

function confirmationFor(res: ResolveApprovalOutcome, decision: ReactionDecision): string {
  const verb = decision.decision === 'approve' ? 'Approuvé ✅' : 'Refusé ❌';
  switch (res.outcome) {
    case 'resolved': {
      const extra = decision.dontAskAgain ? ' (ne plus demander)' : '';
      // The decision is recorded even when no keystroke could be delivered.
      const note = res.delivered ? '' : ' — décision enregistrée (rien tapé dans la console)';
      return `${verb}${extra}${note}.`;
    }
    case 'session_gone':
      return 'Réaction enregistrée — la session est déjà fermée (répondu dans la console).';
    case 'already_resolved':
      return `⚠️ Approbation déjà traitée (${res.request.status}).`;
    default:
      return 'Approbation introuvable.';
  }
}

/**
 * Build the reaction resolver for one orch. Closes over the SAME shared core as
 * the reply resolver and the REST route, so all three resolve identically. Sync,
 * to slot into the bot's Gateway event callback.
 */
export function buildApprovalReactionResolver(deps: {
  spawner: Spawner;
  store: ApprovalStore;
  orchestratorId: string;
}): ApprovalReactionResolver {
  return (input) => {
    if (!input.messageId) return { consumed: false };
    // Not one of the three approval emojis → ignore (never inboxed either way).
    const decision = decisionForEmoji(input.emoji);
    if (!decision) return { consumed: false };

    // Correlate the reacted message to a pending approval of THIS team.
    const appr = deps.store.findByDiscordMessageId(deps.orchestratorId, input.messageId);
    if (!appr) return { consumed: false }; // reaction on a non-approval message → ignore

    // Already terminal → acknowledge idempotently ("first reaction wins"), but do
    // NOT re-resolve. It WAS a reaction on our approval, just a late one.
    if (appr.status !== 'pending') {
      return { consumed: true, confirmation: `⚠️ Approbation déjà traitée (${appr.status}).` };
    }

    const res = resolveApproval(deps.spawner, deps.store, appr.id, {
      decision: decision.decision,
      dontAskAgain: decision.dontAskAgain,
      by: `discord:${input.reactor}`,
    });
    return { consumed: true, confirmation: confirmationFor(res, decision) };
  };
}

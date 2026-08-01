/**
 * Approval-gate P4 — route a native Discord REPLY into a decision
 * (docs/garde-fous-approbation.md §6 "Backend — routage réponse Discord", §9.1).
 *
 * When an operator replies to the approval message the bot posted (correlated by
 * `discord_message_id`, persisted in P4's `notifyApprovalRequested`), the bot's
 * `handleMessageCreate` calls the resolver built here BEFORE pushing to the lead
 * inbox. The resolver:
 *   - finds the pending approval for this reply's referenced message,
 *   - parses the reply text into approve/deny (+ don't-ask-again),
 *   - resolves it through the SHARED core (`resolveApproval` — same keystroke +
 *     store + event as the REST route), and
 *   - returns a short confirmation for the bot to post back.
 *
 * `consumed: false` means "this is not an approval decision" — the bot then lets
 * the message flow to the lead inbox exactly as before (a reply to some other
 * message, or an unrecognized/ambiguous answer). We NEVER swallow a message we
 * did not turn into a decision.
 */

import type { Spawner } from '../spawner/index.js';
import type { ApprovalStore } from './store.js';
import { parseApprovalDecision, type ParsedApprovalDecision } from './decision.js';
import { resolveApproval, type ResolveApprovalOutcome } from './resolve.js';

/** The narrow slice of an inbound Discord message the resolver needs. */
export interface ApprovalReplyInput {
  /** `msg.reference.messageId` — the message being replied to. */
  referenceMessageId: string;
  /** The reply's text content. */
  content: string;
  /** Author username, for audit provenance (`discord:<author>`). */
  author: string;
}

export interface ApprovalReplyResult {
  /** true → consumed as an approval decision; the bot must NOT push to inbox. */
  consumed: boolean;
  /** Short text for the bot to post back as a reply (omitted when not consumed). */
  confirmation?: string;
}

/** A sync resolver bound to one orch. Attached to that orch's subscription. */
export type ApprovalReplyResolver = (input: ApprovalReplyInput) => ApprovalReplyResult;

function confirmationFor(res: ResolveApprovalOutcome, parsed: ParsedApprovalDecision): string {
  const verb = parsed.decision === 'approve' ? 'Approuvé ✅' : 'Refusé ❌';
  switch (res.outcome) {
    case 'resolved': {
      const extra = parsed.dontAskAgain ? ' (ne plus demander)' : '';
      // The decision is recorded even when no keystroke could be delivered.
      const note = res.delivered ? '' : ' — décision enregistrée (rien tapé dans la console)';
      return `${verb}${extra}${note}.`;
    }
    case 'session_gone':
      return 'Réponse enregistrée — la session est déjà fermée (répondu dans la console).';
    case 'already_resolved':
      return `⚠️ Approbation déjà traitée (${res.request.status}).`;
    default:
      return 'Approbation introuvable.';
  }
}

/**
 * Build the reply resolver for one orch. Closes over the shared resolution core
 * so REST and Discord resolve identically. Sync (store + resolve are synchronous
 * better-sqlite3 + PTY writes) so it slots into the bot's sync fan-out.
 */
export function buildApprovalReplyResolver(deps: {
  spawner: Spawner;
  store: ApprovalStore;
  orchestratorId: string;
}): ApprovalReplyResolver {
  return (input) => {
    if (!input.referenceMessageId) return { consumed: false };
    // Correlate the referenced message to a pending approval of THIS team.
    const appr = deps.store.findByDiscordMessageId(deps.orchestratorId, input.referenceMessageId);
    if (!appr) return { consumed: false }; // reply to a non-approval message → inbox

    const parsed = parseApprovalDecision(input.content);
    if (!parsed) return { consumed: false }; // unrecognized/ambiguous → let it pass

    // Already terminal → acknowledge, but don't re-resolve. Still "consumed":
    // it WAS a reply to our approval, just a late one — no need to inbox it.
    if (appr.status !== 'pending') {
      return { consumed: true, confirmation: `⚠️ Approbation déjà traitée (${appr.status}).` };
    }

    const res = resolveApproval(deps.spawner, deps.store, appr.id, {
      decision: parsed.decision,
      dontAskAgain: parsed.dontAskAgain,
      by: `discord:${input.author}`,
    });
    return { consumed: true, confirmation: confirmationFor(res, parsed) };
  };
}

/**
 * Approval-gate P4 — parse a free-text Discord REPLY into an approval decision
 * (docs/garde-fous-approbation.md §9.2 granularity, §9.1 reply-text channel).
 *
 * The operator answers the posted approval message with a short natural reply —
 * in French or English, a word or an emoji — and we map it to
 * approve/deny (+ "don't ask again"). This is INTENTIONALLY conservative:
 *   - only a clear approve OR deny signal returns a decision;
 *   - anything ambiguous (both signals, or neither) returns `null`, and the
 *     caller then lets the message flow to the lead inbox as normal (§ "reply
 *     non-reconnu = laisse passer"). We never guess a decision from noise, since
 *     a wrong guess types an irreversible key into someone's PTY.
 *
 * Matching is whole-word / emoji based (not substring) so "notably" does not
 * read as "no" and "yes we can't" is caught as ambiguous rather than approved.
 */

export interface ParsedApprovalDecision {
  decision: 'approve' | 'deny';
  /** The operator also asked not to be asked again (claude prompt option 2). */
  dontAskAgain: boolean;
}

/** Whole-word tokens that signal approval (FR + EN). */
const APPROVE_WORDS = new Set([
  'approve',
  'approved',
  'approuve',
  'approuvé',
  'approuver',
  'yes',
  'y',
  'oui',
  'ok',
  'okay',
  'accept',
  'accepté',
  'accepte',
  'allow',
  'go',
  'validate',
  'valide',
  'valider',
]);

/** Whole-word tokens that signal denial (FR + EN). */
const DENY_WORDS = new Set([
  'deny',
  'denied',
  'no',
  'n',
  'non',
  'nope',
  'refuse',
  'refusé',
  'refuser',
  'reject',
  'rejeté',
  'rejette',
  'block',
  'bloque',
  'cancel',
  'annule',
  'annuler',
  'stop',
]);

/** Emoji that signal approval / denial. */
const APPROVE_EMOJI = ['✅', '👍', '☑️', '✔️', '✔', '🆗'];
const DENY_EMOJI = ['❌', '👎', '🚫', '⛔', '🛑', '✋'];

/** Phrases (checked as substrings on the normalized text) → "don't ask again". */
const DONT_ASK_PHRASES = [
  'ne plus demander',
  'plus demander',
  'ne me demande plus',
  'toujours',
  "don't ask",
  'dont ask',
  'do not ask',
  'always',
  'stop asking',
];

function normalize(text: string): string {
  return text.toLowerCase().normalize('NFC');
}

/** Tokenize on non-letter boundaries, keeping accented letters. */
function words(normalized: string): string[] {
  // Split on anything that is not a unicode letter — digits/punctuation/spaces.
  return normalized.split(/[^\p{L}]+/u).filter((w) => w.length > 0);
}

/**
 * Parse `text` into a decision, or `null` when it carries no clear/unambiguous
 * approve-or-deny signal (the caller then treats it as a normal message).
 */
export function parseApprovalDecision(text: string): ParsedApprovalDecision | null {
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  const normalized = normalize(text);

  let approve = false;
  let deny = false;

  for (const w of words(normalized)) {
    if (APPROVE_WORDS.has(w)) approve = true;
    if (DENY_WORDS.has(w)) deny = true;
  }
  for (const e of APPROVE_EMOJI) if (text.includes(e)) approve = true;
  for (const e of DENY_EMOJI) if (text.includes(e)) deny = true;

  // Ambiguous (both, or neither) → no decision. Let it pass through to the inbox.
  if (approve === deny) return null;

  const dontAskAgain =
    approve && DONT_ASK_PHRASES.some((p) => normalized.includes(p));

  return { decision: approve ? 'approve' : 'deny', dontAskAgain };
}

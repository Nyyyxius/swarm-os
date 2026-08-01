/**
 * Approval-gate P1 helpers — the pure, side-effect-free logic that decides
 * WHETHER a `/hooks/notification` `needs-human` callback should arm a human
 * approval, and HOW to classify + summarise it. Kept out of the store and the
 * route so both can import it and it can be unit-tested in isolation.
 *
 * See `docs/garde-fous-approbation.md` §2.5 / §9.5 for the grounding: the gate
 * arms ONLY for sessions in a permission mode that actually PROMPTS the human.
 * A `bypassPermissions` session never emits a prompt (its `.claude.json` is
 * pre-seeded `bypassPermissionsModeAccepted=true`, `providers/claude.ts`), so it
 * must never produce an approval — this is enforced here, not just relied upon.
 */

import type { ApprovalCategory } from './store.js';

/**
 * Does `(provider, mode)` describe a session that asks the human before acting?
 *
 * Grounded in each adapter's declared `capabilities.permissionModes`
 * (docs §2.5). Today ONLY claude ships a real choice of modes; codex / gemini /
 * opencode declare `['bypassPermissions']` and therefore never prompt, so they
 * are out of scope by construction and return `false`.
 *
 * claude prompting modes:
 *   - `default`     → prompts on each sensitive tool use.
 *   - `plan`        → prompts (plan mode still asks before acting).
 *   - `acceptEdits` → prompts for everything EXCEPT file edits, so it still
 *                     produces permission prompts → armed.
 * claude non-prompting modes (`bypassPermissions`, `dontAsk`, `auto`) → `false`.
 *
 * Defensive: an unknown provider, an empty/unknown mode → `false` (fail closed:
 * never invent an approval we can't justify).
 */
export function isPromptingMode(
  provider: string | null | undefined,
  mode: string | null | undefined,
): boolean {
  if (!provider || !mode) return false;
  switch (provider) {
    case 'claude':
      return mode === 'default' || mode === 'plan' || mode === 'acceptEdits';
    // codex / gemini / opencode are bypassPermissions-only today (docs §2.5 /
    // §11). Extending them to prompt is P5 (widen their capability first).
    default:
      return false;
  }
}

/**
 * Tool names that, when named in a raw prompt message, are a strong signal the
 * agent is asking to USE a tool (i.e. a permission request, not a free-form
 * question). Matched as whole words, case-insensitively.
 */
const TOOL_NAME_RE =
  /\b(bash|edit|multiedit|write|read|webfetch|websearch|notebookedit|task|glob|grep)\b/i;

/**
 * Phrases that mark a permission request in claude's / gemini's human-facing
 * prompt text (e.g. "needs your permission to use Bash", "allow this command",
 * "approve"). Best-effort — the message is opaque CLI stdout, so we bias toward
 * recall over precision here and let §9.5's "doubt → permission" rule below
 * cover the rest.
 */
const PERMISSION_RE =
  /\b(permission|permissions|allow|approve|approval|grant|authorize|authorise|consent|proceed\??|wants to (use|run)|would like to (use|run)|use the tool|run this command|execute)\b/i;

/**
 * Classify a raw `needs-human` message into `permission` vs `question`
 * (docs §9.5). The message is opaque CLI stdout, so this is best-effort:
 *
 *   1. Any permission phrase or a named tool  → `permission`.
 *   2. Otherwise, a message that reads like a plain question (`?`) → `question`.
 *   3. Anything left (doubt, in a prompting mode) → `permission` — the gate is
 *      armed precisely because a prompt is blocking the agent, and the far more
 *      common blocker is a permission ask, so defaulting there is the safer bet.
 */
export function classifyCategory(rawMessage: string | null | undefined): ApprovalCategory {
  const msg = (rawMessage ?? '').trim();
  if (msg.length === 0) return 'permission'; // doubt → permission (§9.5)
  if (PERMISSION_RE.test(msg) || TOOL_NAME_RE.test(msg)) return 'permission';
  if (msg.includes('?')) return 'question';
  return 'permission';
}

/** Longest single-line summary we keep for the actionable notification. */
const MAX_SUMMARY_LEN = 160;

/**
 * Derive a short, single-line `requested_summary` from the raw message: first
 * non-empty line, whitespace-collapsed, truncated with an ellipsis. Falls back
 * to `fallback` when the message carries nothing usable (opaque/empty stdout),
 * so the notification always has something to show.
 */
export function summarizeRequest(rawMessage: string | null | undefined, fallback: string): string {
  const collapsed = (rawMessage ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const base = (collapsed ?? '').replace(/\s+/g, ' ').trim();
  if (base.length === 0) return fallback;
  return base.length > MAX_SUMMARY_LEN ? `${base.slice(0, MAX_SUMMARY_LEN - 1)}…` : base;
}

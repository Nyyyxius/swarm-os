/**
 * Approval-gate P2 — how an operator decision becomes a KEYSTROKE sent back to
 * the blocked CLI's PTY (docs/garde-fous-approbation.md §4 variant A, §10).
 *
 * ⚠️ BEST-EFFORT BY CONSTRUCTION, and this is the known fragility the doc calls
 * out (§10, Risk "fragilité frappe↔prompt"). We do NOT parse the CLI's Ink UI;
 * we replay the key a human would press on the permission prompt. The mapping
 * therefore depends on the prompt's current layout and can drift when the CLI
 * changes it — which is exactly why the UI always keeps an "open the console"
 * fallback (P3) and why the more robust structured gate (variant B, PreToolUse)
 * is on the roadmap (P5). Keeping this mapping in one tiny, unit-tested module is
 * what makes that drift cheap to fix.
 *
 * claude's permission prompt is an Ink single-select whose NUMBER keys are
 * hotkeys that select AND confirm in one press (no trailing Enter needed):
 *
 *   Do you want to proceed?
 *   ❯ 1. Yes
 *     2. Yes, and don't ask again this session / for this tool
 *     3. No, and tell Claude what to do differently (esc)
 *
 * So `approve` → "1", `approve + don't-ask-again` → "2", `deny` → "3". We send
 * the digit as a RAW keystroke (like the xterm console does) via `writeInput`,
 * NOT `submitInput` — appending a CR would leak into whatever prompt renders
 * next once the hotkey has already fired.
 *
 * Providers other than claude are `bypassPermissions`-only today (they never
 * prompt, so P1 never records an approval for them). They therefore have NO
 * mapping here and `keystrokeFor` returns `null` — the route then records the
 * decision in the store but reports that nothing was typed (P5 widens this).
 */

/** The operator's intent, as it arrives on the REST body. */
export type ApprovalDecisionInput = 'approve' | 'deny';

export interface KeystrokePlan {
  /** Raw bytes to send to the PTY. */
  data: string;
  /**
   * `true` → use `Session.submitInput` (types the line + the Ink submit dance);
   * `false` → use `Session.writeInput` (raw keystroke pass-through). claude's
   * number hotkeys are `false`: the digit alone selects and confirms.
   */
  submit: boolean;
  /** Short human-readable label of what was sent — for logs / audit only. */
  label: string;
}

/**
 * Resolve `(provider, decision, dontAskAgain)` to the keystroke to replay, or
 * `null` when this provider has no known permission-prompt mapping (so the
 * caller can record the decision without pretending it typed anything).
 */
export function keystrokeFor(
  provider: string | null | undefined,
  decision: ApprovalDecisionInput,
  dontAskAgain = false,
): KeystrokePlan | null {
  switch (provider) {
    case 'claude': {
      if (decision === 'deny') {
        // Option 3 = "No, and tell Claude what to do differently". The digit
        // rejects the tool use; the CLI then waits for optional free-text, which
        // the agent handles on its next turn.
        return { data: '3', submit: false, label: 'claude:deny(3)' };
      }
      if (dontAskAgain) {
        return { data: '2', submit: false, label: 'claude:approve+dontAskAgain(2)' };
      }
      return { data: '1', submit: false, label: 'claude:approve(1)' };
    }
    default:
      // codex / gemini / opencode are bypassPermissions-only today (no prompt to
      // answer) — no keystroke mapping until their coverage lands in P5.
      return null;
  }
}

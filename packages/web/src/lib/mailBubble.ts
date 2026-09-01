// S12 — Map `MailMessageView.from` → chat-bubble category.
//
// Pure classification of a mailbox entry into one of four visual buckets
// rendered by the RightPanel MESSAGES tab. The `from` field is polymorphic
// (cf. authoritative semantics in
// `packages/server/src/modules/orchestrator/mailbox.ts:24-43`):
//
//   - `'human'`                       → operator broadcast.
//   - `'system'` (or any sentinel
//      added to `SYSTEM_FROM_VALUES`)  → server-emitted notice.
//   - session-id, intra-team           → peer agent in the same orch.
//   - session-id, cross-team           → lead of another team; signed by
//                                        the optional `fromOrchestratorId`
//                                        on the wire.
//
// The function is intentionally pure (no React, no I/O): the UI imports
// it, the renderer decides on colour/side/badge based on the returned
// `kind` + `authorLabel` + `fromTeam`.

import type { MailMessageView } from '../api/client';

/** Visual category used by the MESSAGES tab renderer. */
export type BubbleKind = 'me' | 'them' | 'system' | 'other-team';

/** Result returned by `classifyBubble`. */
export interface BubbleClassification {
  kind: BubbleKind;
  /** Short label shown above the bubble (e.g. `YOU`, `SYSTEM`, `Atlas / lead-1`). */
  authorLabel: string;
  /**
   * Populated only for `kind === 'other-team'`. Lets the renderer attach
   * a "from team X" chip without re-deriving the data.
   */
  fromTeam?: { id: string; name: string; sessionName: string };
}

/**
 * Sentinel values for `from` that map to `system`. Encoded as a `Set` so
 * future server-side additions (e.g. `'timer'`, `'watchdog'`) can be
 * accommodated without re-running through the classifier's fall-through
 * branches — which would otherwise mis-bucket them as peer sessions.
 */
export const SYSTEM_FROM_VALUES: ReadonlySet<string> = new Set(['system']);

/**
 * Server-side senders that are a PREFIX plus a free-form name rather than a
 * fixed sentinel — they cannot live in `SYSTEM_FROM_VALUES`, which matches by
 * equality. `cron:<name>` is emitted by the cron delivery primitive
 * (docs/crons-agents.md §2.1.5); without this branch a scheduled wake-up
 * falls through to the intra-team case and is painted as a peer agent whose
 * "session id" is the literal string `cron:daily-standup`.
 */
const PREFIXED_SYSTEM_FROM: readonly string[] = ['cron:'];

/**
 * Short, human-friendlier handle derived from a session-id. The wire
 * format for intra-team peer messages does not (yet) include a session
 * name, so we expose a stable suffix of the id rather than the full
 * opaque string. Example: `sess_abc12345` → `abc1`.
 *
 * If the input does not match the expected `sess_<hex>` shape, the raw
 * value is returned untouched — the operator still sees something
 * deterministic.
 */
function shortFromSessionId(sessionId: string): string {
  const m = /^sess_([0-9a-zA-Z]+)/.exec(sessionId);
  if (m && m[1]) return m[1].slice(0, 4);
  return sessionId;
}

/**
 * Classify a mailbox entry. The evaluation order matters: `'human'` and
 * `'system'` sentinels take precedence over any session-shaped value, and
 * the cross-team check is anchored on `fromOrchestratorId` (the only
 * field the server guarantees is absent for intra-team messages — cf.
 * `mailbox.ts:33-37`). `currentSessionId` is kept for future use
 * (e.g. flagging self-loops defensively) and to align with the spec
 * signature in `docs/update_system/12_mapping_from.md`.
 */
export function classifyBubble(
  msg: MailMessageView,
  currentSessionId: string,
): BubbleClassification {
  // 1. Operator broadcast — always shown as `me`, regardless of any
  //    spurious cross-team enrichment fields (the server never sets them
  //    for `'human'`, but the classifier is defensive).
  if (msg.from === 'human') {
    return { kind: 'me', authorLabel: 'YOU' };
  }

  // 2. System sentinel(s). Extensible via `SYSTEM_FROM_VALUES`.
  if (SYSTEM_FROM_VALUES.has(msg.from)) {
    return { kind: 'system', authorLabel: 'SYSTEM' };
  }

  // 2b. Prefixed system senders (`cron:<name>`). Same bucket, but the label
  //     keeps the name: "which cadence woke me up" is the whole question an
  //     operator asks of one of these bubbles.
  for (const prefix of PREFIXED_SYSTEM_FROM) {
    if (msg.from.startsWith(prefix)) {
      const name = msg.from.slice(prefix.length);
      return {
        kind: 'system',
        authorLabel: `CRON · ${(name || 'UNNAMED').toUpperCase()}`,
      };
    }
  }

  // 3. Cross-team: signed by the presence of `fromOrchestratorId`. We do
  //    NOT compare against the "current orchestrator" — the server
  //    guarantees this field is omitted for intra-team mail, so its mere
  //    presence is the authoritative signal (`mailbox.ts:33-37`).
  if (msg.fromOrchestratorId) {
    const name = msg.fromOrchestratorName ?? msg.fromOrchestratorId;
    const sess = msg.fromSessionName ?? msg.from;
    return {
      kind: 'other-team',
      authorLabel: `${name} / ${sess}`,
      fromTeam: {
        id: msg.fromOrchestratorId,
        name,
        sessionName: sess,
      },
    };
  }

  // 4. Intra-team peer. Self-loops (`from === currentSessionId`) cannot
  //    happen today (`messaging.ts:214` excludes the sender from
  //    broadcasts) but we still surface them as `them` — they are not
  //    operator-authored, so `me` would be misleading.
  void currentSessionId; // reserved for future heuristics
  return {
    kind: 'them',
    authorLabel: shortFromSessionId(msg.from),
  };
}

import { withModule } from '../../logger.js';
import type {
  MailboxMessageRow,
  SwarmDb,
  SessionStatusRow,
} from '../db/index.js';
import type { Message, MailboxPersistHook } from './mailbox.js';
import type { Persistence } from './persistence.js';
import type { Spawner } from '../spawner/index.js';
import { SIGNAL_TEXT } from './messaging.js';

const log = withModule('mailbox-persistence');

const TERMINAL_SESSION_STATUSES = new Set<SessionStatusRow>([
  'exited',
  'killed',
  'interrupted',
  'failed',
]);

/**
 * Phase 8 — write-through persistence for one orchestrator's mailbox.
 *
 * Returns `undefined` if the underlying `persistence.db` is missing or
 * looks like the NoOpPersistence stub (no real `insertMailboxMessage`).
 * That lets tests keep the mailbox purely in-memory without further
 * wiring.
 *
 * The hook's three methods are tiny adapters over SwarmDb's prepared
 * statements:
 *   - `writeMessage`        → INSERT (throws on PK collision — caller's bug)
 *   - `writeMessagesBatch`  → INSERT × N inside one db.transaction (1 fsync)
 *   - `markDelivered`       → UPDATE delivered_at on a set of ids
 */
export function makeMailboxPersistenceForOrch(
  orchId: string,
  persistence: Persistence,
): MailboxPersistHook | undefined {
  const db = persistence.db;
  // NoOpPersistence stub exposes the methods but they're all no-ops — wiring
  // the hook costs nothing, and returning undefined would force every test
  // that uses NoOpPersistence to special-case the hook absence. Cheap
  // safety: if `insertMailboxMessage` is missing entirely (very old stub),
  // bail to undefined so we don't crash.
  if (typeof db?.insertMailboxMessage !== 'function') return undefined;

  return {
    writeMessage(to, msg) {
      db.insertMailboxMessage(messageToRow(orchId, to, msg, null));
    },
    writeMessagesBatch(items) {
      if (items.length === 0) return;
      const rows = items.map((it) => messageToRow(orchId, it.to, it.msg, null));
      db.insertMailboxMessagesBatch(rows);
    },
    markDelivered(ids) {
      if (ids.length === 0) return;
      db.markMailboxMessagesDelivered(ids);
    },
  };
}

function messageToRow(
  orchId: string,
  to: string,
  msg: Message,
  deliveredAt: string | null,
): MailboxMessageRow {
  return {
    id: msg.id,
    orchestrator_id: orchId,
    to_session_id: to,
    from_id: msg.from,
    content: msg.content,
    ts: msg.ts,
    from_orchestrator_id: msg.fromOrchestratorId ?? null,
    from_orchestrator_name: msg.fromOrchestratorName ?? null,
    from_session_name: msg.fromSessionName ?? null,
    delivered_at: deliveredAt,
    source_kind: msg.sourceKind ?? null,
    source_message_id: msg.sourceMessageId ?? null,
    thread_id: msg.threadId ?? null,
    thread_name: msg.threadName ?? null,
  };
}

/**
 * Phase 8 — replay pending mailbox messages into the in-memory mailboxes of
 * the orchestrators that were just respawned by the Spawner.
 *
 * Sequence (per orch):
 *   1. SELECT pending rows scoped on this orchestrator_id (uses the
 *      `idx_mailbox_pending_by_orch` partial index).
 *   2. Drop messages whose sender is in a terminal DB state — they would
 *      otherwise have the agent "reply" to a ghost.
 *   3. Push survivors into `orch.mailbox` with `silent: true` so the
 *      counter / persist hook don't fire (the rows are already on disk).
 *   4. Wake the recipient session(s) via `Session.injectIdleNotification`
 *      so the agent immediately calls `team.read_inbox` instead of
 *      waiting for its next idle window.
 *
 * Pending messages for an orch that didn't come back up (hidden, or
 * failed-to-resume) are bulk-marked delivered so they don't pile up.
 */
export function rehydrateMailbox(spawner: Spawner, db: SwarmDb): {
  rehydrated: number;
  droppedSenderTerminal: number;
  droppedOrphan: number;
} {
  let rehydrated = 0;
  let droppedSenderTerminal = 0;
  let droppedOrphan = 0;

  // 1. For each live orch, replay its pending messages.
  for (const orch of spawner.list()) {
    const pending = db.selectPendingMailboxMessagesForOrch(orch.id);
    if (pending.length === 0) continue;

    const toDeliverImmediately: string[] = [];
    const liveSessionIds = new Set(orch.listSessions().map((s) => s.id));
    const liveSessionStatuses = new Map(
      orch.listSessions().map((s) => [s.id, s.status]),
    );

    const wakeTargets = new Set<string>();
    for (const row of pending) {
      // Sender-terminal drop: if the sender is a session id that's known
      // and terminal, the agent would waste tokens "replying" to it.
      if (isSenderTerminal(row, liveSessionStatuses, db)) {
        toDeliverImmediately.push(row.id);
        droppedSenderTerminal++;
        continue;
      }
      // Recipient unknown (session was hidden or never came back): drop.
      if (!liveSessionIds.has(row.to_session_id)) {
        toDeliverImmediately.push(row.id);
        droppedOrphan++;
        continue;
      }
      orch.mailbox.push(
        row.to_session_id,
        {
          id: row.id,
          from: row.from_id,
          content: row.content,
          ts: row.ts,
          fromOrchestratorId: row.from_orchestrator_id ?? undefined,
          fromOrchestratorName: row.from_orchestrator_name ?? undefined,
          fromSessionName: row.from_session_name ?? undefined,
          sourceKind: (row.source_kind as 'discord' | null) ?? undefined,
          sourceMessageId: row.source_message_id ?? undefined,
          threadId: row.thread_id ?? undefined,
          threadName: row.thread_name ?? undefined,
        },
        { silent: true },
      );
      rehydrated++;
      wakeTargets.add(row.to_session_id);
    }

    if (toDeliverImmediately.length > 0) {
      db.markMailboxMessagesDelivered(toDeliverImmediately);
    }

    // 4. Wake recipients so the agent picks up the inbox proactively
    // (instead of relying solely on the resume notice's "check your inbox"
    // hint). Reuses the same signal path messaging.ts uses for fresh
    // sends — text gets PTY-written on a new line. If the PTY isn't fully
    // attached yet (starting), notifySignal is a no-op.
    for (const sid of wakeTargets) {
      const sess = orch.getSession(sid);
      if (!sess) continue;
      try {
        sess.notifySignal(SIGNAL_TEXT);
      } catch (err) {
        log.warn({
          event: 'mailbox.wake_failed',
          orchId: orch.id,
          sessionId: sid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // 2. For each orch that has pending msgs in DB but isn't in the live
  // Spawner map (hidden, or failed-to-resume), bulk-mark delivered.
  // Scan: any orch_id present in mailbox_messages pending that isn't in
  // the live spawner list. Cheap: iterate distinct orch_ids in pending.
  const liveOrchIds = new Set(spawner.list().map((o) => o.id));
  const orphanRows = db
    .listOrchestrators() // includes hidden=null filter already
    .filter((r) => !liveOrchIds.has(r.id))
    .flatMap((r) => db.selectPendingMailboxMessagesForOrch(r.id));
  if (orphanRows.length > 0) {
    db.markMailboxMessagesDelivered(orphanRows.map((r) => r.id));
    droppedOrphan += orphanRows.length;
  }

  return { rehydrated, droppedSenderTerminal, droppedOrphan };
}

/**
 * Phase 8 — boot-time GC: delete delivered mailbox rows older than the
 * given number of days. Cheap, bounded — keeps the audit trail from
 * unbounded growth (plan §17 critique).
 */
export function mailboxJanitor(
  db: SwarmDb,
  opts: { maxAgeDays?: number } = {},
): { deleted: number } {
  const maxAgeDays = opts.maxAgeDays ?? 30;
  const cutoffMs = Date.now() - maxAgeDays * 86400 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const deleted = db.deleteOldDeliveredMailboxMessages(cutoffIso);
  if (deleted > 0) {
    log.info({ event: 'mailbox.janitor', deleted, cutoffIso });
  }
  return { deleted };
}

/**
 * Resolve whether a message's sender is in a terminal state. Two cases:
 *  - intra-team: sender is a session id we know live; look it up.
 *  - cross-team or unknown: hit the DB to check; if the session row says
 *    terminal OR doesn't exist, treat as terminal.
 * 'system' / 'human' senders never look terminal.
 */
function isSenderTerminal(
  row: MailboxMessageRow,
  liveSessionStatuses: Map<string, string>,
  db: SwarmDb,
): boolean {
  // 'system'/'human' senders, and any plugin-origin (`plugin:<name>`) or
  // cron-origin (`cron:<name>`) message, are never sender-terminal: neither a
  // plugin nor a cron has a session row, so without this exemption every
  // pending message from one would be classified terminal (unknown session →
  // terminal) and silently destroyed at each boot (plan §J2 fix B-1 — the
  // exact bug the crons `from` would otherwise replay,
  // docs/crons-agents.md §2.1.5).
  if (
    row.from_id === 'system' ||
    row.from_id === 'human' ||
    row.from_id.startsWith('plugin:') ||
    row.from_id.startsWith('cron:')
  ) {
    return false;
  }
  // Live in this orch's session map?
  const liveStatus = liveSessionStatuses.get(row.from_id);
  if (liveStatus) {
    return TERMINAL_SESSION_STATUSES.has(liveStatus as SessionStatusRow);
  }
  // Fall back to DB lookup — covers cross-team and the case where the
  // sender lived in a different orch that didn't resume.
  const sessRow = db.getSession?.(row.from_id);
  if (!sessRow) {
    // Unknown session — orph or hidden. Treat as terminal so we don't
    // hold the message forever.
    return true;
  }
  return TERMINAL_SESSION_STATUSES.has(sessRow.status);
}

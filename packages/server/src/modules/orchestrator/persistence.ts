/**
 * Phase 4 — bridge between in-memory `Orchestrator`/`Session` and the SwarmDb.
 *
 * Both classes call into a `SessionPersistence` / `OrchestratorPersistence`
 * abstraction so:
 *
 *   - Phase 1/2/3 unit tests can run without a SQLite file (pass `null`).
 *   - The DB writer can be swapped (e.g. for an in-memory test double).
 *   - Throttling logic for `lastActivityAt` lives in one place — we only
 *     write a session row at most once per second for chatty PTY data, but
 *     status/exit transitions go through immediately.
 *
 * Usage:
 *
 *   const persistence = new DbPersistence(db);
 *   spawner = new Spawner(config, { notifier, persistence });
 *   ...
 */

import type { SwarmDb, OrchestratorRow, SessionRow } from '../db/index.js';
import type { Orchestrator, OrchestratorView } from './index.js';
import type { Session, SessionView } from './session.js';

export interface OrchestratorPersistence {
  /** Write the current state of the orchestrator to the persistence layer. */
  writeOrchestrator(orch: Orchestrator): void;
}

export interface SessionPersistence {
  /** Write the current state of the session. */
  writeSession(session: Session, opts?: { force?: boolean }): void;
}

/**
 * Phase 8 — boot-time classification of what the previous server process
 * left behind. The Spawner consumes `resumable[]` to respawn teams; the
 * `reaped` counters cover orchestrators the operator already asked to stop
 * (status='stopping') which we explicitly do NOT bring back up.
 */
export interface ResumableState {
  resumable: Array<{ orch: OrchestratorRow; sessions: SessionRow[] }>;
  reaped: { orchestrators: number; sessions: number };
}

export interface Persistence extends OrchestratorPersistence, SessionPersistence {
  /** Mark every non-terminal row as interrupted (boot recovery). */
  recoverFromCrash(): { orchestrators: number; sessions: number };
  /**
   * Phase 8 — replacement for `recoverFromCrash` on the auto-resume path.
   * Atomic-guards every resumable row by flipping it to 'interrupted' BEFORE
   * returning, so a crash mid-resume can't lead to a double-spawn at the
   * next boot. Each resumed orch's `Orchestrator.resume()` will UPSERT the
   * row back to 'running' on success.
   */
  loadResumableState(): ResumableState;
  /** Underlying SwarmDb — used by REST handlers to read history. */
  readonly db: SwarmDb;
}

const ACTIVITY_THROTTLE_MS = 1000;

/**
 * `DbPersistence` writes through to a `SwarmDb`. Status / exit changes are
 * forced through immediately; `lastActivityAt`-only updates are throttled to
 * one write per session per second so that a noisy PTY can't hammer the DB.
 *
 * Failure mode: the DB layer itself swallows write errors and warn-logs (see
 * `SwarmDb.upsert*`). We never throw out of these methods.
 */
export class DbPersistence implements Persistence {
  readonly db: SwarmDb;
  private readonly lastSessionWriteAt = new Map<string, number>();
  private readonly lastSessionStatus = new Map<string, string>();

  constructor(db: SwarmDb) {
    this.db = db;
  }

  writeOrchestrator(orch: Orchestrator): void {
    // `Orchestrator.stopReason` is the public Phase 4 accessor — no casts.
    const row = orchToRow(orch.toView(), {
      stopReason: orch.stopReason,
    });
    this.db.upsertOrchestrator(row);
  }

  writeSession(session: Session, opts: { force?: boolean } = {}): void {
    const view = session.toView();
    const isStatusChange = this.lastSessionStatus.get(view.id) !== view.status;
    const lastWrite = this.lastSessionWriteAt.get(view.id) ?? 0;
    const elapsed = Date.now() - lastWrite;

    if (
      !opts.force &&
      !isStatusChange &&
      view.endedAt == null &&
      elapsed < ACTIVITY_THROTTLE_MS
    ) {
      return; // throttle chatty PTY data → at most 1 row/sec
    }

    this.db.upsertSession(sessionToRow(view, session.initialPrompt));
    this.lastSessionWriteAt.set(view.id, Date.now());
    this.lastSessionStatus.set(view.id, view.status);
  }

  recoverFromCrash(): { orchestrators: number; sessions: number } {
    return this.db.markAllNonTerminalAsInterrupted();
  }

  /**
   * Phase 8 — atomic guard + classification. Returns the orch rows + their
   * sessions ready to be passed to `Spawner.resumeFromDb`. Side effects on
   * the DB:
   *   - Every 'stopping' orch is marked 'interrupted' with
   *     stop_reason='server-restart-during-stop' (the operator already
   *     asked to take it down — respect that, don't resume).
   *   - Every 'starting'|'running' orch is marked 'interrupted' with
   *     stop_reason='resume-in-progress'. If the spawner crashes mid-resume,
   *     the next boot sees 'interrupted' and the loop is broken.
   *   - All non-terminal sessions of each affected orch are flipped to
   *     'interrupted' in the same transaction.
   *
   * On a successful resume, `Orchestrator.resume()` will UPSERT the row
   * back to 'running'.
   */
  loadResumableState(): ResumableState {
    const reaped = { orchestrators: 0, sessions: 0 };

    // 1. Reap orchs in 'stopping' — they were on their way out.
    for (const row of this.db.listStoppingOrchestrators()) {
      const flipped = this.db.markOrchAndSessionsInterrupted(
        row.id,
        'server-restart-during-stop',
      );
      if (flipped) reaped.orchestrators++;
    }

    // 2. Atomic-guard resumable candidates: flip to 'interrupted' BEFORE
    // returning. On a crash mid-resume, the row stays 'interrupted'
    // (non-resumable). On success, Orchestrator.resume() UPSERTs to
    // 'running' so the row is back to live state.
    //
    // CRUCIAL ordering: load sessions BEFORE the atomic flip, so the
    // returned list reflects what was actually live before this boot
    // (the flip would otherwise clobber every non-terminal session row).
    const candidates = this.db.listResumableOrchestrators();
    const resumable: ResumableState['resumable'] = [];
    for (const row of candidates) {
      // Load sessions first (in their pre-flip state) so the spawner knows
      // which ones to rebuild. Filter to non-terminal — terminal sessions
      // stay in history as-is and are not respawned.
      const sessions = this.db
        .listSessions(row.id)
        .filter((s) => !isTerminalSessionStatus(s.status));
      // Now atomic-flip the orch + its sessions so the next boot can tell
      // "this team is being resumed by an in-flight process" from "this
      // team is genuinely live".
      this.db.markOrchAndSessionsInterrupted(row.id, 'resume-in-progress');
      resumable.push({ orch: row, sessions });
    }

    return { resumable, reaped };
  }
}

const TERMINAL_SESSION_SET = new Set(['exited', 'killed', 'interrupted', 'failed']);
function isTerminalSessionStatus(s: string): boolean {
  return TERMINAL_SESSION_SET.has(s);
}

/** No-op persistence — used by tests / phases that don't want a DB. */
export class NoOpPersistence implements Persistence {
  // We satisfy the interface by exposing a stub `db` whose calls no-op. Tests
  // never read it.
  readonly db: SwarmDb = {
    upsertOrchestrator: () => undefined,
    upsertSession: () => undefined,
    getOrchestrator: () => null,
    listOrchestrators: () => [],
    listRecentlyTerminatedOrchestrators: () => [],
    listSessions: () => [],
    markAllNonTerminalAsInterrupted: () => ({ orchestrators: 0, sessions: 0 }),
    // Phase 8 — no-op stubs for the new SwarmDb methods so tests that wire
    // a NoOpPersistence into an Orchestrator don't crash when the mailbox
    // persistence hook fires (the hook is also gated on `db` presence in
    // makeMailboxPersistenceForOrch, but defensive).
    markOrchAndSessionsInterrupted: () => false,
    listResumableOrchestrators: () => [],
    listStoppingOrchestrators: () => [],
    insertMailboxMessage: () => undefined,
    insertMailboxMessagesBatch: () => undefined,
    insertMailboxMessageOrIgnore: () => undefined,
    markMailboxMessagesDelivered: () => undefined,
    selectPendingMailboxMessagesForOrch: () => [],
    deleteOldDeliveredMailboxMessages: () => 0,
    close: () => undefined,
  } as unknown as SwarmDb;

  writeOrchestrator(): void {}
  writeSession(): void {}
  recoverFromCrash(): { orchestrators: number; sessions: number } {
    return { orchestrators: 0, sessions: 0 };
  }
  loadResumableState(): ResumableState {
    return { resumable: [], reaped: { orchestrators: 0, sessions: 0 } };
  }
}

// ---- Conversion helpers -----------------------------------------------------

export function orchToRow(
  view: OrchestratorView,
  extra: { stopReason: string | null },
): OrchestratorRow {
  return {
    id: view.id,
    name: view.name,
    role: view.role,
    role_id: view.roleId,
    status: view.status,
    lead_session_id: view.leadSessionId,
    default_model: view.defaultModel,
    default_effort: view.defaultEffort,
    default_permission_mode: view.defaultPermissionMode,
    default_provider: view.defaultProvider,
    lead_preamble: view.leadPreamble,
    worker_preamble: view.workerPreamble,
    created_at: view.createdAt,
    ended_at: view.endedAt,
    hidden_at: null,
    last_error: view.lastError,
    stop_reason: extra.stopReason,
    // Phase 8 — auto-resume audit.
    last_resumed_at: view.lastResumedAt,
    resume_count: view.resumeCount,
  };
}

export function sessionToRow(
  view: SessionView,
  initialPrompt: string | null,
): SessionRow {
  return {
    id: view.id,
    orchestrator_id: view.orchestratorId,
    name: view.name,
    role: view.role,
    type: view.type,
    cwd: view.cwd,
    initial_prompt: initialPrompt,
    model: view.model,
    effort: view.effort,
    permission_mode: view.permissionMode,
    provider: view.provider,
    status: view.status,
    pid: view.pid,
    started_at: view.startedAt,
    ended_at: view.endedAt,
    exit_code: view.exitCode,
    last_error: view.lastError,
    stop_reason: view.stopReason,
    log_path: view.logPath,
    last_activity_at: view.lastActivityAt,
    hidden_at: null,
  };
}

/** Convert a DB row back into an OrchestratorView (for read-from-history). */
export function rowToOrchView(
  row: OrchestratorRow,
  sessions: SessionView[],
): OrchestratorView {
  // Cast: the row may carry the new 'interrupted' status (Phase 8 atomic
  // guard) which is not part of the OrchestratorView union — clamp to
  // 'failed' for the history view so the UI doesn't crash. The DB still
  // holds the real value for diagnostics.
  const viewStatus = (row.status === 'interrupted' ? 'failed' : row.status) as OrchestratorView['status'];
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    roleId: row.role_id,
    status: viewStatus,
    leadSessionId: row.lead_session_id,
    defaultModel: row.default_model,
    defaultEffort: row.default_effort as OrchestratorView['defaultEffort'],
    defaultPermissionMode: row.default_permission_mode as OrchestratorView['defaultPermissionMode'],
    // Legacy rows predate the column; SQLite's ADD COLUMN default already made
    // them 'claude', the `??` only covers a hand-written row.
    defaultProvider: row.default_provider ?? 'claude',
    leadPreamble: row.lead_preamble,
    workerPreamble: row.worker_preamble,
    createdAt: row.created_at,
    endedAt: row.ended_at,
    lastError: row.last_error,
    sessions,
    // Phase update_system S1: history rows have no live mailbox, so the
    // cumulative bus counter is 0 by definition. Not persisted in v1.
    msgCount: 0,
    // Phase update_system S7: history rows are by definition terminal
    // (status ∈ {stopped, failed, interrupted}). Hardcode the verdict
    // instead of re-running the computation — `'bad'` for failure/
    // interrupted so the UI can still flag historical failures,
    // `'stopped'` otherwise.
    health: (row.status === 'failed' || row.status === 'interrupted') ? 'bad' : 'stopped',
    // Phase 8 — auto-resume audit, surfaced unconditionally.
    resumeCount: row.resume_count,
    lastResumedAt: row.last_resumed_at,
    stopReason: row.stop_reason,
  };
}

export function rowToSessionView(row: SessionRow): SessionView {
  return {
    id: row.id,
    orchestratorId: row.orchestrator_id,
    name: row.name,
    role: row.role,
    type: row.type,
    cwd: row.cwd,
    model: row.model,
    effort: row.effort as SessionView['effort'],
    permissionMode: row.permission_mode as SessionView['permissionMode'],
    provider: row.provider ?? 'claude',
    status: row.status,
    pid: row.pid,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    exitCode: row.exit_code,
    lastError: row.last_error,
    stopReason: row.stop_reason,
    logPath: row.log_path,
    lastActivityAt: row.last_activity_at,
  };
}

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

export interface Persistence extends OrchestratorPersistence, SessionPersistence {
  /** Mark every non-terminal row as interrupted (boot recovery). */
  recoverFromCrash(): { orchestrators: number; sessions: number };
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
    close: () => undefined,
  } as unknown as SwarmDb;

  writeOrchestrator(): void {}
  writeSession(): void {}
  recoverFromCrash(): { orchestrators: number; sessions: number } {
    return { orchestrators: 0, sessions: 0 };
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
    lead_preamble: view.leadPreamble,
    worker_preamble: view.workerPreamble,
    created_at: view.createdAt,
    ended_at: view.endedAt,
    hidden_at: null,
    last_error: view.lastError,
    stop_reason: extra.stopReason,
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
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    roleId: row.role_id,
    status: row.status,
    leadSessionId: row.lead_session_id,
    defaultModel: row.default_model,
    defaultEffort: row.default_effort as OrchestratorView['defaultEffort'],
    defaultPermissionMode: row.default_permission_mode as OrchestratorView['defaultPermissionMode'],
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
    // (status ∈ {stopped, failed}). Hardcode the verdict instead of
    // re-running the computation — `'bad'` for the failed branch so the
    // UI can still flag historical failures, `'stopped'` otherwise.
    health: row.status === 'failed' ? 'bad' : 'stopped',
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

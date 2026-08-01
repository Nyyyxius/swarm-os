/**
 * ApprovalStore — the durable queue of HUMAN-IN-THE-LOOP approval requests
 * (docs/garde-fous-approbation.md, Phase 1). When a non-bypass session blocks on
 * a CLI permission prompt, the `/hooks/notification` route records a `pending`
 * row here; later phases (P2+) resolve it (a keystroke back to the PTY, a Discord
 * reply) and flip its status. The queue is PERSISTED — deliberately NOT derived
 * from the ephemeral, web-only `waiting` pseudo-status (docs §2.1) — so an
 * approval survives a reconnect, a `/clear`, a crash and a resume.
 *
 * ⚠️ Like `memory/store.ts` and `taskboard/store.ts`, this class OWNS its tables
 * via `CREATE TABLE IF NOT EXISTS` on the raw `Database` handle (`SwarmDb.db`).
 * It deliberately touches NEITHER `schema.sql` NOR `INLINE_SCHEMA`: the inline
 * fallback is the path that runs in the Docker image (tsc doesn't copy `.sql`),
 * so a table declared only in `schema.sql` would never exist in prod. Keeping the
 * DDL here sidesteps the trap entirely.
 *
 * Robustness — DIFFERENT from taskboard on purpose. Every method here, INCLUDING
 * mutations, is wrapped in try/catch and returns a null / empty / count result on
 * failure. `createRequest` runs INSIDE the `/hooks/notification` request path,
 * and per spike H6 a non-2xx (or a thrown error surfacing as one) from that hook
 * can crash the calling claude process. So this store NEVER throws into that
 * path: a broken approval write degrades to "no approval was recorded", never to
 * a downed agent. Each mutation appends an `approval_events` audit row in the
 * SAME transaction and then emits an `approval.*` event on the injected bus.
 */

import * as crypto from 'node:crypto';
import type { Database as Db } from 'better-sqlite3';
import { withModule } from '../../logger.js';
import type { SwarmDb } from '../db/index.js';
import type { SwarmEventBus, SwarmEventKind } from '../../events.js';

const log = withModule('approvals.store');

// --- DTO contract (shared with the frontend — do NOT change without cause) ---

/** Why the agent is blocked on a human (docs §9.5 best-effort classification). */
export type ApprovalCategory = 'permission' | 'question';

export const APPROVAL_CATEGORIES: readonly ApprovalCategory[] = ['permission', 'question'];

/**
 * Lifecycle of an approval. `pending` until an operator decides; `approved` /
 * `denied` are the two operator decisions (P2); `answered_in_console` is the
 * race where the human replied straight in the PTY and the prompt vanished
 * (docs §10); `expired` is a TTL cleanup flag (NOT an auto-decision — timeout
 * policy is "leave pending", docs §9.3).
 */
export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'answered_in_console';

export const APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  'pending',
  'approved',
  'denied',
  'expired',
  'answered_in_console',
];

/** Terminal (non-pending) statuses a `resolveRequest` may stamp. */
export type ApprovalResolution = 'approved' | 'denied' | 'answered_in_console';

/** Journal (audit) event kinds — the `kind` column of `approval_events`. */
export type ApprovalEventKind = 'requested' | 'notified' | 'resolved' | 'expired';

export interface ApprovalRequest {
  id: string;
  orchestratorId: string;
  sessionId: string;
  category: ApprovalCategory;
  /** Short, human-facing summary derived from the raw message. */
  requestedSummary: string;
  /** The opaque CLI stdout that triggered this approval (kept for audit/UX). */
  rawMessage: string;
  /** The session's resolved permission mode at request time. */
  permissionMode: string;
  /** The session's provider id at request time (claude|codex|gemini|opencode). */
  provider: string;
  status: ApprovalStatus;
  /** Epoch millis. */
  createdAt: number;
  /** Epoch millis when the request should be considered stale, or `null`. */
  expiresAt: number | null;
  /** Epoch millis when resolved, or `null` while pending. */
  resolvedAt: number | null;
  /** Who resolved it (operator id / channel), or `null` while pending. */
  resolvedBy: string | null;
  /** The resolution outcome, or `null` while pending. */
  decision: string | null;
}

export interface ApprovalEvent {
  id: string;
  approvalId: string;
  orchestratorId: string;
  sessionId: string;
  kind: ApprovalEventKind;
  data: Record<string, unknown> | null;
  ts: number;
}

// --- Internal row shapes ----------------------------------------------------

interface RequestRow {
  id: string;
  orchestrator_id: string;
  session_id: string;
  category: string;
  requested_summary: string;
  raw_message: string;
  permission_mode: string;
  provider: string;
  status: string;
  created_at: number;
  expires_at: number | null;
  resolved_at: number | null;
  resolved_by: string | null;
  decision: string | null;
}

interface EventRow {
  id: string;
  approval_id: string;
  orchestrator_id: string;
  session_id: string;
  kind: string;
  data: string | null;
  ts: number;
}

// --- Method input shapes ----------------------------------------------------

export interface CreateApprovalInput {
  orchestratorId: string;
  sessionId: string;
  category: ApprovalCategory;
  requestedSummary: string;
  rawMessage: string;
  permissionMode: string;
  provider: string;
  /** Optional TTL flag horizon (epoch millis). Cleanup only — never decides. */
  expiresAt?: number | null;
}

export interface ResolveApprovalInput {
  /** The operator decision / terminal outcome. */
  decision: ApprovalResolution;
  /** Who resolved it (operator id, `'web'`, `'discord'`, `'console'`, …). */
  by: string | null;
}

const MAX_TEXT_LEN = 8000;
/** How many trailing journal events `getRequest`-style reads keep by default. */
const JOURNAL_TAIL = 50;

function safeParseData(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function clampText(v: unknown): string {
  const s = typeof v === 'string' ? v : v == null ? '' : String(v);
  return s.length > MAX_TEXT_LEN ? s.slice(0, MAX_TEXT_LEN) : s;
}

export class ApprovalStore {
  private readonly db: Db;
  private readonly eventBus: SwarmEventBus | null;

  private readonly getRequestStmt;
  private readonly insertRequestStmt;
  private readonly updateRequestStmt;
  private readonly listPendingAllStmt;
  private readonly listPendingByOrchStmt;
  private readonly listBySessionStmt;
  private readonly insertEventStmt;
  private readonly tailEventsStmt;
  private readonly expiredPendingStmt;

  constructor(swarmDb: SwarmDb, opts: { eventBus?: SwarmEventBus } = {}) {
    this.db = swarmDb.db;
    this.eventBus = opts.eventBus ?? null;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approval_requests (
        id                TEXT PRIMARY KEY,
        orchestrator_id   TEXT NOT NULL,
        session_id        TEXT NOT NULL,
        category          TEXT NOT NULL DEFAULT 'permission',
        requested_summary TEXT NOT NULL DEFAULT '',
        raw_message       TEXT NOT NULL DEFAULT '',
        permission_mode   TEXT NOT NULL DEFAULT '',
        provider          TEXT NOT NULL DEFAULT '',
        status            TEXT NOT NULL DEFAULT 'pending',
        created_at        INTEGER NOT NULL,
        expires_at        INTEGER,
        resolved_at       INTEGER,
        resolved_by       TEXT,
        decision          TEXT,
        FOREIGN KEY (orchestrator_id) REFERENCES orchestrators(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_orch_status ON approval_requests(orchestrator_id, status);
      CREATE INDEX IF NOT EXISTS idx_approvals_session     ON approval_requests(session_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_status      ON approval_requests(status);

      CREATE TABLE IF NOT EXISTS approval_events (
        id                TEXT PRIMARY KEY,
        approval_id       TEXT NOT NULL,
        orchestrator_id   TEXT NOT NULL,
        session_id        TEXT NOT NULL,
        kind              TEXT NOT NULL,
        data              TEXT,
        ts                INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_approval_events_approval ON approval_events(approval_id, ts);
    `);

    this.getRequestStmt = this.db.prepare<[string], RequestRow>(
      'SELECT * FROM approval_requests WHERE id = ?',
    );
    this.insertRequestStmt = this.db.prepare<RequestRow>(`
      INSERT INTO approval_requests (
        id, orchestrator_id, session_id, category, requested_summary, raw_message,
        permission_mode, provider, status, created_at, expires_at, resolved_at,
        resolved_by, decision
      ) VALUES (
        @id, @orchestrator_id, @session_id, @category, @requested_summary, @raw_message,
        @permission_mode, @provider, @status, @created_at, @expires_at, @resolved_at,
        @resolved_by, @decision
      )
    `);
    this.updateRequestStmt = this.db.prepare<RequestRow>(`
      UPDATE approval_requests SET
        category = @category, requested_summary = @requested_summary,
        raw_message = @raw_message, permission_mode = @permission_mode,
        provider = @provider, status = @status, expires_at = @expires_at,
        resolved_at = @resolved_at, resolved_by = @resolved_by, decision = @decision
      WHERE id = @id
    `);
    // Oldest-first queue order; rowid (insertion order) breaks a same-ms tie
    // deterministically rather than the random UUID id.
    this.listPendingAllStmt = this.db.prepare<[], RequestRow>(
      "SELECT * FROM approval_requests WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC",
    );
    this.listPendingByOrchStmt = this.db.prepare<[string], RequestRow>(
      "SELECT * FROM approval_requests WHERE status = 'pending' AND orchestrator_id = ? ORDER BY created_at ASC, rowid ASC",
    );
    // rowid (insertion order) breaks a same-millisecond created_at tie, not the
    // random UUID id: newest-created must read back first, deterministically.
    this.listBySessionStmt = this.db.prepare<[string], RequestRow>(
      'SELECT * FROM approval_requests WHERE session_id = ? ORDER BY created_at DESC, rowid DESC',
    );
    this.insertEventStmt = this.db.prepare<EventRow>(`
      INSERT INTO approval_events (id, approval_id, orchestrator_id, session_id, kind, data, ts)
      VALUES (@id, @approval_id, @orchestrator_id, @session_id, @kind, @data, @ts)
    `);
    // Order by rowid (insertion order) as the tie-breaker, not the random UUID
    // id: two journal rows written in the same millisecond must still read back
    // in the order they were appended (audit legibility).
    this.tailEventsStmt = this.db.prepare<[string, number], EventRow>(
      'SELECT * FROM approval_events WHERE approval_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?',
    );
    this.expiredPendingStmt = this.db.prepare<[number], RequestRow>(
      "SELECT * FROM approval_requests WHERE status = 'pending' AND created_at < ? ORDER BY created_at ASC",
    );
  }

  // --- helpers --------------------------------------------------------------

  private normalizeCategory(cat: string | undefined): ApprovalCategory {
    return (APPROVAL_CATEGORIES as readonly string[]).includes(cat ?? '')
      ? (cat as ApprovalCategory)
      : 'permission';
  }

  private normalizeStatus(status: string | undefined): ApprovalStatus {
    return (APPROVAL_STATUSES as readonly string[]).includes(status ?? '')
      ? (status as ApprovalStatus)
      : 'pending';
  }

  private rowToRequest(row: RequestRow): ApprovalRequest {
    return {
      id: row.id,
      orchestratorId: row.orchestrator_id,
      sessionId: row.session_id,
      category: this.normalizeCategory(row.category),
      requestedSummary: row.requested_summary,
      rawMessage: row.raw_message,
      permissionMode: row.permission_mode,
      provider: row.provider,
      status: this.normalizeStatus(row.status),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      resolvedAt: row.resolved_at,
      resolvedBy: row.resolved_by,
      decision: row.decision,
    };
  }

  private requestToRow(r: ApprovalRequest): RequestRow {
    return {
      id: r.id,
      orchestrator_id: r.orchestratorId,
      session_id: r.sessionId,
      category: r.category,
      requested_summary: r.requestedSummary,
      raw_message: r.rawMessage,
      permission_mode: r.permissionMode,
      provider: r.provider,
      status: r.status,
      created_at: r.createdAt,
      expires_at: r.expiresAt,
      resolved_at: r.resolvedAt,
      resolved_by: r.resolvedBy,
      decision: r.decision,
    };
  }

  private rowToEvent(row: EventRow): ApprovalEvent {
    return {
      id: row.id,
      approvalId: row.approval_id,
      orchestratorId: row.orchestrator_id,
      sessionId: row.session_id,
      kind: row.kind as ApprovalEventKind,
      data: safeParseData(row.data),
      ts: row.ts,
    };
  }

  private makeEvent(
    ref: { approvalId: string; orchestratorId: string; sessionId: string },
    kind: ApprovalEventKind,
    data: Record<string, unknown> | null,
  ): EventRow {
    return {
      id: crypto.randomUUID(),
      approval_id: ref.approvalId,
      orchestrator_id: ref.orchestratorId,
      session_id: ref.sessionId,
      kind,
      data: data ? JSON.stringify(data) : null,
      ts: Date.now(),
    };
  }

  /** Map a journal kind to its `approval.*` bus event kind (open union). */
  private busKindFor(kind: ApprovalEventKind): SwarmEventKind | null {
    switch (kind) {
      case 'requested':
        return 'approval.requested';
      case 'resolved':
      case 'expired':
        return 'approval.resolved';
      // `notified` has no dedicated bus kind (P3 concern) — no event emitted.
      default:
        return null;
    }
  }

  private emit(kind: ApprovalEventKind, req: ApprovalRequest, extra: Record<string, unknown> = {}): void {
    try {
      const busKind = this.busKindFor(kind);
      if (!busKind) return;
      this.eventBus?.emitEvent({
        kind: busKind,
        orchestratorId: req.orchestratorId,
        sessionId: req.sessionId,
        payload: {
          approvalId: req.id,
          orchestratorId: req.orchestratorId,
          sessionId: req.sessionId,
          category: req.category,
          requestedSummary: req.requestedSummary,
          status: req.status,
          ...extra,
        },
      });
    } catch (err) {
      log.warn({ event: 'approvals.emit_failed', kind, error: String(err) });
    }
  }

  // --- mutations ------------------------------------------------------------

  /**
   * Record a new `pending` approval, append its `requested` journal entry (same
   * transaction) and emit `approval.requested`. Runs in the hook path, so it
   * NEVER throws — returns the created record, or `null` when nothing could be
   * written (logged). Callers proceed regardless (the legacy `waiting` badge and
   * Discord ping still fire).
   */
  createRequest(input: CreateApprovalInput): ApprovalRequest | null {
    try {
      if (!input || typeof input.orchestratorId !== 'string' || input.orchestratorId.length === 0) {
        return null;
      }
      if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) return null;

      const now = Date.now();
      const req: ApprovalRequest = {
        id: crypto.randomUUID(),
        orchestratorId: input.orchestratorId,
        sessionId: input.sessionId,
        category: this.normalizeCategory(input.category),
        requestedSummary: clampText(input.requestedSummary),
        rawMessage: clampText(input.rawMessage),
        permissionMode: clampText(input.permissionMode),
        provider: clampText(input.provider),
        status: 'pending',
        createdAt: now,
        expiresAt: input.expiresAt ?? null,
        resolvedAt: null,
        resolvedBy: null,
        decision: null,
      };

      this.db.transaction(() => {
        this.insertRequestStmt.run(this.requestToRow(req));
        this.insertEventStmt.run(
          this.makeEvent(
            { approvalId: req.id, orchestratorId: req.orchestratorId, sessionId: req.sessionId },
            'requested',
            { category: req.category, permissionMode: req.permissionMode, provider: req.provider },
          ),
        );
      })();

      this.emit('requested', req);
      return req;
    } catch (err) {
      log.warn({ event: 'approvals.create_failed', error: String(err) });
      return null;
    }
  }

  /**
   * Resolve a pending approval (P2 primary path). Stamps status / resolved_at /
   * resolved_by / decision, appends a `resolved` journal entry and emits
   * `approval.resolved`. Idempotent: a non-pending request is returned unchanged
   * (never re-resolved). Defensive — returns `null` on unknown id or failure.
   */
  resolveRequest(id: string, input: ResolveApprovalInput): ApprovalRequest | null {
    try {
      const row = this.getRequestStmt.get(id);
      if (!row) return null;
      const current = this.rowToRequest(row);
      // Idempotent: already terminal → return as-is (docs §10 idempotent resolve).
      if (current.status !== 'pending') return current;

      const status: ApprovalStatus = (APPROVAL_STATUSES as readonly string[]).includes(input.decision)
        ? (input.decision as ApprovalStatus)
        : 'approved';
      const now = Date.now();
      const next: ApprovalRequest = {
        ...current,
        status,
        resolvedAt: now,
        resolvedBy: input.by ?? null,
        decision: input.decision,
      };

      this.db.transaction(() => {
        this.updateRequestStmt.run(this.requestToRow(next));
        this.insertEventStmt.run(
          this.makeEvent(
            { approvalId: next.id, orchestratorId: next.orchestratorId, sessionId: next.sessionId },
            'resolved',
            { decision: next.decision, by: next.resolvedBy, status: next.status },
          ),
        );
      })();

      this.emit('resolved', next, { decision: next.decision, by: next.resolvedBy });
      return next;
    } catch (err) {
      log.warn({ event: 'approvals.resolve_failed', id, error: String(err) });
      return null;
    }
  }

  /**
   * TTL cleanup (P2 janitor stub): flag every still-`pending` request created
   * more than `maxAgeMs` ago as `expired`. This is a CLEANUP flag, never an
   * auto-decision (timeout policy is "leave pending", docs §9.3). Each flip is
   * audited (`expired` journal + `approval.resolved` event). Never throws;
   * returns how many were flagged.
   */
  expireOlderThan(maxAgeMs: number): number {
    let expired = 0;
    try {
      const ms = Number.isFinite(maxAgeMs) ? Math.max(0, Math.floor(maxAgeMs)) : 0;
      const cutoff = Date.now() - ms;
      const rows = this.expiredPendingStmt.all(cutoff);
      for (const row of rows) {
        try {
          const current = this.rowToRequest(row);
          const now = Date.now();
          const next: ApprovalRequest = {
            ...current,
            status: 'expired',
            resolvedAt: now,
            resolvedBy: current.resolvedBy ?? null,
            decision: current.decision ?? 'expired',
          };
          this.db.transaction(() => {
            this.updateRequestStmt.run(this.requestToRow(next));
            this.insertEventStmt.run(
              this.makeEvent(
                { approvalId: next.id, orchestratorId: next.orchestratorId, sessionId: next.sessionId },
                'expired',
                { createdAt: current.createdAt },
              ),
            );
          })();
          this.emit('expired', next);
          expired++;
        } catch (err) {
          log.warn({ event: 'approvals.expire_one_failed', id: row.id, error: String(err) });
        }
      }
    } catch (err) {
      log.warn({ event: 'approvals.expire_failed', error: String(err) });
    }
    return expired;
  }

  // --- reads ----------------------------------------------------------------

  /** One approval by id, or `null` if absent / on failure. */
  getRequest(id: string): ApprovalRequest | null {
    try {
      const row = this.getRequestStmt.get(id);
      return row ? this.rowToRequest(row) : null;
    } catch (err) {
      log.warn({ event: 'approvals.get_failed', id, error: String(err) });
      return null;
    }
  }

  /** Pending approvals, optionally scoped to one team. Oldest first. `[]` on failure. */
  listPending(orchestratorId?: string): ApprovalRequest[] {
    try {
      const rows =
        orchestratorId && orchestratorId.length > 0
          ? this.listPendingByOrchStmt.all(orchestratorId)
          : this.listPendingAllStmt.all();
      return rows.map((r) => this.rowToRequest(r));
    } catch (err) {
      log.warn({ event: 'approvals.list_pending_failed', error: String(err) });
      return [];
    }
  }

  /** All approvals for one session (any status), newest first. `[]` on failure. */
  listBySession(sessionId: string): ApprovalRequest[] {
    try {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return [];
      return this.listBySessionStmt.all(sessionId).map((r) => this.rowToRequest(r));
    } catch (err) {
      log.warn({ event: 'approvals.list_by_session_failed', error: String(err) });
      return [];
    }
  }

  /** Tail of one approval's append-only audit journal, oldest → newest. */
  listEvents(approvalId: string, tail = JOURNAL_TAIL): ApprovalEvent[] {
    try {
      const n = Math.max(1, Math.min(500, Math.floor(tail) || JOURNAL_TAIL));
      return this.tailEventsStmt
        .all(approvalId, n)
        .map((e) => this.rowToEvent(e))
        .reverse();
    } catch (err) {
      log.warn({ event: 'approvals.list_events_failed', approvalId, error: String(err) });
      return [];
    }
  }
}

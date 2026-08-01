// packages/web/src/components/ApprovalsPage.tsx
//
// Approval-gate web overlay (`#/approvals`) — Phase 5.3.
//
// Layout (mirrors BoardPage / MemoryPage sidebar + main pattern):
//
//   ┌──────────────┬──────────────────────────────────────────────────────┐
//   │ .board-side  │ .appr-main                                           │
//   │  orch select │  PENDING section  (actionable: approve/deny/console) │
//   │  counts      │  HISTORY section  (approved/denied/expired/answered) │
//   └──────────────┴──────────────────────────────────────────────────────┘
//
// Data: useApprovals (poll 5 s) + live approvalsRev from SwarmController
// (approval.* WS events re-use the existing useEvents subscription).
// Writes: resolveApproval (approve | deny | dontAskAgain).

import { useCallback, useEffect, useState } from 'react';
import { useSwarmController } from '../controller/SwarmController';
import { useApprovals } from '../hooks/useApprovals';
import {
  api, apiErrorMessage,
  type ApprovalListItem, type ApprovalStatus, type ResolveApprovalBody,
} from '../api/client';
import { type ApprovalToast } from './desktop/Toasts';
import { ICON } from './desktop/icons';

interface Props {
  open: boolean;
  onClose: () => void;
}

function fmtAge(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) + '…' : id;
}

function statusLabel(s: ApprovalStatus): string {
  switch (s) {
    case 'pending': return 'PENDING';
    case 'approved': return 'APPROVED';
    case 'denied': return 'DENIED';
    case 'expired': return 'EXPIRED';
    case 'answered_in_console': return 'ANSWERED';
    default: return (s as string).toUpperCase();
  }
}

export function ApprovalsPage({ open, onClose }: Props) {
  const { approvalsRev, orchestrators, handleApprovalOpen } = useSwarmController();

  // ── orch selector ────────────────────────────────────────────────────────
  const [selectedOrchId, setSelectedOrchId] = useState<string | null>(null);

  const { approvals, loading, error, unavailable, refresh } = useApprovals(
    selectedOrchId,
    5000,
    open,
  );

  // Re-fetch when a live approval.* WS event fires.
  useEffect(() => {
    if (!open || approvalsRev === 0) return;
    void refresh();
  }, [approvalsRev, open, refresh]);

  // Auto-select first live orchestrator.
  useEffect(() => {
    if (!open) return;
    if (selectedOrchId) return;
    const first = orchestrators.find((o) => o.endedAt == null);
    if (first) setSelectedOrchId(first.id);
  }, [open, orchestrators, selectedOrchId]);

  // ── resolve (approve / deny) ─────────────────────────────────────────────
  const [resolving, setResolving] = useState<Record<string, boolean>>({});
  const [resolveErrors, setResolveErrors] = useState<Record<string, string>>({});

  const resolve = useCallback(async (id: string, body: ResolveApprovalBody) => {
    setResolving((r) => ({ ...r, [id]: true }));
    setResolveErrors((e) => { const n = { ...e }; delete n[id]; return n; });
    try {
      await api.resolveApproval(id, body);
      await refresh();
    } catch (err) {
      setResolveErrors((e) => ({ ...e, [id]: apiErrorMessage(err) }));
    } finally {
      setResolving((r) => { const n = { ...r }; delete n[id]; return n; });
    }
  }, [refresh]);

  // ── helpers ──────────────────────────────────────────────────────────────
  function orchName(orchId: string): string {
    const o = orchestrators.find((x) => x.id === orchId);
    return o?.name ?? shortId(orchId);
  }

  function agentName(sessionId: string, orchId: string): string {
    const o = orchestrators.find((x) => x.id === orchId);
    const s = o?.sessions.find((sess) => sess.id === sessionId);
    return s?.name ?? shortId(sessionId);
  }

  function toApprovalToast(a: ApprovalListItem): ApprovalToast {
    return {
      id: a.id,
      sessionId: a.sessionId,
      teamId: a.orchestratorId,
      teamName: orchName(a.orchestratorId),
      agentName: agentName(a.sessionId, a.orchestratorId),
      category: a.category,
      summary: a.requestedSummary,
      at: a.createdAt,
    };
  }

  if (!open) return null;

  const liveOrchestrators = orchestrators.filter((o) => o.endedAt == null);
  const pending = approvals.filter((a) => a.status === 'pending');
  const history = approvals.filter((a) => a.status !== 'pending');

  return (
    <div
      className="board-overlay"
      style={{ gridTemplateColumns: '220px 1fr' }}
      role="dialog"
      aria-label="Approvals"
    >
      {/* ── sidebar ─────────────────────────────────────────────────────── */}
      <aside className="board-side roles-side">
        <div className="board-side-head">
          <span className="board-side-title">APPROVALS</span>
          <button className="icon-btn" onClick={onClose} title="close">{ICON.kill}</button>
        </div>

        <div className="board-team-select">
          <label className="board-label">TEAM</label>
          <select
            className="board-select"
            value={selectedOrchId ?? ''}
            onChange={(e) => setSelectedOrchId(e.target.value || null)}
          >
            <option value="">— choose team —</option>
            {liveOrchestrators.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </div>

        {selectedOrchId && !unavailable && (
          <div className="board-col-counts">
            <div className="board-count-row">
              <span className="appr-dot pending" />
              <span className="board-count-label">PENDING</span>
              <span className="board-count-num">{pending.length}</span>
            </div>
            <div className="board-count-row">
              <span className="appr-dot approved" />
              <span className="board-count-label">APPROVED</span>
              <span className="board-count-num">
                {history.filter((a) => a.status === 'approved').length}
              </span>
            </div>
            <div className="board-count-row">
              <span className="appr-dot denied" />
              <span className="board-count-label">DENIED</span>
              <span className="board-count-num">
                {history.filter((a) => a.status === 'denied').length}
              </span>
            </div>
            <div className="board-count-row">
              <span className="appr-dot expired" />
              <span className="board-count-label">EXPIRED</span>
              <span className="board-count-num">
                {history.filter((a) => a.status === 'expired').length}
              </span>
            </div>
            <div className="board-count-row">
              <span className="appr-dot answered" />
              <span className="board-count-label">ANSWERED</span>
              <span className="board-count-num">
                {history.filter((a) => a.status === 'answered_in_console').length}
              </span>
            </div>
          </div>
        )}

        {unavailable && (
          <div className="board-unavail">
            <div className="board-unavail-title">Not available</div>
            <div className="board-unavail-sub">
              The approval gate is absent on this backend.
            </div>
          </div>
        )}
        {error && <div className="board-error">{error}</div>}
      </aside>

      {/* ── main ────────────────────────────────────────────────────────── */}
      <main className="appr-main">
        {loading && !approvals.length && (
          <div className="board-loading">Loading…</div>
        )}

        {!loading && !unavailable && !selectedOrchId && (
          <div className="board-empty">
            <div className="board-empty-title">Select a team to view its approvals</div>
          </div>
        )}

        {!loading && !unavailable && selectedOrchId && !approvals.length && (
          <div className="board-empty">
            <div className="board-empty-title">No approvals</div>
            <div className="board-empty-sub">
              Approval requests appear here when agents are blocked waiting for human input.
            </div>
          </div>
        )}

        {selectedOrchId && !unavailable && approvals.length > 0 && (
          <div className="appr-sections">
            {/* ── pending section ── */}
            <section className="appr-section">
              <div className="appr-section-head">
                <span className="appr-dot pending" />
                <span className="appr-section-title">PENDING</span>
                <span className="board-col-count">{pending.length}</span>
              </div>
              {pending.length === 0 ? (
                <div className="appr-empty-section">No pending approvals</div>
              ) : (
                pending.map((a) => (
                  <ApprovalCard
                    key={a.id}
                    item={a}
                    orchName={orchName(a.orchestratorId)}
                    agentName={agentName(a.sessionId, a.orchestratorId)}
                    resolving={resolving[a.id] ?? false}
                    resolveError={resolveErrors[a.id]}
                    onApprove={() => void resolve(a.id, { decision: 'approve' })}
                    onDeny={() => void resolve(a.id, { decision: 'deny' })}
                    onDontAsk={() => void resolve(a.id, { decision: 'approve', dontAskAgain: true })}
                    onOpenConsole={() => handleApprovalOpen(toApprovalToast(a))}
                  />
                ))
              )}
            </section>

            {/* ── history section ── */}
            {history.length > 0 && (
              <section className="appr-section">
                <div className="appr-section-head">
                  <span className="appr-dot resolved" />
                  <span className="appr-section-title">HISTORY</span>
                  <span className="board-col-count">{history.length}</span>
                </div>
                {history.map((a) => (
                  <ApprovalCard
                    key={a.id}
                    item={a}
                    orchName={orchName(a.orchestratorId)}
                    agentName={agentName(a.sessionId, a.orchestratorId)}
                  />
                ))}
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

// ── ApprovalCard ─────────────────────────────────────────────────────────────

interface ApprovalCardProps {
  item: ApprovalListItem;
  orchName: string;
  agentName: string;
  resolving?: boolean;
  resolveError?: string;
  onApprove?: () => void;
  onDeny?: () => void;
  onDontAsk?: () => void;
  onOpenConsole?: () => void;
}

function ApprovalCard({
  item,
  orchName,
  agentName,
  resolving = false,
  resolveError,
  onApprove,
  onDeny,
  onDontAsk,
  onOpenConsole,
}: ApprovalCardProps) {
  const isPending = item.status === 'pending';

  return (
    <div className={`appr-card ${isPending ? 'pending' : item.status}`}>
      <div className="appr-card-head">
        <span className={`appr-cat-chip ${item.category ?? 'permission'}`}>
          {item.category === 'question' ? 'QUESTION' : 'PERMISSION'}
        </span>
        <span className={`appr-status-chip ${item.status}`}>
          {statusLabel(item.status)}
        </span>
        <span className="appr-card-age">{fmtAge(item.createdAt)}</span>
      </div>

      <div className="appr-card-summary">
        {item.requestedSummary || <em className="appr-card-nosummary">(no summary)</em>}
      </div>

      <div className="appr-card-meta">
        <span className="appr-meta-key">TEAM</span>
        <span className="appr-meta-val">{orchName}</span>
        <span className="appr-meta-sep">·</span>
        <span className="appr-meta-key">AGENT</span>
        <span className="appr-meta-val">{agentName}</span>
      </div>

      {(item.resolvedBy ?? item.decision) && (
        <div className="appr-card-meta">
          {item.resolvedBy && (
            <>
              <span className="appr-meta-key">BY</span>
              <span className="appr-meta-val">{item.resolvedBy}</span>
            </>
          )}
          {item.decision && (
            <>
              {item.resolvedBy && <span className="appr-meta-sep">·</span>}
              <span className="appr-meta-key">DECISION</span>
              <span className="appr-meta-val">{item.decision}</span>
            </>
          )}
        </div>
      )}

      {resolveError && <div className="appr-card-error">{resolveError}</div>}

      {isPending && (
        <div className="appr-card-actions">
          <button
            className="board-btn appr-approve-btn"
            onClick={onApprove}
            disabled={resolving}
            title="Approve this request"
          >
            {ICON.start}
            <span>Approve</span>
          </button>
          <button
            className="board-btn danger"
            onClick={onDeny}
            disabled={resolving}
            title="Deny this request"
          >
            {ICON.kill}
            <span>Deny</span>
          </button>
          <button
            className="board-btn appr-dontask-btn"
            onClick={onDontAsk}
            disabled={resolving}
            title="Approve and don't ask again for this permission"
          >
            <span>✓✓ Don&apos;t ask</span>
          </button>
          <button
            className="board-btn"
            onClick={onOpenConsole}
            disabled={resolving}
            title="Open the blocked session's console"
          >
            {ICON.code}
            <span>→ Console</span>
          </button>
        </div>
      )}
    </div>
  );
}

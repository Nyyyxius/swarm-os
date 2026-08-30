// packages/web/src/components/mobile/MobileToasts.tsx
//
// Mobile waiting-toast stack — Slice 2. The core of the mobile app: when a
// session enters `waiting`, surface an actionable toast. Tap → pre-select
// the session + sync route (opens the AgentSheet) + dismiss. Reuses the
// controller's waitingToasts / handleToastOpen / dismissToast (fed by the
// single lifted useEvents).
import { formatRelative } from '../../lib/format';
import { formatBudgetLine } from '../../lib/budget';
import { useSwarmController } from '../../controller/SwarmController';

const MAX_VISIBLE = 4;

export default function MobileToasts() {
  const c = useSwarmController();
  const items = c.waitingToasts;
  const approvals = c.approvalToasts;
  const notices = c.notices;
  const budgets = c.budgetToasts;
  if (
    items.length === 0 && approvals.length === 0
    && notices.length === 0 && budgets.length === 0
  ) {
    return null;
  }

  const visible = items.slice(0, MAX_VISIBLE);
  const olderCount = items.length - visible.length;
  const firstOlder = items[MAX_VISIBLE];

  return (
    <div className="m-toasts">
      {/* Budget breaches lead (Lot 14). This stack is a plain `column` — the
          first child is the TOP one — so leading it puts the one notice that
          reports a possibly-paused team where a thumb reaches first. */}
      {budgets.map((t) => (
        <div className="m-toast m-toast-budget" key={t.id}>
          <div className="m-toast-head">
            <span className="m-toast-title">BUDGET EXCEEDED</span>
            <span className="m-toast-time">{formatRelative(t.at)}</span>
          </div>
          <div className="m-toast-id">{t.teamName}</div>
          <div className="m-toast-figure">
            {formatBudgetLine(t.costUsd, t.budgetUsd, t.action)}
          </div>
          <div className="m-toast-foot">
            <button
              type="button"
              className="m-toast-dismiss"
              onClick={() => c.dismissBudgetToast(t.id)}
              aria-label="dismiss"
            >×</button>
            <button
              type="button"
              className="m-toast-open"
              onClick={() => c.handleBudgetOpen(t)}
            >→ OPEN TEAM</button>
          </div>
        </div>
      ))}
      {/* Operator notices next — they answer an action just taken (context
          reset scheduled / refused), so they must not sit under an unrelated
          event stack. */}
      {notices.map((n) => (
        <div className="m-toast" key={n.id}>
          <div className="m-toast-head">
            <span
              className="m-toast-title"
              style={n.kind === 'error' ? { color: 'var(--bad)' } : undefined}
            >
              {n.title}
            </span>
            <span className="m-toast-time">{formatRelative(n.at)}</span>
          </div>
          {n.body && <div className="m-toast-reason">{n.body}</div>}
          <div className="m-toast-foot">
            <button
              type="button"
              className="m-toast-dismiss"
              onClick={() => c.dismissNotice(n.id)}
              aria-label="dismiss"
            >×</button>
          </div>
        </div>
      ))}
      {/* Approvals next — actionable and time-sensitive (P3). */}
      {approvals.map((t) => (
        <div className="m-toast m-toast-approval" key={t.id}>
          <div className="m-toast-head">
            <span className="m-toast-title">APPROBATION REQUISE</span>
            <span className="m-toast-time">{formatRelative(t.at)}</span>
          </div>
          <div className="m-toast-id">{t.teamName} :: {t.agentName}</div>
          {t.summary && <div className="m-toast-reason">{t.summary}</div>}
          <div className="m-toast-actions" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            <button type="button" className="m-toast-open" onClick={() => c.approveApproval(t)}>✓ Approuver</button>
            <button
              type="button"
              className="m-toast-open"
              onClick={() => c.approveApproval(t, { dontAskAgain: true })}
            >
              ✓✓ Ne plus demander
            </button>
            <button type="button" className="m-toast-dismiss" onClick={() => c.denyApproval(t)}>✕ Refuser</button>
          </div>
          <div className="m-toast-foot">
            <button type="button" className="m-toast-dismiss" onClick={() => c.dismissApprovalToast(t.id)} aria-label="dismiss">×</button>
            <button type="button" className="m-toast-open" onClick={() => c.handleApprovalOpen(t)}>→ CONSOLE</button>
          </div>
        </div>
      ))}
      {olderCount > 0 && firstOlder && (
        <button type="button" className="m-toasts-older" onClick={() => c.handleToastOpen(firstOlder)}>
          + {olderCount} older waiting →
        </button>
      )}
      {visible.map((t) => (
        <div className="m-toast" key={t.id}>
          <div className="m-toast-head">
            <span className="m-toast-title">SESSION WAITING</span>
            <span className="m-toast-time">{formatRelative(t.at)}</span>
          </div>
          <div className="m-toast-id">{t.teamName} :: {t.agentName}</div>
          {t.reason && <div className="m-toast-reason">{t.reason}</div>}
          <div className="m-toast-foot">
            <button type="button" className="m-toast-dismiss" onClick={() => c.dismissToast(t.id)} aria-label="dismiss">×</button>
            <button type="button" className="m-toast-open" onClick={() => c.handleToastOpen(t)}>→ OPEN</button>
          </div>
        </div>
      ))}
    </div>
  );
}

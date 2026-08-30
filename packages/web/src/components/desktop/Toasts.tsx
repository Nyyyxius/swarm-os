// packages/web/src/components/desktop/Toasts.tsx
import { formatRelative } from '../../lib/format';
import { formatBudgetLine } from '../../lib/budget';
import type { BudgetAction } from '../../api/client';

const TOAST_MAX_VISIBLE = 5;

export interface WaitingToast {
  id: string;
  sessionId: string;
  teamId: string;
  teamName: string;
  agentName: string;
  reason?: string;
  at: number | string;         // ms epoch ou ISO
}

/**
 * P3 — an ACTIONABLE approval toast. Unlike `WaitingToast` it carries decision
 * controls (Approve / Approve-and-don't-ask / Deny) plus the console fallback
 * (docs §9: the "open the console" escape hatch is ALWAYS offered, because the
 * keystroke replay is best-effort). Keyed by `id` = the approvalId.
 */
export interface ApprovalToast {
  id: string;
  sessionId: string;
  teamId: string;
  teamName: string;
  agentName: string;
  category?: string;
  summary?: string;
  at: number | string;
}

/**
 * Lot 14 — a team that crossed its role's cost budget. Same actionable shape
 * as `WaitingToast` (a subject, a figure, OPEN), painted in the `--bad`
 * register instead of the warn one, because unlike a waiting session this is
 * not a request for attention: it is a report of something that has already
 * happened, possibly a SIGSTOP on the whole team.
 *
 * Keyed by `id` = the orchestrator id, so a team appears once.
 */
export interface BudgetToast {
  id: string;
  /** The team to open — the one thing this toast is about. */
  teamId: string;
  teamName: string;
  /** Absent when the server sent no figure; the line renders `—` in its place. */
  costUsd?: number;
  budgetUsd?: number;
  action: BudgetAction;
  at: number | string;
}

/**
 * A generic operator notice — the outcome of an action the operator just
 * took, as opposed to a server-pushed event. Introduced for the deferred
 * context reset (docs/monitoring-agents.md): `POST /context-reset` answers
 * "armed", the effect lands minutes later at the agent's next idle, and a
 * 409 carries a machine code the operator has to read. Self-dismissing (TTL
 * in `SwarmController`), no actions beyond closing it.
 */
export interface NoticeToast {
  id: string;
  kind: 'ok' | 'error';
  /** ALL-CAPS headline, e.g. `COMPACT SCHEDULED — FIRES AT IDLE`. */
  title: string;
  /** Optional second line: the target agent, or the server's reason. */
  body?: string;
  at: number;
}

interface Props {
  items: readonly WaitingToast[];
  onOpen: (t: WaitingToast) => void;
  onDismiss: (id: string) => void;
  /** Shift left of the 400px right panel when it is open (same reason as EventsPip). */
  panelOpen?: boolean;
  // ── P3 approval toasts (optional — absent on a backend predating the gate) ──
  approvals?: readonly ApprovalToast[];
  onApprove?: (t: ApprovalToast, opts?: { dontAskAgain?: boolean }) => void;
  onDeny?: (t: ApprovalToast) => void;
  /** Open the blocked session's console (the always-present fallback). */
  onApprovalOpen?: (t: ApprovalToast) => void;
  onApprovalDismiss?: (id: string) => void;
  // ── generic operator notices ──
  notices?: readonly NoticeToast[];
  onNoticeDismiss?: (id: string) => void;
  // ── Lot 14 budget breaches (optional — absent on a server predating it) ──
  budgets?: readonly BudgetToast[];
  /** Select the over-budget team, exactly as the waiting toast selects its session. */
  onBudgetOpen?: (t: BudgetToast) => void;
  onBudgetDismiss?: (id: string) => void;
}

export default function Toasts({
  items,
  onOpen,
  onDismiss,
  panelOpen,
  approvals = [],
  onApprove,
  onDeny,
  onApprovalOpen,
  onApprovalDismiss,
  notices = [],
  onNoticeDismiss,
  budgets = [],
  onBudgetOpen,
  onBudgetDismiss,
}: Props) {
  const visible = items.slice(0, TOAST_MAX_VISIBLE);
  const olderCount = items.length - visible.length;
  const firstOlder = items[TOAST_MAX_VISIBLE];

  return (
    <div
      className="toasts"
      style={{
        right: panelOpen ? 416 : undefined,
        transition: 'right 280ms cubic-bezier(.2,.7,.2,1)',
      }}
    >
      {/* Budget breaches lead the stack. `.toasts` is `column-reverse`, so the
          FIRST child sits closest to the corner — the most prominent slot —
          and this is the only toast here reporting something that has already
          happened to a whole team rather than asking for attention. It is
          also one-shot server-side: if it is missed, nothing repeats it. */}
      {budgets.map((t) => (
        <div className="toast toast-budget" key={t.id}>
          <div className="t-head">
            <span className="t-title">BUDGET EXCEEDED</span>
            <span className="t-time">{formatRelative(t.at)}</span>
          </div>
          <div className="t-id">{t.teamName}</div>
          <div className="t-budget-figure">
            {formatBudgetLine(t.costUsd, t.budgetUsd, t.action)}
          </div>
          <div className="t-foot">
            <span />
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="dismiss"
                onClick={() => onBudgetDismiss?.(t.id)}
                title="dismiss"
              >DISMISS</button>
              <button className="open" onClick={() => onBudgetOpen?.(t)}>
                → OPEN TEAM
              </button>
            </div>
          </div>
        </div>
      ))}
      {/* Notices next — they answer an action the operator just took, so
          they must not be pushed below an unrelated event stack. */}
      {notices.map((n) => (
        <div className="toast" key={n.id}>
          <div className="t-head">
            <span
              className="t-title"
              style={n.kind === 'error' ? { color: 'var(--bad)' } : undefined}
            >
              {n.title}
            </span>
            <span className="t-time">{formatRelative(n.at)}</span>
          </div>
          {n.body && <div className="t-reason">{n.body}</div>}
          <div className="t-foot">
            <span />
            <button
              className="dismiss"
              onClick={() => onNoticeDismiss?.(n.id)}
              title="dismiss"
            >×</button>
          </div>
        </div>
      ))}
      {/* Approvals next — they are actionable and time-sensitive. */}
      {approvals.map((t) => (
        <div className="toast toast-approval" key={t.id}>
          <div className="t-head">
            <span className="t-title">APPROBATION REQUISE</span>
            <span className="t-time">{formatRelative(t.at)}</span>
          </div>
          <div className="t-id">{t.teamName} :: {t.agentName}</div>
          {t.summary && <div className="t-reason">{t.summary}</div>}
          <div className="t-approval-actions" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            <button className="open" onClick={() => onApprove?.(t)}>✓ Approuver</button>
            <button
              className="open"
              onClick={() => onApprove?.(t, { dontAskAgain: true })}
              title="Approuver et ne plus demander pour cette session"
            >
              ✓✓ Ne plus demander
            </button>
            <button className="dismiss" onClick={() => onDeny?.(t)} title="Refuser">✕ Refuser</button>
          </div>
          <div className="t-foot">
            <span style={{
              fontFamily: 'Geist Mono, monospace',
              fontSize: 9, letterSpacing: '0.14em',
              color: 'var(--text-mute)',
            }}>
              {t.sessionId}
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="dismiss" onClick={() => onApprovalDismiss?.(t.id)} title="dismiss">×</button>
              <button className="open" onClick={() => onApprovalOpen?.(t)}>→ CONSOLE</button>
            </div>
          </div>
        </div>
      ))}
      {olderCount > 0 && firstOlder && (
        <div className="toasts-older" onClick={() => onOpen(firstOlder)}>
          + {olderCount} older waiting →
        </div>
      )}
      {visible.map((t) => (
        <div className="toast" key={t.id}>
          <div className="t-head">
            <span className="t-title">SESSION WAITING</span>
            <span className="t-time">{formatRelative(t.at)}</span>
          </div>
          <div className="t-id">{t.teamName} :: {t.agentName}</div>
          {t.reason && <div className="t-reason">{t.reason}</div>}
          <div className="t-foot">
            <span style={{
              fontFamily: 'Geist Mono, monospace',
              fontSize: 9, letterSpacing: '0.14em',
              color: 'var(--text-mute)',
            }}>
              {t.sessionId}
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="dismiss" onClick={() => onDismiss(t.id)} title="dismiss">×</button>
              <button className="open" onClick={() => onOpen(t)}>→ OPEN</button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

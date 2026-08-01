// packages/web/src/components/desktop/Toasts.tsx
import { formatRelative } from '../../lib/format';

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
      {/* Approvals first — they are actionable and time-sensitive. */}
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

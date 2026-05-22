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

interface Props {
  items: readonly WaitingToast[];
  onOpen: (t: WaitingToast) => void;
  onDismiss: (id: string) => void;
}

export default function Toasts({ items, onOpen, onDismiss }: Props) {
  const visible = items.slice(0, TOAST_MAX_VISIBLE);
  const olderCount = items.length - visible.length;
  const firstOlder = items[TOAST_MAX_VISIBLE];

  return (
    <div className="toasts">
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

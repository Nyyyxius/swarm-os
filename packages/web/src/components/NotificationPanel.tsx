import { useState } from 'react';
import { useEvents, type WaitingNotice } from '../hooks/useEvents';

interface Props {
  /** When the user clicks a toast, navigate to the orchestrator detail. */
  onOpenOrchestrator?: (id: string) => void;
}

const MAX_VISIBLE = 5;

/**
 * Phase 4 — surfaces `session.waiting` events from `/ws/events` as a stack
 * of toasts in the bottom-right of the viewport. Each toast carries:
 *
 *   - the orch id (clickable when `onOpenOrchestrator` is provided)
 *   - the session id (mono font for copy-paste)
 *   - a dismiss button (toast also auto-dismisses after 30 s in useEvents)
 *
 * Dedupe + cap behavior keeps the panel from drowning the UI when many
 * sessions ping at once: the hook collapses repeat events per session, and
 * this component caps visible toasts at MAX_VISIBLE with a `+N older`
 * expander for the rest.
 */
export function NotificationPanel({ onOpenOrchestrator }: Props) {
  const { waiting, dismiss, clear, connected } = useEvents();
  const [expanded, setExpanded] = useState(false);

  if (waiting.length === 0) {
    return (
      <div className="fixed bottom-2 right-2 text-[10px] font-mono opacity-60">
        events:{' '}
        <span className={connected ? 'text-emerald-400' : 'text-amber-400'}>
          {connected ? 'live' : 'reconnecting…'}
        </span>
      </div>
    );
  }

  // waiting is oldest→newest; keep the newest at the bottom (closest to the
  // anchor) and hide older ones behind the expander when over the cap.
  const visible = expanded ? waiting : waiting.slice(-MAX_VISIBLE);
  const hidden = waiting.length - visible.length;

  return (
    <div className="fixed bottom-4 right-4 flex flex-col gap-2 max-w-sm z-50 max-h-[80vh] overflow-y-auto">
      <div className="flex items-center justify-between text-xs text-slate-400 sticky top-0 bg-slate-950/80 backdrop-blur-sm py-1 px-1">
        <span>{waiting.length} session(s) waiting</span>
        <button className="hover:text-slate-100" onClick={clear}>
          clear all
        </button>
      </div>
      {!expanded && hidden > 0 && (
        <button
          className="self-start text-xs text-slate-300 bg-slate-800/80 hover:bg-slate-700 rounded px-2 py-1"
          onClick={() => setExpanded(true)}
        >
          +{hidden} older
        </button>
      )}
      {expanded && waiting.length > MAX_VISIBLE && (
        <button
          className="self-start text-xs text-slate-300 bg-slate-800/80 hover:bg-slate-700 rounded px-2 py-1"
          onClick={() => setExpanded(false)}
        >
          collapse
        </button>
      )}
      {visible.map((n) => (
        <Toast
          key={n.id}
          notice={n}
          onOpen={n.orchestratorId ? () => onOpenOrchestrator?.(n.orchestratorId!) : undefined}
          onDismiss={() => dismiss(n.id)}
        />
      ))}
    </div>
  );
}

function Toast({
  notice,
  onOpen,
  onDismiss,
}: {
  notice: WaitingNotice;
  onOpen?: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="border border-amber-500/50 bg-amber-500/10 backdrop-blur-sm rounded p-3 text-sm shadow-lg">
      <div className="flex items-center justify-between mb-1">
        <span className="font-semibold text-amber-200">Session waiting</span>
        <button className="text-xs text-slate-400 hover:text-slate-100" onClick={onDismiss}>
          ✕
        </button>
      </div>
      <div className="text-xs text-slate-300 font-mono break-all">{notice.sessionId}</div>
      {notice.reason && <div className="text-[11px] text-slate-400 mt-1">{notice.reason}</div>}
      <div className="text-[11px] text-slate-500 mt-1">{new Date(notice.ts).toLocaleTimeString()}</div>
      {onOpen && (
        <button
          className="mt-2 text-xs px-2 py-1 rounded bg-amber-600 hover:bg-amber-500 text-slate-900 font-medium"
          onClick={onOpen}
        >
          Open orchestrator →
        </button>
      )}
    </div>
  );
}

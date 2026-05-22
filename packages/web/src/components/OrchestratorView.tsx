import { useEffect, useRef, useState } from 'react';
import { api, type OrchestratorView as OrchView, type SessionView } from '../api/client';
import { StatusBadge } from './StatusBadge';
import { Terminal } from './Terminal';
import { BroadcastBar } from './BroadcastBar';

interface Props {
  orchestratorId: string;
  onBack: () => void;
}

/**
 * Phase 3: surface the team. Drill-down on an orchestrator shows the list of
 * sessions, an inbox-count badge per session (polled at 3 s), an attachable
 * terminal, a global broadcast bar, and a per-session quick-reply textarea
 * that pushes raw input into the session's PTY (kept minimal — the canonical
 * "send a teammate a structured message" path is `team.send_message` from
 * inside the session itself).
 */
export function OrchestratorView({ orchestratorId, onBack }: Props) {
  const [orch, setOrch] = useState<OrchView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [inboxCounts, setInboxCounts] = useState<Map<string, number>>(new Map());
  const lastSelectionInit = useRef<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const o = await api.getOrchestrator(orchestratorId);
        if (cancelled) return;
        setOrch(o);
        setError(null);
        if (!lastSelectionInit.current && o.leadSessionId) {
          setActiveSession(o.leadSessionId);
          lastSelectionInit.current = true;
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    void refresh();
    const t = setInterval(() => void refresh(), 2000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [orchestratorId]);

  // Poll inbox counts every 3 s for every visible session. We do this in a
  // separate effect from the orchestrator refresh so the inbox poll cadence
  // is independent of the metadata one.
  useEffect(() => {
    if (!orch) return;
    let cancelled = false;
    async function pollAll() {
      if (!orch) return;
      const next = new Map<string, number>();
      // Fire all peeks in parallel — small N, all loopback.
      await Promise.all(
        orch.sessions.map(async (s) => {
          try {
            const r = await api.peekInbox(orchestratorId, s.id);
            if (!cancelled) next.set(s.id, r.count);
          } catch {
            /* ignore — session may have been destroyed mid-poll */
          }
        }),
      );
      if (!cancelled) setInboxCounts(next);
    }
    void pollAll();
    const t = setInterval(() => void pollAll(), 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [orchestratorId, orch]);

  if (error) {
    return (
      <div>
        <BackButton onBack={onBack} />
        <div className="text-red-400">Error: {error}</div>
      </div>
    );
  }
  if (!orch) {
    return (
      <div>
        <BackButton onBack={onBack} />
        <div className="text-slate-400 text-sm">loading…</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-3">
        <div>
          <BackButton onBack={onBack} />
          <h2 className="text-lg font-semibold mt-2">
            {orch.name} <span className="text-slate-400 font-normal">/ {orch.role}</span>{' '}
            <StatusBadge status={orch.status} />
          </h2>
          <div className="text-xs text-slate-500 font-mono">{orch.id}</div>
        </div>
        <button
          className="px-3 py-1.5 text-sm rounded bg-rose-700/40 hover:bg-rose-600/60"
          onClick={() => {
            if (confirm(`Stop orchestrator ${orch.name}?`)) {
              void api.destroyOrchestrator(orch.id).then(() => onBack());
            }
          }}
        >
          Stop
        </button>
      </div>

      <BroadcastBar orchestratorId={orch.id} />

      <div className="grid grid-cols-12 gap-3 flex-1 min-h-0">
        <div className="col-span-3 border border-slate-700 rounded p-2 bg-slate-900 overflow-y-auto">
          <h3 className="text-sm font-semibold mb-2">
            Sessions{' '}
            <span className="text-xs text-slate-500 font-normal">
              ({orch.sessions.length})
            </span>
          </h3>
          <ul className="space-y-1">
            {orch.sessions.map((s) => (
              <SessionItem
                key={s.id}
                session={s}
                active={activeSession === s.id}
                onClick={() => setActiveSession(s.id)}
                inboxCount={inboxCounts.get(s.id) ?? 0}
                isLead={s.id === orch.leadSessionId}
              />
            ))}
          </ul>
        </div>
        <div className="col-span-9 min-h-0 flex flex-col gap-2">
          {activeSession ? (
            <>
              <QuickReply sessionId={activeSession} />
              <div className="flex-1 min-h-0">
                <Terminal sessionId={activeSession} />
              </div>
            </>
          ) : (
            <div className="text-slate-500 text-sm">Select a session</div>
          )}
        </div>
      </div>
    </div>
  );
}

function SessionItem({
  session,
  active,
  onClick,
  inboxCount,
  isLead,
}: {
  session: SessionView;
  active: boolean;
  onClick: () => void;
  inboxCount: number;
  isLead: boolean;
}) {
  return (
    <li
      onClick={onClick}
      className={`p-2 rounded cursor-pointer text-sm ${
        active ? 'bg-emerald-700/30 border border-emerald-500/40' : 'hover:bg-slate-800'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium truncate">
          {session.name}
          {isLead && (
            <span className="ml-1 text-[10px] uppercase tracking-wide text-amber-300">
              lead
            </span>
          )}
        </span>
        <div className="flex items-center gap-1">
          {inboxCount > 0 && (
            <span
              className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 text-[11px] font-bold rounded-full bg-amber-500 text-slate-900"
              title={`${inboxCount} unread message(s)`}
            >
              {inboxCount}
            </span>
          )}
          <StatusBadge
            status={session.status}
            lastActivityAt={session.lastActivityAt}
          />
        </div>
      </div>
      <div className="text-xs text-slate-500 font-mono mt-0.5">
        {session.type} · pid {session.pid ?? '—'}
      </div>
    </li>
  );
}

/**
 * Per-session quick reply. Pushes the textarea contents into the session's
 * PTY via `POST /sessions/:id/input` (Phase 1 endpoint).
 *
 * Note: this is NOT a `team.send_message` — that path is owned by the agent
 * itself, and it requires the recipient session id. This is a "type
 * something into the agent's terminal as if you were typing at the
 * keyboard" shortcut, useful when you want to quickly steer a busy agent
 * without attaching the full xterm.
 */
function QuickReply({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);

  async function send() {
    const v = text;
    if (!v || pending) return;
    setPending(true);
    try {
      // Append a newline so the agent treats it as a submitted line, not a
      // partial keystroke run. The /sessions/:id/input endpoint forwards
      // bytes verbatim to the PTY.
      await api.postSessionInput(sessionId, v.endsWith('\n') ? v : v + '\n');
      setText('');
    } catch {
      /* noop — UI surfaces the failure as terminal silence; users can retry */
    } finally {
      setPending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="flex gap-2 items-start">
      <textarea
        className="flex-1 bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs font-mono resize-y min-h-[2.25rem]"
        placeholder="Quick input to this session's PTY (Cmd/Ctrl+Enter to send)…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={1}
        disabled={pending}
      />
      <button
        className="px-3 py-1 text-xs rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50"
        onClick={() => void send()}
        disabled={pending || text.length === 0}
      >
        Send input
      </button>
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      className="text-xs text-slate-400 hover:text-slate-200"
      onClick={onBack}
    >
      ← back
    </button>
  );
}

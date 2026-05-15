import { useEffect, useState } from 'react';
import { api, type OrchestratorView as OrchView, type SessionView } from '../api/client';
import { StatusBadge } from './StatusBadge';
import { Terminal } from './Terminal';

interface Props {
  orchestratorId: string;
  onBack: () => void;
}

export function OrchestratorView({ orchestratorId, onBack }: Props) {
  const [orch, setOrch] = useState<OrchView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const o = await api.getOrchestrator(orchestratorId);
        if (cancelled) return;
        setOrch(o);
        setError(null);
        if (!activeSession && o.leadSessionId) setActiveSession(o.leadSessionId);
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
  }, [orchestratorId, activeSession]);

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

      <div className="grid grid-cols-12 gap-3 flex-1 min-h-0">
        <div className="col-span-3 border border-slate-700 rounded p-2 bg-slate-900 overflow-y-auto">
          <h3 className="text-sm font-semibold mb-2">Sessions</h3>
          <ul className="space-y-1">
            {orch.sessions.map((s) => (
              <SessionItem
                key={s.id}
                session={s}
                active={activeSession === s.id}
                onClick={() => setActiveSession(s.id)}
              />
            ))}
          </ul>
        </div>
        <div className="col-span-9 min-h-0 flex flex-col">
          {activeSession ? (
            <Terminal sessionId={activeSession} />
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
}: {
  session: SessionView;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <li
      onClick={onClick}
      className={`p-2 rounded cursor-pointer text-sm ${
        active ? 'bg-emerald-700/30 border border-emerald-500/40' : 'hover:bg-slate-800'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="font-medium">{session.name}</span>
        <StatusBadge status={session.status} />
      </div>
      <div className="text-xs text-slate-500 font-mono mt-0.5">
        {session.type} · pid {session.pid ?? '—'}
      </div>
    </li>
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

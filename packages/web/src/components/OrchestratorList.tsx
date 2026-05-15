import { useState } from 'react';
import { useOrchestrators } from '../hooks/useOrchestrators';
import { NewOrchestratorDialog } from './NewOrchestratorDialog';
import { StatusBadge } from './StatusBadge';

interface Props {
  onSelect: (id: string) => void;
}

export function OrchestratorList({ onSelect }: Props) {
  const { orchestrators, loading, error, refresh, create, destroy } = useOrchestrators();
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Orchestrators</h2>
        <div className="flex gap-2">
          <button
            className="px-3 py-1.5 text-sm rounded bg-slate-700 hover:bg-slate-600"
            onClick={() => void refresh()}
          >
            Refresh
          </button>
          <button
            className="px-3 py-1.5 text-sm rounded bg-emerald-600 hover:bg-emerald-500"
            onClick={() => setDialogOpen(true)}
          >
            New orchestrator
          </button>
        </div>
      </div>

      {loading && <div className="text-slate-400 text-sm">loading…</div>}
      {error && <div className="text-red-400 text-sm">Error: {error}</div>}
      {!loading && !error && orchestrators.length === 0 && (
        <div className="text-slate-500 text-sm">No active orchestrators.</div>
      )}

      <ul className="space-y-2">
        {orchestrators.map((o) => (
          <li
            key={o.id}
            className="border border-slate-700 rounded p-3 bg-slate-900 hover:border-emerald-500/50 transition cursor-pointer flex items-center justify-between"
            onClick={() => onSelect(o.id)}
          >
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold">{o.name}</span>
                <span className="text-slate-400 text-sm">/ {o.role}</span>
                <StatusBadge status={o.status} />
              </div>
              <div className="text-xs text-slate-500 font-mono mt-1">
                {o.id} · {o.sessions.length} session(s) · model {o.defaultModel}
              </div>
            </div>
            <button
              className="px-2 py-1 text-xs rounded bg-rose-700/40 hover:bg-rose-600/60"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Stop orchestrator ${o.name}?`)) void destroy(o.id);
              }}
            >
              Stop
            </button>
          </li>
        ))}
      </ul>

      <NewOrchestratorDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreate={create}
      />
    </div>
  );
}

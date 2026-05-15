import { useState } from 'react';
import { useOrchestrators } from '../hooks/useOrchestrators';
import { NewOrchestratorDialog } from './NewOrchestratorDialog';
import { StatusBadge } from './StatusBadge';
import type { OrchestratorView } from '../api/client';

interface Props {
  onSelect: (id: string) => void;
}

const TERMINAL_STATUSES = new Set(['stopped', 'failed']);

export function OrchestratorList({ onSelect }: Props) {
  const { orchestrators, loading, error, refresh, create, destroy } = useOrchestrators();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(true);

  // Phase 4: server returns active + recently-terminated orchestrators in
  // one array. Split client-side so the UI can display them in distinct
  // sections.
  const active = orchestrators.filter((o) => !TERMINAL_STATUSES.has(o.status));
  const ended = orchestrators.filter((o) => TERMINAL_STATUSES.has(o.status));

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
      {!loading && !error && active.length === 0 && (
        <div className="text-slate-500 text-sm mb-4">No active orchestrators.</div>
      )}

      <ul className="space-y-2">
        {active.map((o) => (
          <OrchestratorRow
            key={o.id}
            orch={o}
            onSelect={() => onSelect(o.id)}
            onStop={async () => {
              if (confirm(`Stop orchestrator ${o.name}?`)) await destroy(o.id);
            }}
          />
        ))}
      </ul>

      {ended.length > 0 && (
        <div className="mt-6">
          <button
            className="text-xs text-slate-400 hover:text-slate-200 mb-2"
            onClick={() => setShowHistory((v) => !v)}
          >
            {showHistory ? '▾' : '▸'} Recently ended ({ended.length})
          </button>
          {showHistory && (
            <ul className="space-y-2 opacity-70">
              {ended.map((o) => (
                <OrchestratorRow
                  key={o.id}
                  orch={o}
                  onSelect={() => onSelect(o.id)}
                  // No Stop button on terminated rows.
                />
              ))}
            </ul>
          )}
        </div>
      )}

      <NewOrchestratorDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreate={create}
      />
    </div>
  );
}

function OrchestratorRow({
  orch,
  onSelect,
  onStop,
}: {
  orch: OrchestratorView;
  onSelect: () => void;
  onStop?: () => void | Promise<void>;
}) {
  return (
    <li
      className="border border-slate-700 rounded p-3 bg-slate-900 hover:border-emerald-500/50 transition cursor-pointer flex items-center justify-between"
      onClick={onSelect}
    >
      <div>
        <div className="flex items-center gap-2">
          <span className="font-semibold">{orch.name}</span>
          <span className="text-slate-400 text-sm">/ {orch.role}</span>
          <StatusBadge status={orch.status} />
          {orch.stopReason === 'server-restart' && (
            <span
              className="text-[10px] uppercase tracking-wide text-purple-300 border border-purple-500/40 rounded px-1 py-0.5"
              title="Marked interrupted because the server restarted; PTYs were not resumable."
            >
              server-restart
            </span>
          )}
        </div>
        <div className="text-xs text-slate-500 font-mono mt-1">
          {orch.id} · {orch.sessions.length} session(s) · model {orch.defaultModel}
          {orch.endedAt && <> · ended {new Date(orch.endedAt).toLocaleString()}</>}
        </div>
        {orch.lastError && (
          <div className="text-[11px] text-rose-400 mt-1 truncate max-w-xl">
            error: {orch.lastError}
          </div>
        )}
      </div>
      {onStop && (
        <button
          className="px-2 py-1 text-xs rounded bg-rose-700/40 hover:bg-rose-600/60"
          onClick={(e) => {
            e.stopPropagation();
            void onStop();
          }}
        >
          Stop
        </button>
      )}
    </li>
  );
}

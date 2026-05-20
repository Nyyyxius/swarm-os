import { useState } from 'react';
import { useRoles } from '../hooks/useRoles';
import { RoleDialog } from './RoleDialog';
import type { RoleView } from '../api/client';

export function RolesPage() {
  const { roles, loading, error, refresh, create, update, destroy } = useRoles();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<RoleView | null>(null);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(role: RoleView) {
    setEditing(role);
    setDialogOpen(true);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Roles</h2>
        <div className="flex gap-2">
          <button
            className="px-3 py-1.5 text-sm rounded bg-slate-700 hover:bg-slate-600"
            onClick={() => void refresh()}
          >
            Refresh
          </button>
          <button
            className="px-3 py-1.5 text-sm rounded bg-emerald-600 hover:bg-emerald-500"
            onClick={openCreate}
          >
            New role
          </button>
        </div>
      </div>

      <p className="text-xs text-slate-400 mb-3 leading-relaxed max-w-2xl">
        Roles are reusable templates for orchestrators. A role can carry a default lead prompt,
        the number of workers to spawn on boot, and per-role connectors (e.g. a Discord webhook
        that wins over the global one).
      </p>

      {loading && <div className="text-slate-400 text-sm">loading…</div>}
      {error && <div className="text-red-400 text-sm">Error: {error}</div>}
      {!loading && !error && roles.length === 0 && (
        <div className="text-slate-500 text-sm">No roles yet — click "New role" to create one.</div>
      )}

      {roles.length > 0 && (
        <ul className="space-y-2">
          {roles.map((r) => (
            <li
              key={r.id}
              className="border border-slate-800 bg-slate-900 rounded p-3 flex items-start justify-between gap-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-semibold">{r.label}</span>
                  <span className="text-[11px] text-slate-500 font-mono">{r.id}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-400">
                  {r.workerCount != null && r.workerCount > 0 && (
                    <span className="px-1.5 py-0.5 rounded bg-slate-800">
                      {r.workerCount} initial worker{r.workerCount > 1 ? 's' : ''}
                    </span>
                  )}
                  {r.defaultModel && (
                    <span className="px-1.5 py-0.5 rounded bg-slate-800">{r.defaultModel}</span>
                  )}
                  {r.defaultEffort && (
                    <span className="px-1.5 py-0.5 rounded bg-slate-800">effort={r.defaultEffort}</span>
                  )}
                  {r.connectors.find((c) => c.type === 'discord') && (
                    <span className="px-1.5 py-0.5 rounded bg-indigo-900/60 text-indigo-200">
                      Discord
                    </span>
                  )}
                  {r.leadPrompt && (
                    <span className="px-1.5 py-0.5 rounded bg-slate-800">has lead prompt</span>
                  )}
                </div>
                {r.leadPrompt && (
                  <div className="mt-1 text-xs text-slate-300 line-clamp-2 font-mono">
                    {r.leadPrompt}
                  </div>
                )}
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  className="px-2 py-1 text-xs rounded bg-slate-700 hover:bg-slate-600"
                  onClick={() => openEdit(r)}
                >
                  Edit
                </button>
                <button
                  className="px-2 py-1 text-xs rounded bg-red-800 hover:bg-red-700"
                  onClick={async () => {
                    if (confirm(`Delete role "${r.label}"? Existing orchestrators are not affected.`)) {
                      await destroy(r.id);
                    }
                  }}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <RoleDialog
        open={dialogOpen}
        initial={editing}
        onClose={() => setDialogOpen(false)}
        onSubmit={async (body) => {
          if (editing) {
            return await update(editing.id, body);
          }
          return await create(body);
        }}
      />
    </div>
  );
}

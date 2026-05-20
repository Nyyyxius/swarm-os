import { useEffect, useMemo, useState } from 'react';
import type { OrchestratorView, RoleView } from '../api/client';
import { useRoles } from '../hooks/useRoles';
import { RoleDialog } from './RoleDialog';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (body: {
    name: string;
    role?: string;
    roleId?: string;
    lead: { cwd: string; prompt?: string; preamble?: string };
    defaults?: { model?: string; effort?: string; permissionMode?: string };
  }) => Promise<OrchestratorView>;
}

const CREATE_ROLE_SENTINEL = '__create_new__';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const PERMS = ['auto', 'acceptEdits', 'bypassPermissions', 'default', 'dontAsk', 'plan'] as const;
const MODELS = [
  { value: 'claude-opus-4-7', label: 'Opus 4.7 (claude-opus-4-7)' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (claude-sonnet-4-6)' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (claude-haiku-4-5-20251001)' },
] as const;

export function NewOrchestratorDialog({ open, onClose, onCreate }: Props) {
  const { roles, create: createRole } = useRoles();
  const [name, setName] = useState('smoke');
  const [selectedRoleId, setSelectedRoleId] = useState<string>('');
  const [role, setRole] = useState('test');
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('say hi');
  const [preamble, setPreamble] = useState('');
  const [model, setModel] = useState('claude-opus-4-7');
  const [effort, setEffort] = useState<(typeof EFFORTS)[number]>('xhigh');
  const [perm, setPerm] = useState<(typeof PERMS)[number]>('bypassPermissions');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);

  const selectedRole: RoleView | null = useMemo(
    () => (selectedRoleId ? roles.find((r) => r.id === selectedRoleId) ?? null : null),
    [selectedRoleId, roles],
  );

  // Auto-fill fields from the selected role. Only overwrites the value if it's
  // still at the default/empty — we don't trample what the user has typed.
  useEffect(() => {
    if (!selectedRole) return;
    setRole(selectedRole.label);
    if (selectedRole.leadPrompt) setPrompt(selectedRole.leadPrompt);
    if (selectedRole.leadPreamble) setPreamble(selectedRole.leadPreamble);
    if (selectedRole.defaultModel) setModel(selectedRole.defaultModel);
    if (selectedRole.defaultEffort) setEffort(selectedRole.defaultEffort);
    if (selectedRole.defaultPermissionMode)
      setPerm(selectedRole.defaultPermissionMode as (typeof PERMS)[number]);
  }, [selectedRole]);

  if (!open) return null;

  function onRolePicked(value: string) {
    if (value === CREATE_ROLE_SENTINEL) {
      setRoleDialogOpen(true);
      return;
    }
    setSelectedRoleId(value);
    if (!value) {
      // Falling back to "(no role)" — clear the label so the user retypes
      // an inline one rather than keeping the previous role's label.
      setRole('test');
    }
  }

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      await onCreate({
        name,
        role,
        ...(selectedRoleId ? { roleId: selectedRoleId } : {}),
        lead: {
          cwd,
          prompt,
          ...(preamble ? { preamble } : {}),
        },
        defaults: { model, effort, permissionMode: perm },
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-30 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-lg w-full max-w-xl p-6 shadow-2xl">
        <h2 className="text-xl font-semibold mb-4">New orchestrator</h2>
        <div className="grid grid-cols-2 gap-3">
          <Field label="name">
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="role">
            <select
              className={inputCls}
              value={selectedRoleId}
              onChange={(e) => onRolePicked(e.target.value)}
            >
              <option value="">(no role — type a label below)</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
              <option value={CREATE_ROLE_SENTINEL}>+ Create new role…</option>
            </select>
            {!selectedRoleId && (
              <input
                className={`${inputCls} mt-1`}
                placeholder="role label (e.g. researcher)"
                value={role}
                onChange={(e) => setRole(e.target.value)}
              />
            )}
            {selectedRole && (
              <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-slate-400">
                {selectedRole.workerCount != null && selectedRole.workerCount > 0 && (
                  <span className="px-1.5 py-0.5 rounded bg-slate-800">
                    will spawn {selectedRole.workerCount} worker
                    {selectedRole.workerCount > 1 ? 's' : ''}
                  </span>
                )}
                {selectedRole.connectors.find((c) => c.type === 'discord') && (
                  <span className="px-1.5 py-0.5 rounded bg-indigo-900/60 text-indigo-200">
                    Discord webhook
                  </span>
                )}
              </div>
            )}
          </Field>
          <Field label="cwd (workspace-relative, ex: / ou /mon-projet)" wide>
            <input
              className={inputCls}
              placeholder="/mon-projet"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
            />
          </Field>
          <Field label="lead prompt" wide>
            <textarea
              className={`${inputCls} h-24 font-mono text-xs`}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </Field>
          <Field label="lead preamble (optional)" wide>
            <textarea
              className={`${inputCls} h-20 font-mono text-xs`}
              value={preamble}
              onChange={(e) => setPreamble(e.target.value)}
            />
          </Field>
          <Field label="model">
            <select
              className={inputCls}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="effort">
            <select
              className={inputCls}
              value={effort}
              onChange={(e) => setEffort(e.target.value as (typeof EFFORTS)[number])}
            >
              {EFFORTS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="permission mode" wide>
            <select
              className={inputCls}
              value={perm}
              onChange={(e) => setPerm(e.target.value as (typeof PERMS)[number])}
            >
              {PERMS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            {/* Phase 6 — explicit warning when the operator picks (or keeps the
                default) bypassPermissions. The plan defaults to bypass per §3,
                §17 because isolation comes from the container; outside that
                container this would be wildly unsafe. */}
            {perm === 'bypassPermissions' && (
              <p className="mt-1 text-[11px] leading-snug text-amber-300">
                bypassPermissions disables Claude&apos;s permission prompts. Safe
                inside the swarm-os container; do NOT use outside isolated
                environments.
              </p>
            )}
          </Field>
        </div>
        {error && <div className="mt-3 text-sm text-red-400 break-words">{error}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <button
            className="px-3 py-1.5 text-sm rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            className="px-3 py-1.5 text-sm rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50"
            onClick={() => void submit()}
            disabled={submitting || !name || !role || !cwd || !prompt}
          >
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
      <RoleDialog
        open={roleDialogOpen}
        onClose={() => setRoleDialogOpen(false)}
        onSubmit={async (body) => {
          const r = await createRole(body);
          setSelectedRoleId(r.id);
          return r;
        }}
      />
    </div>
  );
}

const inputCls =
  'w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100 focus:outline-none focus:border-emerald-500';

function Field({
  label,
  wide,
  children,
}: {
  label: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`block ${wide ? 'col-span-2' : ''}`}>
      <span className="block text-xs uppercase tracking-wide text-slate-400 mb-1">{label}</span>
      {children}
    </label>
  );
}

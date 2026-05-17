import { useState } from 'react';
import type { OrchestratorView } from '../api/client';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (body: {
    name: string;
    role: string;
    lead: { cwd: string; prompt: string; preamble?: string };
    defaults?: { model?: string; effort?: string; permissionMode?: string };
  }) => Promise<OrchestratorView>;
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const PERMS = ['auto', 'acceptEdits', 'bypassPermissions', 'default', 'dontAsk', 'plan'] as const;

export function NewOrchestratorDialog({ open, onClose, onCreate }: Props) {
  const [name, setName] = useState('smoke');
  const [role, setRole] = useState('test');
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('say hi');
  const [preamble, setPreamble] = useState('');
  const [model, setModel] = useState('claude-opus-4-7');
  const [effort, setEffort] = useState<(typeof EFFORTS)[number]>('xhigh');
  const [perm, setPerm] = useState<(typeof PERMS)[number]>('bypassPermissions');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      await onCreate({
        name,
        role,
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
            <input
              className={inputCls}
              value={role}
              onChange={(e) => setRole(e.target.value)}
            />
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
            <input
              className={inputCls}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
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

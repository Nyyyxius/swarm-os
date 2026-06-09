import { useEffect, useMemo, useState } from 'react';
import type { OrchestratorView, RoleView } from '../api/client';
import { useRoles } from '../hooks/useRoles';
import { RoleDialog } from './RoleDialog';

/**
 * Phase C — Step 9 — v2 port.
 *
 * Warm-black amber layout (`.modal`, `.field*`, `.seg-radio`, `.btn*`) from
 * `desktop-theme.css` (Step 1). Props signature and payload shape are
 * preserved so `OrchestratorList.tsx` and `DesktopShell.tsx` (Step 9 caller)
 * keep working without changes. Spec: docs/redesign-desktop/09_new-orchestrator-dialog.md
 *
 * Auto-fill policy (compromise — spec §3.1) : on role change, MODEL/EFFORT/
 * PERMISSION are always overwritten (technical defaults), but LEAD PROMPT
 * and LEAD PREAMBLE are only written if the user hasn't typed anything yet.
 *
 * The nested RoleDialog is rendered inline; we pass `containerStyle={{
 * zIndex: 110 }}` to push it above this dialog's `.modal-backdrop` (which
 * lives at `z-index: 100`). Once RoleDialog is also ported to v2 (Step 10)
 * this prop can drop back to its default and we can remove the override.
 */

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
// Kept verbose on purpose (vs proto's `m.replace('claude-', '')`): operators
// need to see the exact model id they're committing to. Source of truth for
// supported models — do NOT replace with the proto's outdated list.
const MODELS = [
  { value: 'claude-opus-4-8', label: 'Opus 4.8 (claude-opus-4-8)' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (claude-sonnet-4-6)' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (claude-haiku-4-5-20251001)' },
] as const;

export function NewOrchestratorDialog({ open, onClose, onCreate }: Props) {
  const { roles, create: createRole } = useRoles();
  const [name, setName] = useState('');
  const [selectedRoleId, setSelectedRoleId] = useState<string>('');
  const [role, setRole] = useState('');
  // Default to `/` — a valid value so the form isn't disabled at boot when
  // name + prompt are filled. Spec §3 / §10.
  const [cwd, setCwd] = useState('/');
  const [prompt, setPrompt] = useState('');
  const [preamble, setPreamble] = useState('');
  const [model, setModel] = useState<string>('claude-opus-4-8');
  const [effort, setEffort] = useState<(typeof EFFORTS)[number]>('xhigh');
  const [perm, setPerm] = useState<(typeof PERMS)[number]>('bypassPermissions');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);

  // Pré-select the first role as soon as one arrives. Roles come from a
  // 5 s poll; we can't initialise this in `useState(...)` because the
  // first render typically sees `roles=[]`.
  useEffect(() => {
    if (selectedRoleId) return;
    const first = roles[0];
    if (first) setSelectedRoleId(first.id);
  }, [roles, selectedRoleId]);

  const selectedRole: RoleView | null = useMemo(
    () => (selectedRoleId ? roles.find((r) => r.id === selectedRoleId) ?? null : null),
    [selectedRoleId, roles],
  );

  // Auto-fill from role: always overwrite the technical defaults
  // (model/effort/permission), but spare the user-typed prompt/preamble.
  useEffect(() => {
    if (!selectedRole) return;
    setRole(selectedRole.label);
    if (selectedRole.defaultModel) setModel(selectedRole.defaultModel);
    if (selectedRole.defaultEffort) setEffort(selectedRole.defaultEffort);
    if (selectedRole.defaultPermissionMode) {
      setPerm(selectedRole.defaultPermissionMode as (typeof PERMS)[number]);
    }
    if (!prompt.trim() && selectedRole.leadPrompt) setPrompt(selectedRole.leadPrompt);
    if (!preamble.trim() && selectedRole.leadPreamble) setPreamble(selectedRole.leadPreamble);
    // We intentionally depend only on `selectedRole` so retyping prompt/
    // preamble doesn't trigger an auto-fill loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRole]);

  // Reset the nested role dialog when the parent closes, otherwise it would
  // pop back up the next time NewOrchestratorDialog re-opens.
  useEffect(() => {
    if (!open) setRoleDialogOpen(false);
  }, [open]);

  if (!open) return null;

  function onRolePicked(value: string) {
    if (value === CREATE_ROLE_SENTINEL) {
      // Open RoleDialog without mutating `selectedRoleId` — the <select>
      // visually keeps the previous role until the new one resolves.
      setRoleDialogOpen(true);
      return;
    }
    setSelectedRoleId(value);
  }

  const canCreate =
    name.trim().length > 0 &&
    cwd.trim().length > 0 &&
    prompt.trim().length > 0 &&
    !submitting;

  async function submit() {
    if (!canCreate) return;
    setError(null);
    setSubmitting(true);
    try {
      await onCreate({
        // Force UPPERCASE for visual parity with the team-pills (proto v2).
        name: name.trim().toUpperCase(),
        role: role || undefined,
        ...(selectedRoleId ? { roleId: selectedRoleId } : {}),
        lead: {
          cwd: cwd.trim() || '/',
          prompt: prompt.trim(),
          ...(preamble.trim() ? { preamble: preamble.trim() } : {}),
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
    <>
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            + NEW ORCHESTRATOR <span className="sub">// spin up a new team</span>
          </div>
          <button className="pr-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="modal-body">
          <div className="field-row">
            <div className="field">
              <label htmlFor="orch-name">NAME</label>
              <input
                id="orch-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. NOMAD"
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor="orch-role">ROLE</label>
              <select
                id="orch-role"
                value={selectedRoleId}
                onChange={(e) => onRolePicked(e.target.value)}
              >
                {roles.length === 0 && <option value="">(no roles yet)</option>}
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>{r.label}</option>
                ))}
                <option value={CREATE_ROLE_SENTINEL}>+ create new role…</option>
              </select>
              {selectedRole && (
                <div className="field-help">
                  {selectedRole.workerCount != null && selectedRole.workerCount > 0 && (
                    <>will spawn {selectedRole.workerCount} worker
                    {selectedRole.workerCount > 1 ? 's' : ''}{' '}</>
                  )}
                  {selectedRole.connectors.find((c) => c.type === 'discord') && (
                    <>· discord webhook</>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="field">
            <label htmlFor="orch-cwd">WORKING DIRECTORY (CWD)</label>
            <input
              id="orch-cwd"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/workspace/path"
            />
            <div className="field-help">
              workspace-relative path the lead will operate from
            </div>
          </div>

          <div className="field">
            <label htmlFor="orch-prompt">LEAD PROMPT</label>
            <textarea
              id="orch-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder='Initial task for the lead. e.g. "Ship the new swarm.bin under the new constraints."'
            />
          </div>

          <div className="field">
            <label htmlFor="orch-preamble">
              LEAD PREAMBLE <span style={{ color: 'var(--text-mute)' }}>// optional</span>
            </label>
            <textarea
              id="orch-preamble"
              value={preamble}
              onChange={(e) => setPreamble(e.target.value)}
              placeholder="System preamble injected before the lead prompt. Defaults from the role."
            />
          </div>

          <div className="field-3">
            <div className="field">
              <label htmlFor="orch-model">MODEL</label>
              <select
                id="orch-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                {MODELS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>EFFORT</label>
              <div className="seg-radio" role="radiogroup" aria-label="effort">
                {EFFORTS.map((ef) => (
                  <button
                    key={ef}
                    type="button"
                    role="radio"
                    aria-checked={effort === ef}
                    className={effort === ef ? 'on' : ''}
                    onClick={() => setEffort(ef)}
                  >
                    {ef}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label htmlFor="orch-perm">PERMISSION</label>
              <select
                id="orch-perm"
                value={perm}
                onChange={(e) => setPerm(e.target.value as (typeof PERMS)[number])}
              >
                {PERMS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
          </div>

          {perm === 'bypassPermissions' && (
            <div className="field-warn" role="alert">
              ⚠ bypassPermissions :: agent will skip ALL permission prompts.
              Safe inside the swarm-os container; do NOT use outside isolated
              environments.
            </div>
          )}

          {error && (
            <div
              className="field-warn"
              role="alert"
              style={{
                color: 'var(--bad)',
                borderLeftColor: 'var(--bad)',
                background: 'rgba(224,101,74,0.06)',
              }}
            >
              {error}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={submitting}>
            CANCEL
          </button>
          <button
            className="btn primary"
            disabled={!canCreate}
            onClick={() => void submit()}
            style={{ opacity: canCreate ? 1 : 0.4 }}
          >
            {submitting ? 'CREATING…' : 'CREATE TEAM →'}
          </button>
        </div>
      </div>
    </div>

    {/* Rendered as a sibling (not a child) of `.modal-backdrop` so clicks
        inside the nested role dialog don't bubble up to the backdrop's
        onClose handler and dismiss both modals. */}
    <RoleDialog
      open={roleDialogOpen}
      onClose={() => setRoleDialogOpen(false)}
      onSubmit={async (body) => {
        const r = await createRole(body);
        // `useRoles().create` awaits a refresh() before returning, so
        // r.id is guaranteed to be in `roles[]` by the time we land here
        // — the auto-fill effect will pick it up on next render.
        setSelectedRoleId(r.id);
        return r;
      }}
      // z-index workaround : RoleDialog still uses Tailwind `z-40` which
      // sits *below* our `.modal-backdrop` (z-index 100). Once RoleDialog
      // is ported to v2 (Step 10) this override can be dropped.
      containerStyle={{ zIndex: 110 }}
    />
    </>
  );
}

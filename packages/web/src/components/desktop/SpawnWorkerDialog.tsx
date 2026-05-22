// packages/web/src/components/desktop/SpawnWorkerDialog.tsx
//
// Phase C — Step 13 : preview-disabled port of the v2 SpawnWorkerDialog
// (`prototypes/v2/modals.jsx:312-372`).
//
// v1 contract (cf. `docs/redesign-desktop/13_spawn-worker-edit-config.md`
// §4) : the dialog is fully interactive (name auto-uppercase, role
// dropdown filtered, override textarea, inheritance helper line) but the
// SPAWN button is **always disabled** with a tooltip and an inline
// `.field-warn` block documenting the missing endpoint (gap §4-3 —
// `POST /orchestrators/:id/workers`) and the manual MCP workaround.
//
// `onSpawn` is reserved for v2 (kept in the prop signature so the
// call-site `DesktopShell` doesn't have to be touched when the endpoint
// lands — only the `canSpawn` calculation and the `.field-warn` block
// will be removed). See spec §5.3.

import { useEffect, useMemo, useState } from 'react';
import type { OrchestratorView, RoleView } from '../../api/client';

interface Props {
  open: boolean;
  team: OrchestratorView | null;
  roles: readonly RoleView[];
  onClose: () => void;
  /**
   * Reserved for v2 once `POST /orchestrators/:id/workers` lands.
   * v1: never invoked (button is disabled).
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onSpawn?: (spec: {
    name: string;
    roleId: string;
    roleLabel: string;
    workerPreambleOverride: string | null;
  }) => Promise<void>;
}

const GAP_TOOLTIP = 'available in v2 — see workaround below (gap §4-3)';

export default function SpawnWorkerDialog({ open, team, roles, onClose }: Props) {
  // Pré-sélectionne le premier role non-ORCHESTRATOR (parité proto v2,
  // cf. `prototypes/v2/modals.jsx:339`).
  const workerRoles = useMemo(
    () => roles.filter((r) => r.label !== 'ORCHESTRATOR'),
    [roles],
  );
  const [name, setName] = useState('');
  const [roleId, setRoleId] = useState<string>('');
  const [override, setOverride] = useState('');

  // Reset chaque (ré)ouverture — pas de persistance entre ouvertures
  // (parité proto, cf. spec §11 note 7).
  useEffect(() => {
    if (open) {
      setName('');
      setOverride('');
      setRoleId(workerRoles[0]?.id ?? '');
    }
  }, [open, workerRoles]);

  // Esc → onClose (parité BroadcastModal Step 12).
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !team) return null;

  const role = workerRoles.find((r) => r.id === roleId) ?? workerRoles[0] ?? null;
  const nameValid = name.trim().length > 0;
  // v1 : toujours disabled (gap §4-3). `nameValid` est calculé pour le
  // template MCP du `.field-warn` (snippet "ready-to-copy") — il ne
  // gouverne pas le bouton. Quand l'endpoint arrivera : `canSpawn =
  // nameValid && !!role && !submitting`. Cf. spec §5.3.
  const canSpawn = false;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="spawn-worker-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="modal-title" id="spawn-worker-title">
            + SPAWN WORKER{' '}
            <span className="sub">// in {team.name}</span>
          </div>
          <button className="pr-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="modal-body">
          <div className="field-row">
            <div className="field">
              <label htmlFor="spawn-name">NAME</label>
              <input
                id="spawn-name"
                value={name}
                onChange={(e) => setName(e.target.value.toUpperCase())}
                placeholder="e.g. PROBE-04"
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor="spawn-role">ROLE</label>
              <select
                id="spawn-role"
                value={roleId}
                onChange={(e) => setRoleId(e.target.value)}
              >
                {workerRoles.length === 0 && (
                  <option value="">— no worker roles available —</option>
                )}
                {workerRoles.map((r) => (
                  <option key={r.id} value={r.id}>{r.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="field">
            <label htmlFor="spawn-override">
              WORKER PREAMBLE OVERRIDE{' '}
              <span style={{ color: 'var(--text-mute)' }}>// optional</span>
            </label>
            <textarea
              id="spawn-override"
              value={override}
              onChange={(e) => setOverride(e.target.value)}
              placeholder={
                role?.workerPreamble ??
                "Leave empty to use the role's default worker preamble."
              }
              style={{ minHeight: 80 }}
            />
          </div>

          <div className="field-help">
            New worker will inherit MODEL{' '}
            <b>{team.defaultModel.replace('claude-', '')}</b>{' '}
            · EFFORT <b>{team.defaultEffort}</b>{' '}
            · PERM <b>{team.defaultPermissionMode}</b>{' '}
            from {team.name}.
          </div>

          {/* gap §4-3 disclosure ─ documents the missing endpoint + the
              manual MCP workaround. The snippet is intentionally ready
              to copy: it reflects the live `name` / `role` inputs so
              the operator can paste it into the TEAM composer. */}
          <div className="field-warn">
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              ⚠ available in v2 — backend endpoint missing
            </div>
            <div style={{ color: 'var(--text-dim)', fontSize: 11, lineHeight: 1.55 }}>
              <code>POST /orchestrators/:id/workers</code> is not implemented
              yet (plan §4-3). The button below is disabled.
              <br />
              <span style={{ color: 'var(--text-mute)' }}>
                Manual workaround: cancel, open the TEAM composer on this
                lead, and broadcast:
              </span>
              <div
                style={{
                  marginTop: 6,
                  padding: '6px 8px',
                  background: 'rgba(232,176,74,0.06)',
                  borderLeft: '2px solid var(--amber)',
                  fontFamily: 'Geist Mono, monospace',
                  fontSize: 10.5,
                  color: 'var(--text)',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {`Please call team.spawn_worker(\n  name="${nameValid ? name.trim() : 'PROBE-04'}",\n  role="${role?.label ?? 'BUILDER'}",\n  prompt="<your task here>"\n) from your MCP client.`}
              </div>
              <span style={{ color: 'var(--text-mute)' }}>
                The lead will receive it in its mailbox and may invoke the MCP
                tool. No acknowledgement is returned to the UI; the new
                session will appear in MapView once spawned.
              </span>
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>CANCEL</button>
          <button
            className="btn primary"
            disabled={!canSpawn}
            style={{ opacity: 0.4, cursor: 'not-allowed' }}
            title={GAP_TOOLTIP}
            aria-disabled="true"
          >
            SPAWN →{' '}
            <span style={{ color: 'var(--text-mute)', fontSize: 10 }}>(v2)</span>
          </button>
        </div>
      </div>
    </div>
  );
}

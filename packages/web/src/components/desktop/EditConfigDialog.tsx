// packages/web/src/components/desktop/EditConfigDialog.tsx
//
// Phase C — Step 13 : preview-disabled port of the v2 EditConfigDialog
// (`prototypes/v2/modals.jsx:374-426`).
//
// v1 contract (cf. `docs/internal/ui-redesign/redesign-desktop/13_spawn-worker-edit-config.md`
// §6) : the dialog is fully interactive (MODEL dropdown, EFFORT
// `.seg-radio`, PERMISSION MODE dropdown with the inline
// bypassPermissions warning) but the ROTATE+RESTART button is **always
// disabled** with a tooltip and an inline `.field-warn` block documenting
// the missing endpoint (gap §4-2 — `PATCH /orchestrators/:id`) and the
// destroy+recreate workaround caveats.
//
// `onSave` is reserved for v2 (kept in the prop signature so the
// call-site `DesktopShell` doesn't have to be touched when the endpoint
// lands — only the `canSave` calculation and the `.field-warn` block
// will be removed). See spec §7.4.
//
// Multi-provider Lot 3 : the PROVIDER + MODEL controls are wired to
// `GET /providers` here so this surface is ready when the endpoint lands.
// The dialog is STILL DISABLED — activating it is Lot 7, not this one.

import { useEffect, useState } from 'react';
import type { OrchestratorView } from '../../api/client';
import { useProviders } from '../../hooks/useProviders';
import {
  ModelSelect,
  ProviderSelect,
  defaultModelFor,
  effortNote,
  effortsFor,
  findProvider,
  isPermissionChoice,
  permissionNote,
  permissionsFor,
  unavailableNote,
} from '../ProviderFields';
import { EFFORTS, type Effort, type PermissionMode } from './constants';

interface Props {
  open: boolean;
  team: OrchestratorView | null;
  onClose: () => void;
  /** Reserved for v2 once PATCH /orchestrators/:id lands. Unused v1. */
  onSave?: (patch: {
    model: string;
    effort: Effort;
    permissionMode: PermissionMode;
  }) => Promise<void>;
}

const GAP_TOOLTIP = 'available in v2 — see workaround below (gap §4-2)';

export default function EditConfigDialog({ open, team, onClose }: Props) {
  const { providers, transport, refresh: refreshProviders } = useProviders();
  const [provider, setProvider] = useState<string>('');
  const [model, setModel] = useState<string>('');
  const [effort, setEffort] = useState<Effort>('high');
  const [perm, setPerm] = useState<PermissionMode>('default');

  // Réinitialise à chaque (ré)ouverture depuis la team courante. Cf.
  // spec §6.4 — pas de persistance entre ouvertures (parité proto).
  useEffect(() => {
    if (open && team) {
      setProvider(team.defaultProvider ?? '');
      setModel(team.defaultModel);
      setEffort(team.defaultEffort);
      setPerm(team.defaultPermissionMode as PermissionMode);
    }
  }, [open, team]);

  // Same reason as NewOrchestratorDialog: the server caches availability for
  // 60 s, so re-probing on open is what makes a newly installed CLI show up
  // without a page reload.
  useEffect(() => {
    if (!open) return;
    void refreshProviders();
  }, [open, refreshProviders]);

  const selectedProvider = findProvider(providers, provider);
  const efforts = effortsFor(selectedProvider);
  const perms = permissionsFor(selectedProvider);
  const permIsChoice = isPermissionChoice(selectedProvider);
  const effectiveEffort = efforts.length > 0 ? effort : selectedProvider?.defaults.effort ?? effort;
  const effectivePerm = perms.includes(perm) ? perm : perms[0] ?? perm;

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

  // v1 : toujours disabled (gap §4-2). Quand l'endpoint arrivera :
  // `canSave = (provider !== team.defaultProvider || model !== team.defaultModel
  //   || effort !== team.defaultEffort
  //   || perm !== team.defaultPermissionMode) && !submitting`. Cf. spec §7.4.
  const canSave = false;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-config-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="modal-title" id="edit-config-title">
            ROTATE CONFIG <span className="sub">{'// '}{team.name}</span>
          </div>
          <button className="pr-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="modal-body">
          <div className="field-help" style={{ color: 'var(--warn)' }}>
            ⚠ Saving will restart all sessions in this team with the new triplet.
          </div>

          <div className="field">
            <label htmlFor="edit-provider">PROVIDER</label>
            <ProviderSelect
              id="edit-provider"
              value={provider}
              providers={providers}
              onChange={(id) => {
                setProvider(id);
                setModel(defaultModelFor(findProvider(providers, id)));
              }}
            />
            {unavailableNote(selectedProvider, transport) && (
              <div className="field-warn">⚠ {unavailableNote(selectedProvider, transport)}</div>
            )}
          </div>

          <div className="field">
            <label htmlFor="edit-model">MODEL</label>
            <ModelSelect
              id="edit-model"
              value={model}
              provider={selectedProvider}
              onChange={setModel}
            />
          </div>

          <div className="field">
            <label>EFFORT</label>
            <div className="seg-radio" role="radiogroup" aria-label="effort">
              {EFFORTS.map((ef) => (
                <button
                  key={ef}
                  type="button"
                  role="radio"
                  aria-checked={effectiveEffort === ef}
                  className={effectiveEffort === ef ? 'on' : ''}
                  disabled={efforts.length === 0}
                  onClick={() => setEffort(ef)}
                >
                  {ef}
                </button>
              ))}
            </div>
            {effortNote(selectedProvider) && (
              <div className="field-help">{effortNote(selectedProvider)}</div>
            )}
          </div>

          <div className="field">
            <label htmlFor="edit-perm">PERMISSION MODE</label>
            <select
              id="edit-perm"
              value={effectivePerm}
              disabled={!permIsChoice}
              onChange={(e) => setPerm(e.target.value as PermissionMode)}
            >
              {perms.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            {permissionNote(selectedProvider) && (
              <div className="field-help">{permissionNote(selectedProvider)}</div>
            )}
            {effectivePerm === 'bypassPermissions' && (
              <div className="field-warn">
                ⚠ bypassPermissions :: agent runs unattended. No permission prompts.
              </div>
            )}
          </div>

          {/* gap §4-2 disclosure ─ documents the missing endpoint + the
              destroy+recreate workaround with explicit losses (red bar). */}
          <div className="field-warn">
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              ⚠ available in v2 — backend endpoint missing
            </div>
            <div style={{ color: 'var(--text-dim)', fontSize: 11, lineHeight: 1.55 }}>
              <code>PATCH /orchestrators/:id</code> is not implemented yet
              (plan §4-2). The button below is disabled.
              <br />
              <span style={{ color: 'var(--text-mute)' }}>
                Manual workaround: cancel, click <b>STOP</b> (or <b>KILL</b>)
                on this team, then <b>+ NEW TEAM</b> with the new triplet.
              </span>
              <div
                style={{
                  marginTop: 6,
                  padding: '6px 8px',
                  background: 'rgba(232,176,74,0.06)',
                  borderLeft: '2px solid var(--bad)',
                  fontSize: 10.5,
                  color: 'var(--text-dim)',
                }}
              >
                <b style={{ color: 'var(--bad)' }}>destroy+recreate would lose:</b>
                <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                  <li>lead session context (LLM history, MCP cache, edits in flight)</li>
                  <li>all worker sessions and their mailboxes</li>
                  <li>
                    the orchestrator id — URLs (<code>#/orchestrators/:id</code>)
                    and Discord webhook keys will break
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>CANCEL</button>
          <button
            className="btn primary"
            disabled={!canSave}
            style={{ opacity: 0.4, cursor: 'not-allowed' }}
            title={GAP_TOOLTIP}
            aria-disabled="true"
          >
            ROTATE + RESTART →{' '}
            <span style={{ color: 'var(--text-mute)', fontSize: 10 }}>(v2)</span>
          </button>
        </div>
      </div>
    </div>
  );
}

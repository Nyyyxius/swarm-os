// packages/web/src/components/desktop/SpawnWorkerDialog.tsx
//
// Add a worker to a live team, with a per-agent provider and model.
//
// History worth keeping: this dialog shipped in Phase C — Step 13 as a
// preview with a permanently disabled SPAWN button, because the backend
// route did not exist (gap §4-3) and the only way to add a worker was to
// ask the lead to call `team.spawn_worker` over MCP. Multi-provider Lot 3
// then wired the PROVIDER / MODEL selects to `GET /providers`, still
// disabled. Lot 7 added `POST /orchestrators/:id/workers` and this file is
// now the live surface: the MCP workaround snippet is gone, because a UI
// that offers a button AND tells the operator to go type an MCP call
// somewhere else says two contradictory things.
//
// Two behaviours are load-bearing and must not be "tidied" away:
//
//  1. **Inheritance is visible.** PROVIDER and MODEL are pre-filled from
//     the team, and every control says whether it currently matches the
//     team or deviates from it. A worker that silently runs a different
//     model than its team is the kind of surprise that costs an hour of
//     debugging. EFFORT and PERMISSION are not offered at all — they
//     always inherit — and the help line says so rather than implying a
//     choice exists.
//  2. **Server errors are shown verbatim.** 400 UNKNOWN_PROVIDER, 409
//     PROVIDER_UNAVAILABLE (+ its reason), 409 ORCH_NOT_ACTIVE, 413
//     (prompt too large) and 429 (worker cap) each mean something precise
//     and actionable. `apiErrorMessage` unwraps `{error, code,
//     unavailableReason}`; the dialog stays OPEN on failure so the
//     operator can fix the field and retry.
//
// The dialog does not pre-block an unavailable provider: `ProviderSelect`
// already renders those as disabled options, and when the TEAM's own
// provider has gone unavailable the operator should read the server's 409
// (with the probe's reason) rather than a greyed-out button with no
// explanation.

import { useEffect, useMemo, useState } from 'react';
import { api, apiErrorMessage, type OrchestratorView, type RoleView, type SkillView } from '../../api/client';
import { useProviders } from '../../hooks/useProviders';
import {
  ModelSelect,
  ProviderSelect,
  defaultModelFor,
  effortNote,
  findProvider,
  notificationNote,
  permissionNote,
  unavailableNote,
} from '../ProviderFields';

interface Props {
  open: boolean;
  team: OrchestratorView | null;
  roles: readonly RoleView[];
  onClose: () => void;
  /**
   * `POST /orchestrators/:id/workers`. MUST reject on failure (and must not
   * close the dialog): the rejection is what carries the server's code and
   * reason to the error block below.
   */
  onSpawn: (
    orchestratorId: string,
    body: {
      name?: string;
      role?: string;
      prompt: string;
      preamble?: string;
      provider?: string;
      model?: string;
    },
  ) => Promise<{ sessionId: string }>;
}

export default function SpawnWorkerDialog({ open, team, roles, onClose, onSpawn }: Props) {
  // Pré-sélectionne le premier role non-ORCHESTRATOR (parité proto v2,
  // cf. `prototypes/v2/modals.jsx:339`).
  const workerRoles = useMemo(
    () => roles.filter((r) => r.label !== 'ORCHESTRATOR'),
    [roles],
  );
  const { providers, transport, refresh: refreshProviders } = useProviders();
  const [name, setName] = useState('');
  const [roleId, setRoleId] = useState<string>('');
  const [prompt, setPrompt] = useState('');
  const [override, setOverride] = useState('');
  const [provider, setProvider] = useState<string>('');
  const [model, setModel] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availableSkills, setAvailableSkills] = useState<SkillView[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);

  // Reset chaque (ré)ouverture — pas de persistance entre ouvertures
  // (parité proto, cf. spec §11 note 7). A worker inherits the team's
  // provider/model by default; the selects exist to override that per agent,
  // which is the whole point of a mixed team.
  useEffect(() => {
    if (open) {
      setName('');
      setPrompt('');
      setOverride('');
      setError(null);
      setSubmitting(false);
      setRoleId(workerRoles[0]?.id ?? '');
      setProvider(team?.defaultProvider ?? '');
      setModel(team?.defaultModel ?? '');
      setSelectedSkills([]);
      api.listSkills().then((r) => setAvailableSkills(r.skills)).catch(() => undefined);
    }
  }, [open, workerRoles, team?.defaultProvider, team?.defaultModel]);

  useEffect(() => {
    if (!open) return;
    void refreshProviders();
  }, [open, refreshProviders]);

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
  const selected = findProvider(providers, provider);
  const nameValid = name.trim().length > 0;
  const promptValid = prompt.trim().length > 0;
  // ROLE is deliberately NOT required: the server falls back to the team's own
  // role when none is sent, so a deployment with no worker roles defined can
  // still add a worker instead of facing a dialog it cannot submit.
  const canSpawn = nameValid && promptValid && !submitting;
  // Deviations from the team, computed once — they drive both the per-field
  // markers and the summary line, so the two can never disagree.
  const providerDeviates = !!provider && provider !== team.defaultProvider;
  const modelDeviates = !!model && model !== team.defaultModel;

  async function submit() {
    if (!canSpawn || !team) return;
    setError(null);
    setSubmitting(true);
    try {
      const { sessionId } = await onSpawn(team.id, {
        name: name.trim(),
        ...(role ? { role: role.label } : {}),
        prompt: prompt.trim(),
        ...(override.trim() ? { preamble: override.trim() } : {}),
        // Sent even when they match the team: what the form displays is what it
        // commits to, and the server treats an explicit value identical to the
        // default exactly the same way.
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      });
      // Activate selected skills at session scope post-spawn (best-effort — spawn
      // already succeeded, so we don't fail the whole operation on a skill error).
      if (selectedSkills.length > 0) {
        await Promise.allSettled(
          selectedSkills.map((skillName) =>
            api.activateSkill(skillName, {
              scope: 'session',
              orchestratorId: team.id,
              sessionId,
            }),
          ),
        );
      }
      onClose();
    } catch (err) {
      // `HttpError.message` alone reads "HTTP 429 POST /orchestrators/…/workers",
      // which tells the operator nothing. `apiErrorMessage` unwraps the code, the
      // written reason, and `unavailableReason` when the provider probe failed.
      setError(apiErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

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
            <span className="sub">{'// in '}{team.name}</span>
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
              {workerRoles.length === 0 && (
                <div className="field-help">
                  none defined — the worker takes {team.name}&apos;s role ({team.role})
                </div>
              )}
            </div>
          </div>

          <div className="field">
            <label htmlFor="spawn-prompt">INITIAL TASK</label>
            <textarea
              id="spawn-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should this worker do? e.g. Audit the auth module for missing token checks."
              style={{ minHeight: 80 }}
            />
            <div className="field-help">
              seeds the agent&apos;s first turn — the role preamble is prepended
              automatically
            </div>
          </div>

          {/* PROVIDER + MODEL per worker: this is how a claude lead ends up
              running codex workers. Pre-filled from the team, and each label
              states whether the current value inherits or deviates — leaving
              them alone must never be a silent decision. */}
          <div className="field-row">
            <div className="field">
              <label htmlFor="spawn-provider">
                PROVIDER{' '}
                <span style={{ color: providerDeviates ? 'var(--amber)' : 'var(--text-mute)' }}>
                  {providerDeviates
                    ? `// overrides ${team.name} (${team.defaultProvider})`
                    : `// inherited from ${team.name}`}
                </span>
              </label>
              <ProviderSelect
                id="spawn-provider"
                value={provider}
                providers={providers}
                onChange={(id) => {
                  setProvider(id);
                  setModel(defaultModelFor(findProvider(providers, id)));
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="spawn-model">
                MODEL{' '}
                <span style={{ color: modelDeviates ? 'var(--amber)' : 'var(--text-mute)' }}>
                  {modelDeviates
                    ? `// overrides ${team.name}`
                    : `// inherited from ${team.name}`}
                </span>
              </label>
              <ModelSelect
                id="spawn-model"
                value={model}
                provider={selected}
                onChange={setModel}
              />
            </div>
          </div>

          {unavailableNote(selected, transport) && (
            <div className="field-warn">
              ⚠ {unavailableNote(selected, transport)}
            </div>
          )}

          {availableSkills.length > 0 && (
            <div className="field">
              <label>
                SKILLS{' '}
                <span style={{ color: 'var(--text-mute)' }}>{'// optional — activated at session scope post-spawn'}</span>
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                {availableSkills.map((s) => {
                  const active = selectedSkills.includes(s.name);
                  return (
                    <button
                      key={s.name}
                      type="button"
                      className="tag-pill"
                      style={{
                        cursor: 'pointer',
                        color: active ? 'var(--amber)' : 'var(--text-dim)',
                        borderColor: active ? 'var(--amber)' : 'var(--border)',
                        background: active ? 'rgba(255,180,0,0.08)' : 'transparent',
                        padding: '2px 8px',
                      }}
                      onClick={() =>
                        setSelectedSkills((prev) =>
                          prev.includes(s.name) ? prev.filter((n) => n !== s.name) : [...prev, s.name],
                        )
                      }
                    >
                      {active ? '✓ ' : ''}{s.displayName ?? s.name}
                    </button>
                  );
                })}
              </div>
              <div className="field-help">
                selected skills are injected into the worker&apos;s preamble at session scope — lost on /clear
              </div>
            </div>
          )}

          <div className="field">
            <label htmlFor="spawn-override">
              WORKER PREAMBLE OVERRIDE{' '}
              <span style={{ color: 'var(--text-mute)' }}>{'// optional'}</span>
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
            New worker will run MODEL{' '}
            <b>{(model || team.defaultModel).replace('claude-', '')}</b>{' '}
            · EFFORT <b>{team.defaultEffort}</b>{' '}
            · PERM <b>{team.defaultPermissionMode}</b>{' '}
            — effort and permission inherited from {team.name}.
          </div>
          {/* Why the line above can be optimistic: the two capabilities that
              make it a half-truth for a foreign CLI. Shown, not discovered. */}
          {effortNote(selected) && (
            <div className="field-help">{effortNote(selected)}</div>
          )}
          {permissionNote(selected) && (
            <div className="field-help">{permissionNote(selected)}</div>
          )}
          {notificationNote(selected) && (
            <div className="field-help">{notificationNote(selected)}</div>
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
            disabled={!canSpawn}
            onClick={() => void submit()}
            style={{ opacity: canSpawn ? 1 : 0.4 }}
            title={canSpawn ? undefined : 'NAME and INITIAL TASK are required'}
          >
            {submitting ? 'SPAWNING…' : 'SPAWN →'}
          </button>
        </div>
      </div>
    </div>
  );
}

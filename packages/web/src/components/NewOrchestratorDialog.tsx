import { useEffect, useMemo, useRef, useState } from 'react';
import { apiErrorMessage, type OrchestratorView, type RoleView } from '../api/client';
import { useRoles } from '../hooks/useRoles';
import { useProviders } from '../hooks/useProviders';
import { RoleDialog } from './RoleDialog';
import {
  ModelSelect,
  ProviderSelect,
  defaultModelFor,
  effortNote,
  effortsFor,
  findProvider,
  isPermissionChoice,
  notificationNote,
  permissionNote,
  permissionsFor,
  unavailableNote,
} from './ProviderFields';
import { EFFORTS, PERMS } from './desktop/constants';

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
 *
 * Multi-provider Lot 3 — PROVIDER is now the first technical field, and MODEL /
 * EFFORT / PERMISSION are all derived from it (`GET /providers`). The local
 * `MODELS` array this file used to carry is gone; see `ProviderFields.tsx`.
 */

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (body: {
    name: string;
    role?: string;
    roleId?: string;
    lead: { cwd: string; prompt?: string; preamble?: string };
    defaults?: {
      provider?: string;
      model?: string;
      effort?: string;
      permissionMode?: string;
    };
  }) => Promise<OrchestratorView>;
}

const CREATE_ROLE_SENTINEL = '__create_new__';

export function NewOrchestratorDialog({ open, onClose, onCreate }: Props) {
  const { roles, create: createRole } = useRoles();
  const {
    providers,
    defaultProvider: serverDefaultProvider,
    transport,
    refresh: refreshProviders,
  } = useProviders();
  const [name, setName] = useState('');
  const [selectedRoleId, setSelectedRoleId] = useState<string>('');
  const [role, setRole] = useState('');
  // Default to `/` — a valid value so the form isn't disabled at boot when
  // name + prompt are filled. Spec §3 / §10.
  const [cwd, setCwd] = useState('/');
  const [prompt, setPrompt] = useState('');
  const [preamble, setPreamble] = useState('');
  const [provider, setProvider] = useState<string>('');
  const [model, setModel] = useState<string>('');
  // EFFORT / PERMISSION keep the operator's last explicit pick even while the
  // selected provider cannot express it. What is displayed and submitted is the
  // *effective* value derived below — so switching provider back restores the
  // intent instead of having silently overwritten it.
  const [effort, setEffort] = useState<(typeof EFFORTS)[number]>('xhigh');
  const [perm, setPerm] = useState<(typeof PERMS)[number]>('bypassPermissions');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  // Track whether the user has hand-typed in the prompt/preamble. While these
  // stay false the fields are "owned" by the role auto-fill, so switching role
  // overwrites them with the new role's defaults. Once the user edits, we stop
  // clobbering. Refs (not state) so reading them inside the auto-fill effect
  // never goes stale and doesn't add an effect dependency.
  const promptEditedRef = useRef(false);
  const preambleEditedRef = useRef(false);

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
  // (model/effort/permission) AND the prompt/preamble — so switching role
  // swaps in that role's prompt. The only exception is a prompt/preamble the
  // user has hand-typed (tracked via the *EditedRef flags), which we never
  // clobber. A role with no leadPrompt/leadPreamble clears the field rather
  // than leaving the previous role's text behind.
  useEffect(() => {
    if (!selectedRole) return;
    setRole(selectedRole.label);
    // PROVIDER before MODEL — and the role's MODEL only travels with the role's
    // PROVIDER. This mirrors the server rule (`providers/resolve.ts`): a model id
    // belongs to whoever supplied it.
    //
    // The case that matters is every role written before multi-provider: a
    // `defaultModel` like `claude-opus-4-8` and NO `defaultProvider`. Such a role
    // inherits the instance default, so picking it while the form sits on gemini
    // used to paste a claude id into a gemini team — and because the operator
    // then submits it EXPLICITLY, the server (rightly) never second-guesses the
    // string. The browser is the only place this one can be caught.
    const roleProvider = selectedRole.defaultProvider || serverDefaultProvider || '';
    // Provider after this effect: the role's when it names one, otherwise the
    // operator's current pick stands (a role with no opinion must not clobber it).
    const nextProvider = selectedRole.defaultProvider || provider || serverDefaultProvider || '';
    if (selectedRole.defaultProvider) setProvider(selectedRole.defaultProvider);
    // `''` is not "no model": it means "use whatever `nextProvider` defaults to",
    // which `effectiveModel` resolves and submits.
    setModel(
      selectedRole.defaultModel && roleProvider === nextProvider
        ? selectedRole.defaultModel
        : '',
    );
    if (selectedRole.defaultEffort) setEffort(selectedRole.defaultEffort);
    if (selectedRole.defaultPermissionMode) {
      setPerm(selectedRole.defaultPermissionMode as (typeof PERMS)[number]);
    }
    if (!promptEditedRef.current) setPrompt(selectedRole.leadPrompt ?? '');
    if (!preambleEditedRef.current) setPreamble(selectedRole.leadPreamble ?? '');
    // `selectedRole` — plus `serverDefaultProvider`, because it is what a role
    // with no `defaultProvider` inherits and the catalogue can land AFTER the
    // role does (two independent async sources). Without it, a role picked
    // during that window would keep the scoping decision it made while the
    // instance default was still unknown. It transitions once, `undefined` →
    // value, so this costs at most one extra idempotent pass. `provider` is
    // deliberately NOT a dependency: re-running on the operator's own pick would
    // undo it. Prompt/preamble are guarded by the *EditedRef flags either way.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRole, serverDefaultProvider]);

  // ── PROVIDER wiring ────────────────────────────────────────────────────
  const selectedProvider = findProvider(providers, provider);
  const efforts = effortsFor(selectedProvider);
  const perms = permissionsFor(selectedProvider);
  const permIsChoice = isPermissionChoice(selectedProvider);
  // Displayed AND submitted. Falls back to the adapter's own default whenever
  // the stored pick is not something this provider accepts, so the form can
  // never promise a knob the CLI does not have.
  const effectiveEffort = efforts.length > 0 ? effort : selectedProvider?.defaults.effort ?? effort;
  const effectivePerm = perms.includes(perm) ? perm : perms[0] ?? perm;
  // No model chosen anywhere ⇒ show (and send) the provider's own default. The
  // server applies the same rule; showing it beats leaving the field blank.
  const effectiveModel = model || defaultModelFor(selectedProvider);

  // Re-probe on every open, not just on mount: the availability verdict has a
  // 60 s TTL server-side, so a CLI installed on the host minutes ago appears
  // without reloading the page — which matters for a container that never
  // restarts. Bootstraps `provider` from the server default on the same beat.
  useEffect(() => {
    if (!open) return;
    void refreshProviders();
  }, [open, refreshProviders]);

  useEffect(() => {
    if (!open || provider || !serverDefaultProvider) return;
    setProvider(serverDefaultProvider);
  }, [open, provider, serverDefaultProvider]);

  /**
   * Switching provider resets MODEL to the new provider's default — leaving a
   * `claude-opus-*` id selected under `gemini` would be a spawn failure the
   * operator only discovers in the session log.
   */
  function onProviderPicked(id: string) {
    setProvider(id);
    setModel(defaultModelFor(findProvider(providers, id)));
  }

  // The dialog stays mounted across open/close (DesktopShell toggles `open`),
  // so without an explicit reset every field would keep whatever the previous
  // create/cancel left behind. On each fresh open we wipe back to defaults and
  // drop `selectedRoleId` so the first-role pre-select + auto-fill re-run and
  // repopulate the prompt from the role. On close we just tidy the nested
  // role dialog so it doesn't pop back up next time.
  useEffect(() => {
    if (!open) {
      setRoleDialogOpen(false);
      return;
    }
    setName('');
    setRole('');
    setCwd('/');
    setPrompt('');
    setPreamble('');
    // Empty, not a hard-coded id: the effective value comes from the provider
    // (`effectiveModel`), and the provider from the server default.
    setProvider('');
    setModel('');
    setEffort('xhigh');
    setPerm('bypassPermissions');
    setError(null);
    setSubmitting(false);
    promptEditedRef.current = false;
    preambleEditedRef.current = false;
    setSelectedRoleId('');
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
        defaults: {
          // Send what the form displays: the effective triplet, plus the
          // provider so the server does not have to guess. Empty strings are
          // omitted so the server's own body > role > config precedence keeps
          // working when the catalogue never loaded.
          ...(provider ? { provider } : {}),
          ...(effectiveModel ? { model: effectiveModel } : {}),
          effort: effectiveEffort,
          permissionMode: effectivePerm,
        },
      });
      onClose();
    } catch (err) {
      // `UNKNOWN_PROVIDER` (400) and `PROVIDER_UNAVAILABLE` (409) carry a code
      // and a written reason; `HttpError.message` alone would read
      // "HTTP 409 POST /orchestrators", which tells the operator nothing.
      setError(apiErrorMessage(err));
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
              onChange={(e) => {
                promptEditedRef.current = true;
                setPrompt(e.target.value);
              }}
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
              onChange={(e) => {
                preambleEditedRef.current = true;
                setPreamble(e.target.value);
              }}
              placeholder="System preamble injected before the lead prompt. Defaults from the role."
            />
          </div>

          {/* PROVIDER first: MODEL, EFFORT and PERMISSION are all derived
              from it. Unavailable adapters stay listed and disabled with their
              reason, so the operator learns WHY codex or gemini cannot be
              picked instead of watching them silently not exist. */}
          <div className="field-row">
            <div className="field">
              <label htmlFor="orch-provider">PROVIDER</label>
              <ProviderSelect
                id="orch-provider"
                value={provider}
                providers={providers}
                onChange={onProviderPicked}
              />
              <div className="field-help">
                {selectedProvider
                  ? `${selectedProvider.binary}${
                      selectedProvider.version ? ` · ${selectedProvider.version}` : ''
                    }${transport ? ` · transport ${transport}` : ''}`
                  : 'agent CLI driving this team'}
              </div>
            </div>
            <div className="field">
              <label htmlFor="orch-model">MODEL</label>
              <ModelSelect
                id="orch-model"
                value={effectiveModel}
                provider={selectedProvider}
                onChange={setModel}
              />
              <div className="field-help">
                exact id sent to the CLI — pick “other…” for one we do not list yet
              </div>
            </div>
          </div>

          {unavailableNote(selectedProvider, transport) && (
            <div className="field-warn">⚠ {unavailableNote(selectedProvider, transport)}</div>
          )}
          {notificationNote(selectedProvider) && (
            <div className="field-help">{notificationNote(selectedProvider)}</div>
          )}

          <div className="field-row">
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
              <label htmlFor="orch-perm">PERMISSION</label>
              <select
                id="orch-perm"
                value={effectivePerm}
                disabled={!permIsChoice}
                onChange={(e) => setPerm(e.target.value as (typeof PERMS)[number])}
              >
                {perms.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
              {permissionNote(selectedProvider) && (
                <div className="field-help">{permissionNote(selectedProvider)}</div>
              )}
            </div>
          </div>

          {effectivePerm === 'bypassPermissions' && (
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

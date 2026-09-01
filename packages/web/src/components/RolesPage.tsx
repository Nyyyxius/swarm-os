// Phase C — Step 10 (Étape C.10) — `RolesPage` v2 fullscreen overlay.
//
// Replaces the previous Tailwind list+modal page with the v2 prototype layout
// (cf. `prototypes/v2/modals.jsx:119-218` and `docs/redesign-desktop/10_roles-page-overlay.md`):
//
//   ┌──────────────────────────────────────────────────────────────────┐
//   │  TopBar (kept visible above the overlay — `.roles-overlay` is    │
//   │  `position: fixed; inset: 56px 0 0 0`)                           │
//   ├────────────────────┬─────────────────────────────────────────────┤
//   │ .roles-side 320px  │  .roles-main 1fr                            │
//   │  - BACK TO MAP     │  - <h2> role label  + role id               │
//   │  - ROLES title     │  - DEFAULTS section     [EDIT]              │
//   │  - role list       │  - LEAD PROMPT section  [EDIT]              │
//   │  - + NEW ROLE      │  - LEAD PREAMBLE…  / WORKER PREAMBLE…       │
//   │                    │  - CONNECTORS (Discord webhook)             │
//   │                    │  - DUPLICATE / DELETE                       │
//   └────────────────────┴─────────────────────────────────────────────┘
//
// Inline EDIT replaces the legacy `RoleDialog` for this code-path. Each section
// owns its own draft + dirty state, and only one section can be in EDIT mode at
// a time (`editingSection: SectionId | null` lifted up to `RolesPage`). When a
// section is in EDIT mode, its local buffers are frozen against the 5 s
// `useRoles` poll (cf. §3.2 of the spec).
//
// IMPORTANT — `RoleDialog.tsx` is intentionally kept. It is still used by
// `NewOrchestratorDialog`'s "+ create new role…" inline flow (Step 9). The
// follow-up "Unify role editing flows" ticket will eventually extract a shared
// `RoleForm` and let us drop `RoleDialog` (cf. spec §7.3).

import { useEffect, useMemo, useState } from 'react';
import { useRoles } from '../hooks/useRoles';
import {
  api,
  apiErrorMessage,
  isDiscordConnectorView,
  type BudgetAction,
  type ConnectorView,
  type ConnectorTypeInfo,
  type ConnectorSchema,
  type RoleView,
  type RoleInput,
  type RoleApprovalSettings,
} from '../api/client';
import {
  budgetFieldValue, budgetSummary, parseCostBudget, toBudgetAction,
} from '../lib/budget';
import { DiscordOnboarding } from './DiscordOnboarding';
import { useShellMode } from '../hooks/useShellMode';
import { useProviders } from '../hooks/useProviders';
import {
  INHERIT,
  ModelSelect,
  ProviderSelect,
  effortNote,
  effortsFor,
  findProvider,
  isPermissionChoice,
  permissionNote,
  permissionsFor,
  unavailableNote,
} from './ProviderFields';

interface Props {
  /** When `false`, the overlay is not rendered. The caller (App.tsx today,
   *  DesktopShell tomorrow) controls the mount lifecycle by toggling the
   *  `#/roles` hash route. */
  open: boolean;
  /** Called when the user clicks "← BACK TO MAP" or otherwise asks to close.
   *  The parent flips the hash back to `#/`. */
  onClose: () => void;
  /**
   * Open `#/crons` filtered on one role (the `🕐 N CRONS` badge). Passed down
   * from `App.tsx` rather than read off the controller: this page has never
   * consumed `useSwarmController`, and a context read here would make every
   * existing render site of `RolesPage` require a provider.
   */
  onOpenCrons?: (roleId: string) => void;
}

/**
 * Multi-provider Lot 3 — the local `MODELS` array is gone. Model ids, effort
 * support and permission modes now come from `GET /providers` (see
 * `ProviderFields.tsx`); a role stores `defaultProvider = null` to inherit the
 * instance default, exactly like `defaultModel`.
 */
const INHERIT_LABEL = '(inherit global default)';

type SectionId =
  | 'defaults'
  | 'leadPrompt'
  | 'leadPreamble'
  | 'workerPreamble'
  | 'connectors'
  | 'approvals'
  | 'autoCleanup'
  | 'budget';

export function RolesPage({ open, onClose, onOpenCrons }: Props) {
  const { roles, loading, error, create, update, destroy } = useRoles();
  const { isMobile } = useShellMode();
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [editingSection, setEditingSection] = useState<SectionId | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [defaults, setDefaults] = useState<{ lead: string; worker: string } | null>(null);
  // Mobile shows the list and the selected role's detail as two separate
  // full-screen panes (the desktop 320px+1fr split is unreadable on a phone).
  // `mobileView` is the navigated pane; ignored entirely on desktop.
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list');

  // Always (re)open on the list pane.
  useEffect(() => {
    if (open) setMobileView('list');
  }, [open]);

  useEffect(() => {
    if (!open || defaults !== null) return;
    let cancelled = false;
    void api
      .getPreambleDefaults()
      .then((res) => {
        if (!cancelled) setDefaults(res);
      })
      .catch(() => {
        /* placeholder falls back to a static hint */
      });
    return () => {
      cancelled = true;
    };
  }, [open, defaults]);

  // Pré-sélection + auto-fallback si le role courant a disparu sous le poll.
  useEffect(() => {
    if (selectedRoleId == null && roles.length > 0) {
      const first = roles[0];
      if (first) setSelectedRoleId(first.id);
      return;
    }
    if (selectedRoleId != null && !roles.find((r) => r.id === selectedRoleId)) {
      setSelectedRoleId(roles[0]?.id ?? null);
      setEditingSection(null);
    }
  }, [roles, selectedRoleId]);

  const role = useMemo(
    () => roles.find((r) => r.id === selectedRoleId) ?? null,
    [roles, selectedRoleId],
  );

  function tryClose() {
    if (editingSection && !confirm('Discard unsaved changes in this role?')) return;
    setEditingSection(null);
    onClose();
  }

  function trySelect(id: string) {
    if (id !== selectedRoleId) {
      if (editingSection && !confirm('Discard unsaved changes?')) return;
      setEditingSection(null);
      setSelectedRoleId(id);
    }
    // Selecting a role navigates into its detail pane on mobile — even when it
    // was already the selected one (so tapping the auto-selected first role
    // still opens it instead of being a no-op).
    if (isMobile) setMobileView('detail');
  }

  async function patchSelected(body: Partial<RoleInput>): Promise<void> {
    if (!role) return;
    setOpError(null);
    try {
      await update(role.id, body);
      setEditingSection(null);
    } catch (e) {
      // Unwrap the server's `{error, code}` body rather than showing
      // "HTTP 400 PATCH /roles/:id", which names no field.
      setOpError(apiErrorMessage(e));
      throw e;
    }
  }

  async function newRole() {
    const label = prompt('Label for the new role (lower-case, no spaces):');
    if (!label || !label.trim()) return;
    try {
      const r = await create({ label: label.trim(), connectors: [] });
      setSelectedRoleId(r.id);
      setEditingSection(null);
      if (isMobile) setMobileView('detail');
    } catch (e) {
      setOpError(e instanceof Error ? e.message : String(e));
    }
  }

  async function duplicateRole() {
    if (!role) return;
    try {
      const r = await create({
        label: `${role.label} (copy)`,
        leadPrompt: role.leadPrompt,
        leadPreamble: role.leadPreamble,
        workerPreamble: role.workerPreamble,
        workerCount: role.workerCount,
        defaultModel: role.defaultModel,
        defaultEffort: role.defaultEffort,
        defaultPermissionMode: role.defaultPermissionMode,
        defaultProvider: role.defaultProvider,
        connectors: role.connectors,
        // The role's CRONS are deliberately not copied (docs/crons-agents.md
        // §5): they carry unique names and their own history, and silently
        // duplicating a cadence would double every scheduled wake-up.
        approval: role.approval ?? null,
        autoRemoveDeadWorkers: role.autoRemoveDeadWorkers ?? false,
        autoRemoveDeadWorkersDelayMs: role.autoRemoveDeadWorkersDelayMs ?? 600000,
        // A copy of a budgeted role is budgeted too: the whole point of
        // duplicating is to get the same guard rails on a variant.
        costBudgetUsd: role.costBudgetUsd ?? null,
        budgetAction: toBudgetAction(role.budgetAction),
      });
      setSelectedRoleId(r.id);
      setEditingSection(null);
      if (isMobile) setMobileView('detail');
    } catch (e) {
      setOpError(e instanceof Error ? e.message : String(e));
    }
  }

  async function deleteRole() {
    if (!role) return;
    if (
      !confirm(
        `Delete role "${role.label}"? Existing orchestrators are not affected.`,
      )
    ) {
      return;
    }
    try {
      await destroy(role.id);
      // selectedRoleId fallback handled by the useEffect above.
      if (isMobile) setMobileView('list');
    } catch (e) {
      setOpError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!open) return null;

  return (
    <div
      className={`roles-overlay${isMobile ? ` m-roles m-roles-${mobileView}` : ''}`}
      onClick={(e) => e.stopPropagation()}
    >
      <aside className="roles-side">
        <div className="roles-side-head">
          <button className="back" onClick={tryClose}>
            ← BACK TO MAP
          </button>
          <div className="title">ROLES</div>
          <div className="sub">templates for spawning new teams</div>
        </div>

        <div className="roles-list">
          {loading && roles.length === 0 && (
            <div className="field-help" style={{ padding: '14px 20px' }}>
              loading…
            </div>
          )}
          {error && (
            <div className="field-warn" style={{ margin: 12 }}>
              {error}
            </div>
          )}
          {!loading && !error && roles.length === 0 && (
            <div className="field-help" style={{ padding: '14px 20px' }}>
              No roles yet — click "+ NEW ROLE" below.
            </div>
          )}
          {roles.map((r) => (
            <div
              key={r.id}
              className={`role-item ${selectedRoleId === r.id ? 'active' : ''}`}
              onClick={() => trySelect(r.id)}
            >
              <div className="r-name">{r.label.toUpperCase()}</div>
              <div className="r-id">{r.id}</div>
              <div className="r-tags">
                {r.workerCount != null && r.workerCount > 0 && (
                  <span className="tag-pill">{r.workerCount} WRK</span>
                )}
                {r.defaultProvider && (
                  <span className="tag-pill">{r.defaultProvider.toUpperCase()}</span>
                )}
                {r.defaultModel && (
                  <span className="tag-pill model">
                    {r.defaultModel.replace(/^claude-/, '')}
                  </span>
                )}
                {r.defaultEffort && (
                  <span className="tag-pill">E:{r.defaultEffort}</span>
                )}
                {r.connectors.find((c) => c.type === 'discord') && (
                  <span className="tag-pill discord">DISCORD</span>
                )}
                {r.leadPrompt && <span className="tag-pill">LEAD-PROMPT</span>}
                {/* Cadence lives in the `crons` entity now (docs/crons-agents.md).
                    The badge counts them from `cronCount`, which `GET /roles`
                    already carries — no second poll. `stopPropagation` is not
                    cosmetic: the badge sits inside a clickable `.role-item`,
                    so without it a click would also select the role behind. */}
                {(r.cronCount ?? 0) > 0 && (
                  onOpenCrons ? (
                    <button
                      type="button"
                      className="tag-pill"
                      style={{ background: 'none', cursor: 'pointer' }}
                      title={`Voir les ${r.cronCount} crons de ce rôle`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenCrons(r.id);
                      }}
                    >
                      🕐 {r.cronCount} CRONS
                    </button>
                  ) : (
                    <span className="tag-pill">🕐 {r.cronCount} CRONS</span>
                  )
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="roles-add">
          <button
            className="btn"
            style={{ flex: 1 }}
            onClick={() => void newRole()}
          >
            + NEW ROLE
          </button>
        </div>
      </aside>

      <main className="roles-main">
        {isMobile && (
          <button
            type="button"
            className="m-roles-back"
            onClick={() => setMobileView('list')}
          >
            ← ROLES
          </button>
        )}
        {role ? (
          <>
            <h2>{role.label.toUpperCase()}</h2>
            <div className="role-id">{role.id}</div>

            {opError && (
              <div
                className="field-warn"
                role="alert"
                style={{
                  color: 'var(--bad)',
                  borderLeftColor: 'var(--bad)',
                  background: 'rgba(224, 101, 74, 0.06)',
                  marginBottom: 20,
                }}
              >
                {opError}
              </div>
            )}

            <DefaultsSection
              role={role}
              editing={editingSection === 'defaults'}
              onEdit={() => setEditingSection('defaults')}
              onCancel={() => setEditingSection(null)}
              onSave={(body) => patchSelected(body)}
            />

            <LeadPromptSection
              role={role}
              editing={editingSection === 'leadPrompt'}
              onEdit={() => setEditingSection('leadPrompt')}
              onCancel={() => setEditingSection(null)}
              onSave={(body) => patchSelected(body)}
            />

            <PreambleSection
              kind="lead"
              role={role}
              defaultPreamble={defaults?.lead ?? null}
              editing={editingSection === 'leadPreamble'}
              onEdit={() => setEditingSection('leadPreamble')}
              onCancel={() => setEditingSection(null)}
              onSave={(body) => patchSelected(body)}
            />

            <PreambleSection
              kind="worker"
              role={role}
              defaultPreamble={defaults?.worker ?? null}
              editing={editingSection === 'workerPreamble'}
              onEdit={() => setEditingSection('workerPreamble')}
              onCancel={() => setEditingSection(null)}
              onSave={(body) => patchSelected(body)}
            />

            <ConnectorsSection
              role={role}
              editing={editingSection === 'connectors'}
              onEdit={() => setEditingSection('connectors')}
              onCancel={() => setEditingSection(null)}
              onSave={(body) => patchSelected(body)}
            />

            <ApprovalsSection
              role={role}
              editing={editingSection === 'approvals'}
              onEdit={() => setEditingSection('approvals')}
              onCancel={() => setEditingSection(null)}
              onSave={(body) => patchSelected(body)}
            />

            <AutoCleanupSection
              role={role}
              editing={editingSection === 'autoCleanup'}
              onEdit={() => setEditingSection('autoCleanup')}
              onCancel={() => setEditingSection(null)}
              onSave={(body) => patchSelected(body)}
            />

            <BudgetSection
              role={role}
              editing={editingSection === 'budget'}
              onEdit={() => setEditingSection('budget')}
              onCancel={() => setEditingSection(null)}
              onSave={(body) => patchSelected(body)}
            />

            <div style={{ display: 'flex', gap: 10, marginTop: 30 }}>
              <button className="btn" onClick={() => void duplicateRole()}>
                DUPLICATE
              </button>
              <button className="btn danger" onClick={() => void deleteRole()}>
                DELETE
              </button>
            </div>
          </>
        ) : (
          <div className="field-help">No role selected.</div>
        )}
      </main>
    </div>
  );
}

// ───────────────────────────── DEFAULTS ─────────────────────────────────────
function DefaultsSection({
  role,
  editing,
  onEdit,
  onCancel,
  onSave,
}: {
  role: RoleView;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (body: Partial<RoleInput>) => Promise<void>;
}) {
  const {
    providers,
    defaultProvider: serverDefaultProvider,
    transport,
    refresh: refreshProviders,
  } = useProviders();
  const [workerCount, setWorkerCount] = useState<string>('');
  const [provider, setProvider] = useState<string>(INHERIT);
  const [model, setModel] = useState<string>('');
  const [effort, setEffort] = useState<string>('');
  const [perm, setPerm] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // Re-init buffers when (a) the selected role changes, or (b) we toggle
  // EDIT mode (entering -> snapshot current values, exiting -> snap to
  // refreshed values from the next poll).
  useEffect(() => {
    setWorkerCount(role.workerCount != null ? String(role.workerCount) : '');
    setProvider(role.defaultProvider ?? INHERIT);
    setModel(role.defaultModel ?? '');
    setEffort(role.defaultEffort ?? '');
    setPerm(role.defaultPermissionMode ?? '');
    setError(null);
  }, [role.id, editing]);

  // Entering EDIT re-probes the catalogue: same rationale as the dialogs, a CLI
  // installed on the host after page load must be selectable without a reload.
  useEffect(() => {
    if (!editing) return;
    void refreshProviders();
  }, [editing, refreshProviders]);

  // `null` = inherit, so the controls are filtered by the provider that would
  // actually be used.
  const effectiveProvider = findProvider(providers, provider || serverDefaultProvider);
  const efforts = effortsFor(effectiveProvider);
  const perms = permissionsFor(effectiveProvider);
  const permIsChoice = isPermissionChoice(effectiveProvider);

  async function save() {
    setError(null);
    let parsed: number | null = null;
    if (workerCount.trim()) {
      const n = Number.parseInt(workerCount, 10);
      if (!Number.isInteger(n) || n < 0) {
        setError('workerCount must be a non-negative integer');
        return;
      }
      parsed = n;
    }
    try {
      await onSave({
        workerCount: parsed,
        defaultModel: model || null,
        defaultEffort: (effort || null) as RoleInput['defaultEffort'],
        defaultPermissionMode: perm || null,
        defaultProvider: provider || null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="role-section">
      <h3>
        <span>DEFAULTS</span>
        {editing ? (
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="h-edit" onClick={onCancel}>
              CANCEL
            </button>
            <button
              className="h-edit"
              onClick={() => void save()}
              style={{ color: 'var(--amber)' }}
            >
              SAVE
            </button>
          </span>
        ) : (
          <button className="h-edit" onClick={onEdit}>
            EDIT
          </button>
        )}
      </h3>

      {!editing ? (
        <div className="cfg-kv">
          <span className="k">WORKER COUNT</span>
          <span className="v">{role.workerCount ?? '— (inherit)'}</span>
          <span className="k">PROVIDER</span>
          <span className="v">{role.defaultProvider ?? '— (inherit)'}</span>
          <span className="k">MODEL</span>
          <span className="v">{role.defaultModel ?? '— (inherit)'}</span>
          <span className="k">EFFORT</span>
          <span className="v">{role.defaultEffort ?? '— (inherit)'}</span>
          <span className="k">PERMISSION</span>
          <span
            className="v"
            style={{
              color:
                role.defaultPermissionMode === 'bypassPermissions'
                  ? 'var(--warn)'
                  : 'var(--text)',
            }}
          >
            {role.defaultPermissionMode ?? '— (inherit)'}
          </span>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="field">
            <label>WORKER COUNT</label>
            <input
              type="number"
              min={0}
              value={workerCount}
              onChange={(e) => setWorkerCount(e.target.value)}
              placeholder="0"
            />
          </div>
          {/* PROVIDER before MODEL — the catalogue below belongs to it. */}
          <div className="field">
            <label>PROVIDER</label>
            <ProviderSelect
              value={provider}
              providers={providers}
              inheritLabel={INHERIT_LABEL}
              onChange={(id) => {
                setProvider(id);
                // Never leave another provider's model id in place.
                setModel('');
              }}
            />
            {unavailableNote(effectiveProvider, transport) && (
              <div className="field-warn">
                ⚠ {unavailableNote(effectiveProvider, transport)}
              </div>
            )}
          </div>
          <div className="field">
            <label>MODEL</label>
            <ModelSelect
              value={model}
              provider={effectiveProvider}
              inheritLabel={INHERIT_LABEL}
              onChange={setModel}
            />
          </div>
          <div className="field">
            <label>EFFORT</label>
            <div className="seg-radio">
              {[INHERIT, ...efforts].map((ef) => (
                <button
                  key={ef || '(inherit)'}
                  type="button"
                  className={effort === ef ? 'on' : ''}
                  disabled={efforts.length === 0}
                  onClick={() => setEffort(ef)}
                >
                  {ef || 'inherit'}
                </button>
              ))}
            </div>
            {effortNote(effectiveProvider) && (
              <div className="field-help">{effortNote(effectiveProvider)}</div>
            )}
          </div>
          <div className="field">
            <label>PERMISSION</label>
            <select
              value={perm}
              disabled={!permIsChoice}
              onChange={(e) => setPerm(e.target.value)}
            >
              {[INHERIT, ...perms].map((p) => (
                <option key={p || '(inherit)'} value={p}>
                  {p || '(inherit)'}
                </option>
              ))}
            </select>
            {permissionNote(effectiveProvider) && (
              <div className="field-help">{permissionNote(effectiveProvider)}</div>
            )}
            {perm === 'bypassPermissions' && (
              <div className="field-warn">
                ⚠ bypassPermissions :: agents in teams using this role will skip
                ALL permission prompts.
              </div>
            )}
          </div>
          {error && (
            <div
              className="field-warn"
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
      )}
    </div>
  );
}

// ───────────────────────────── LEAD PROMPT ──────────────────────────────────
function LeadPromptSection({
  role,
  editing,
  onEdit,
  onCancel,
  onSave,
}: {
  role: RoleView;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (body: Partial<RoleInput>) => Promise<void>;
}) {
  const [draft, setDraft] = useState(role.leadPrompt ?? '');
  const [error, setError] = useState<string | null>(null);
  const [improving, setImproving] = useState(false);

  useEffect(() => {
    setDraft(role.leadPrompt ?? '');
    setError(null);
  }, [role.id, editing]);

  async function save() {
    setError(null);
    try {
      await onSave({ leadPrompt: draft.trim() ? draft : null });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function improve() {
    if (improving) return;
    setError(null);
    setImproving(true);
    try {
      const { text } = await api.improveText({ field: 'leadPrompt', text: draft });
      setDraft(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImproving(false);
    }
  }

  return (
    <div className="role-section">
      <h3>
        <span>LEAD PROMPT</span>
        {editing ? (
          <span style={{ display: 'flex', gap: 6 }}>
            <button
              className="h-edit"
              onClick={() => void improve()}
              disabled={improving}
              title="Améliorer avec Claude"
            >
              {improving ? '… AMÉLIORATION' : '✨ AMÉLIORER'}
            </button>
            <button className="h-edit" onClick={onCancel} disabled={improving}>
              CANCEL
            </button>
            <button
              className="h-edit"
              onClick={() => void save()}
              disabled={improving}
              style={{ color: 'var(--amber)' }}
            >
              SAVE
            </button>
          </span>
        ) : (
          <button className="h-edit" onClick={onEdit}>
            EDIT
          </button>
        )}
      </h3>

      {!editing ? (
        <div className="cfg-pre">{role.leadPrompt || '— (none) —'}</div>
      ) : (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="What the lead should focus on by default."
            style={{ width: '100%', minHeight: 140, resize: 'vertical' }}
          />
          {error && (
            <div
              className="field-warn"
              style={{ color: 'var(--bad)', borderLeftColor: 'var(--bad)' }}
            >
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─────────────────────── LEAD / WORKER PREAMBLE ─────────────────────────────
function PreambleSection({
  kind,
  role,
  defaultPreamble,
  editing,
  onEdit,
  onCancel,
  onSave,
}: {
  kind: 'lead' | 'worker';
  role: RoleView;
  defaultPreamble: string | null;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (body: Partial<RoleInput>) => Promise<void>;
}) {
  const current = kind === 'lead' ? role.leadPreamble : role.workerPreamble;
  const title = kind === 'lead' ? 'LEAD PREAMBLE' : 'WORKER PREAMBLE';
  const field = kind === 'lead' ? 'leadPreamble' : 'workerPreamble';
  const [draft, setDraft] = useState(current ?? '');
  const [error, setError] = useState<string | null>(null);
  const [improving, setImproving] = useState(false);

  useEffect(() => {
    setDraft(current ?? '');
    setError(null);
  }, [role.id, current, editing]);

  async function save() {
    setError(null);
    const value = draft.trim() ? draft : null;
    const body: Partial<RoleInput> =
      kind === 'lead' ? { leadPreamble: value } : { workerPreamble: value };
    try {
      await onSave(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function improve() {
    if (improving) return;
    setError(null);
    setImproving(true);
    try {
      const { text } = await api.improveText({ field, text: draft });
      setDraft(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImproving(false);
    }
  }

  return (
    <div className="role-section">
      <h3>
        <span>{title}</span>
        {editing ? (
          <span style={{ display: 'flex', gap: 6 }}>
            <button
              className="h-edit"
              onClick={() => void improve()}
              disabled={improving}
              title="Améliorer avec Claude"
            >
              {improving ? '… AMÉLIORATION' : '✨ AMÉLIORER'}
            </button>
            <button className="h-edit" onClick={onCancel} disabled={improving}>
              CANCEL
            </button>
            <button
              className="h-edit"
              onClick={() => void save()}
              disabled={improving}
              style={{ color: 'var(--amber)' }}
            >
              SAVE
            </button>
          </span>
        ) : (
          <button className="h-edit" onClick={onEdit}>
            EDIT
          </button>
        )}
      </h3>

      {!editing ? (
        <div className="cfg-pre">{current || '— (none) —'}</div>
      ) : (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              defaultPreamble ??
              (kind === 'lead'
                ? 'Chargement du preamble par défaut…'
                : 'Chargement du preamble par défaut…')
            }
            style={{ width: '100%', minHeight: 140, resize: 'vertical' }}
          />
          {error && (
            <div
              className="field-warn"
              style={{ color: 'var(--bad)', borderLeftColor: 'var(--bad)' }}
            >
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ───────────────────────────── APPROVALS ────────────────────────────────────
/**
 * Per-role override of the human-in-the-loop approval gate (P5). Every control
 * defaults to the built-in behaviour, and a role that changes nothing here
 * persists `approval: null` (strict retro-compat — it behaves exactly as before
 * this section existed). Three independent levers:
 *   - guard on/off for the role (`enabled`),
 *   - which permission modes ARM the guard (`armingModes`; unset = default),
 *   - whether the Discord approval embed is posted (`discordNotify`).
 */
const APPROVAL_MODES = [
  'default',
  'plan',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
] as const;

function approvalSummary(a: RoleApprovalSettings | null | undefined): string {
  if (!a) return '— (défaut : arme selon le mode qui prompte, Discord activé) —';
  const parts: string[] = [];
  if (a.enabled === false) {
    parts.push('🚫 garde-fou DÉSACTIVÉ pour ce rôle');
  } else if (Array.isArray(a.armingModes)) {
    parts.push(
      a.armingModes.length ? `arme sur : ${a.armingModes.join(', ')}` : 'arme sur : aucun mode',
    );
  } else {
    parts.push('arme sur : modes par défaut');
  }
  parts.push(a.discordNotify === false ? 'Discord : off' : 'Discord : on');
  return parts.join('  ·  ');
}

function ApprovalsSection({
  role,
  editing,
  onEdit,
  onCancel,
  onSave,
}: {
  role: RoleView;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (body: Partial<RoleInput>) => Promise<void>;
}) {
  const [guardEnabled, setGuardEnabled] = useState(true);
  const [customModes, setCustomModes] = useState(false);
  const [modes, setModes] = useState<string[]>([]);
  const [discordNotify, setDiscordNotify] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const a = role.approval ?? null;
    setGuardEnabled(a?.enabled !== false);
    setCustomModes(Array.isArray(a?.armingModes));
    setModes(Array.isArray(a?.armingModes) ? [...a!.armingModes!] : []);
    setDiscordNotify(a?.discordNotify !== false);
    setError(null);
  }, [role.id, editing]);

  function toggleMode(m: string) {
    setModes((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));
  }

  async function save() {
    setError(null);
    // Build the minimal override: only carry a field when it DIFFERS from the
    // default, so "changed nothing" collapses to `null` (no override).
    const appr: RoleApprovalSettings = {};
    if (!guardEnabled) appr.enabled = false;
    if (customModes) appr.armingModes = [...modes];
    if (!discordNotify) appr.discordNotify = false;
    const value = Object.keys(appr).length ? appr : null;
    try {
      await onSave({ approval: value });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="role-section">
      <h3>
        <span>APPROBATIONS</span>
        {editing ? (
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="h-edit" onClick={onCancel}>
              CANCEL
            </button>
            <button className="h-edit" onClick={() => void save()} style={{ color: 'var(--amber)' }}>
              SAVE
            </button>
          </span>
        ) : (
          <button className="h-edit" onClick={onEdit}>
            EDIT
          </button>
        )}
      </h3>

      {!editing ? (
        <div className="cfg-pre">{approvalSummary(role.approval)}</div>
      ) : (
        <>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={guardEnabled}
              onChange={(e) => setGuardEnabled(e.target.checked)}
            />
            <span>Garde-fou d’approbation activé pour ce rôle</span>
          </label>

          <label
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              marginBottom: 6,
              opacity: guardEnabled ? 1 : 0.5,
            }}
          >
            <input
              type="checkbox"
              checked={customModes}
              disabled={!guardEnabled}
              onChange={(e) => setCustomModes(e.target.checked)}
            />
            <span>Personnaliser les modes qui arment le garde-fou</span>
          </label>
          {guardEnabled && customModes && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, margin: '4px 0 10px 24px' }}>
              {APPROVAL_MODES.map((m) => (
                <label key={m} style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={modes.includes(m)}
                    onChange={() => toggleMode(m)}
                  />
                  <span className="tag-pill">{m}</span>
                </label>
              ))}
            </div>
          )}
          {guardEnabled && !customModes && (
            <div className="field-help" style={{ margin: '0 0 10px 24px' }}>
              Défaut : arme pour les modes qui sollicitent l’humain (claude
              default / plan / acceptEdits).
            </div>
          )}

          <label
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              marginBottom: 8,
              opacity: guardEnabled ? 1 : 0.5,
            }}
          >
            <input
              type="checkbox"
              checked={discordNotify}
              disabled={!guardEnabled}
              onChange={(e) => setDiscordNotify(e.target.checked)}
            />
            <span>Notifier l’approbation sur Discord (embed / message du bot)</span>
          </label>

          <div className="field-help">
            Absent de réglage → comportement par défaut inchangé. Une approbation
            expirée par le janitor TTL n’est jamais un refus (elle reste un simple
            nettoyage).
          </div>
          {error && (
            <div
              className="field-warn"
              style={{ color: 'var(--bad)', borderLeftColor: 'var(--bad)' }}
            >
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─────────────────────── RETRAIT AUTO WORKERS MORTS ─────────────────────────
/**
 * Per-role dead-worker reaper toggle. When enabled, the server soft-removes
 * terminal workers (killed/exited/failed) of this role's teams once they have
 * been terminal longer than the delay — so killed workers stop piling up in the
 * visual. OFF by default (strict retro-compat). Never affects leads or
 * non-terminal sessions. The delay is edited in minutes; stored in ms.
 */
function autoCleanupSummary(
  enabled: boolean | undefined,
  delayMs: number | undefined,
): string {
  if (!enabled) return '— (désactivé : les workers morts restent affichés) —';
  const min = Math.round((delayMs ?? 600000) / 60000);
  return `Actif · retrait ${min} min après la fin du worker`;
}

function AutoCleanupSection({
  role,
  editing,
  onEdit,
  onCancel,
  onSave,
}: {
  role: RoleView;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (body: Partial<RoleInput>) => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(false);
  const [delayMin, setDelayMin] = useState('10');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(role.autoRemoveDeadWorkers ?? false);
    setDelayMin(String(Math.round((role.autoRemoveDeadWorkersDelayMs ?? 600000) / 60000)));
    setError(null);
  }, [role.id, editing]);

  async function save() {
    setError(null);
    // Only validate the delay when the feature is on; a disabled role can carry
    // any (unused) delay without blocking the save.
    let delayMs = role.autoRemoveDeadWorkersDelayMs ?? 600000;
    if (enabled) {
      const n = Number.parseInt(delayMin, 10);
      if (!Number.isInteger(n) || n < 0) {
        setError('Le délai doit être un entier de minutes ≥ 0.');
        return;
      }
      delayMs = n * 60000;
    }
    try {
      await onSave({ autoRemoveDeadWorkers: enabled, autoRemoveDeadWorkersDelayMs: delayMs });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="role-section">
      <h3>
        <span>RETRAIT AUTO WORKERS MORTS</span>
        {editing ? (
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="h-edit" onClick={onCancel}>
              CANCEL
            </button>
            <button className="h-edit" onClick={() => void save()} style={{ color: 'var(--amber)' }}>
              SAVE
            </button>
          </span>
        ) : (
          <button className="h-edit" onClick={onEdit}>
            EDIT
          </button>
        )}
      </h3>

      {!editing ? (
        <div className="cfg-pre">
          {autoCleanupSummary(role.autoRemoveDeadWorkers, role.autoRemoveDeadWorkersDelayMs)}
        </div>
      ) : (
        <>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <span>Retirer automatiquement les workers morts</span>
          </label>

          <div className="field" style={{ opacity: enabled ? 1 : 0.5, maxWidth: 220 }}>
            <label>DÉLAI (MIN)</label>
            <input
              type="number"
              min={0}
              value={delayMin}
              disabled={!enabled}
              onChange={(e) => setDelayMin(e.target.value)}
              placeholder="10"
            />
          </div>

          <div className="field-help" style={{ marginTop: 8 }}>
            Un worker terminé (killed / exited / failed) est retiré de l’affichage (soft-delete,
            comme le bouton « REMOVE ») une fois ce délai écoulé depuis sa fin. Les leads et les
            sessions actives ne sont jamais touchés. Désactivé par défaut.
          </div>
          {error && (
            <div
              className="field-warn"
              style={{ color: 'var(--bad)', borderLeftColor: 'var(--bad)' }}
            >
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ──────────────────────────── COST BUDGET ───────────────────────────────────
/**
 * Per-role cost budget (docs/monitoring-agents.md, Lot 14) — structurally the
 * same section as `AutoCleanupSection` above, for the same kind of setting: a
 * guard rail the server enforces on its own, on every team of this role, with
 * no operator in the loop.
 *
 * The budget is cumulative and per TEAM, removed workers included — it is
 * checked against the DB aggregate of Lot 12, not against the agents that
 * happen to still be on screen. Empty = no budget (the default), which is
 * deliberately distinct from zero.
 */
function BudgetSection({
  role,
  editing,
  onEdit,
  onCancel,
  onSave,
}: {
  role: RoleView;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (body: Partial<RoleInput>) => Promise<void>;
}) {
  const [amount, setAmount] = useState('');
  const [action, setAction] = useState<BudgetAction>('notify');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAmount(budgetFieldValue(role.costBudgetUsd));
    setAction(toBudgetAction(role.budgetAction));
    setError(null);
  }, [role.id, editing]);

  async function save() {
    setError(null);
    const parsed = parseCostBudget(amount);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    try {
      // `action` goes with every save, budget or not: it is what the NEXT
      // budget will do, and dropping it would silently reset a role to
      // `notify` the first time its ceiling is cleared and re-set.
      await onSave({ costBudgetUsd: parsed.value, budgetAction: action });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="role-section">
      <h3>
        <span>COST BUDGET</span>
        {editing ? (
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="h-edit" onClick={onCancel}>
              CANCEL
            </button>
            <button className="h-edit" onClick={() => void save()} style={{ color: 'var(--amber)' }}>
              SAVE
            </button>
          </span>
        ) : (
          <button className="h-edit" onClick={onEdit}>
            EDIT
          </button>
        )}
      </h3>

      {!editing ? (
        <div className="cfg-pre">{budgetSummary(role.costBudgetUsd, role.budgetAction)}</div>
      ) : (
        <>
          <div className="field" style={{ maxWidth: 220 }}>
            <label>COST BUDGET (USD)</label>
            <input
              type="number"
              min={0}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="50"
            />
          </div>
          <div className="field-help" style={{ marginTop: 8 }}>
            Cumulé par TEAM de ce rôle, workers retirés inclus. Vide = pas de budget.
          </div>

          <div className="field" style={{ marginTop: 12, maxWidth: 320 }}>
            <label>ON BUDGET EXCEEDED</label>
            <div className="seg-radio" role="radiogroup" aria-label="on budget exceeded">
              {ROLE_BUDGET_ACTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={action === opt.value}
                  className={action === opt.value ? 'on' : ''}
                  onClick={() => setAction(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div className="field-help" style={{ marginTop: 8 }}>
            NOTIFY : toast + Discord (si webhook). PAUSE TEAM : SIGSTOP de toute l’équipe,
            reprise manuelle.
          </div>
          {error && (
            <div
              className="field-warn"
              style={{ color: 'var(--bad)', borderLeftColor: 'var(--bad)' }}
            >
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Same two options as the RoleDialog's, in the same escalating order. */
const ROLE_BUDGET_ACTIONS: ReadonlyArray<{ value: BudgetAction; label: string }> = [
  { value: 'notify', label: 'NOTIFY' },
  { value: 'pause', label: 'PAUSE TEAM' },
];

// ───────────────────────────── CONNECTORS ───────────────────────────────────
/** Is a value present (non-empty)? Shared by the generic connector form. */
function connNonEmpty(v: unknown): boolean {
  return v !== undefined && v !== null && String(v).trim() !== '';
}

/**
 * Generic connector form — renders inputs from a connector type's declared
 * schema (J4). Password fields pre-fill with the server's sentinel (`•••`) when
 * a value is stored; leaving them untouched preserves the secret server-side.
 */
function GenericConnectorFields({
  schema,
  value,
  onChange,
}: {
  schema: ConnectorSchema;
  value: Record<string, unknown>;
  onChange: (key: string, v: unknown) => void;
}) {
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {Object.entries(schema.properties).map(([key, prop]) => {
        const label = prop.title ?? key;
        const required = schema.required?.includes(key) ?? false;
        const cur = value[key];
        if (prop.type === 'boolean') {
          return (
            <label key={key} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={Boolean(cur)}
                onChange={(e) => onChange(key, e.target.checked)}
              />
              <span className="k">{label}</span>
            </label>
          );
        }
        if (prop.enum && prop.enum.length > 0) {
          return (
            <label key={key} style={{ display: 'grid', gap: 4 }}>
              <span className="k">
                {label}
                {required ? ' *' : ''}
              </span>
              <select
                value={String(cur ?? '')}
                onChange={(e) => onChange(key, e.target.value)}
              >
                <option value="">(unset)</option>
                {prop.enum.map((o) => (
                  <option key={String(o)} value={String(o)}>
                    {String(o)}
                  </option>
                ))}
              </select>
            </label>
          );
        }
        const inputType =
          prop.format === 'password' ? 'password' : prop.type === 'number' ? 'number' : 'text';
        return (
          <label key={key} style={{ display: 'grid', gap: 4 }}>
            <span className="k">
              {label}
              {required ? ' *' : ''}
            </span>
            <input
              type={inputType}
              value={String(cur ?? '')}
              placeholder={prop.description ?? ''}
              onChange={(e) =>
                onChange(key, prop.type === 'number' ? e.target.value : e.target.value)
              }
            />
            {prop.description && <span className="field-help">{prop.description}</span>}
          </label>
        );
      })}
    </div>
  );
}

function ConnectorsSection({
  role,
  editing,
  onEdit,
  onCancel,
  onSave,
}: {
  role: RoleView;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (body: Partial<RoleInput>) => Promise<void>;
}) {
  const discord = role.connectors.find(isDiscordConnectorView);
  const genericConnectors = role.connectors.filter(
    (c): c is Extract<ConnectorView, { config: Record<string, unknown> }> =>
      !isDiscordConnectorView(c),
  );
  const [url, setUrl] = useState(discord?.webhookUrl ?? '');
  const [channelId, setChannelId] = useState(discord?.channelId ?? '');
  const [botToken, setBotToken] = useState(discord?.botToken ?? '');
  const [error, setError] = useState<string | null>(null);
  // J4 — available connector types (built-in discord + plugin-provided).
  const [types, setTypes] = useState<ConnectorTypeInfo[]>([]);
  // Working config per non-discord connector type (keyed by type).
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({});

  useEffect(() => {
    let live = true;
    api
      .listConnectorTypes()
      .then((r) => {
        if (live) setTypes(r.connectorTypes);
      })
      .catch(() => {
        /* connector types unavailable — only built-in discord editable */
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    setUrl(discord?.webhookUrl ?? '');
    setChannelId(discord?.channelId ?? '');
    setBotToken(discord?.botToken ?? '');
    const d: Record<string, Record<string, unknown>> = {};
    for (const c of genericConnectors) d[c.type] = { ...c.config };
    setDrafts(d);
    setError(null);
    // role.connectors is intentionally excluded from deps — we reset the draft
    // on role change / entering edit, not on every poll refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role.id, editing]);

  const pluginTypes = types.filter((t) => t.type !== 'discord' && t.schema);

  function buildGenericConnectors(): ConnectorView[] {
    const out: ConnectorView[] = [];
    for (const t of pluginTypes) {
      const schema = t.schema;
      if (!schema) continue;
      const draft = drafts[t.type] ?? {};
      const required = schema.required ?? [];
      const configured =
        required.length > 0
          ? required.every((k) => connNonEmpty(draft[k]))
          : Object.keys(schema.properties).some((k) => connNonEmpty(draft[k]));
      if (!configured) continue;
      const config: Record<string, unknown> = {};
      for (const [k, prop] of Object.entries(schema.properties)) {
        const v = draft[k];
        if (prop.type === 'boolean') {
          if (v !== undefined) config[k] = Boolean(v);
          continue;
        }
        if (connNonEmpty(v)) config[k] = prop.type === 'number' ? Number(v) : v;
      }
      out.push({ type: t.type, config });
    }
    return out;
  }

  async function save() {
    setError(null);
    const u = url.trim();
    const cid = channelId.trim();
    const tok = botToken.trim();
    if (u && !/^https?:\/\//i.test(u)) {
      setError('Webhook URL must start with http:// or https://');
      return;
    }
    if (cid && !/^\d{17,20}$/.test(cid)) {
      setError('Channel ID must be 17–20 digits (a Discord snowflake)');
      return;
    }
    if (tok && !cid) {
      setError('Set a channel ID alongside the bot token (the bot needs a channel to listen on)');
      return;
    }
    if (u === '' || (tok && cid) || (!tok && !cid)) {
      // valid discord shapes: webhook-only, bot+channel, both, or none
    } else {
      setError('Set a webhook URL, or a bot token + channel ID (or both)');
      return;
    }
    const hasDiscord = !!u || !!(tok && cid);
    const discordConnector: ConnectorView[] = hasDiscord
      ? [
          {
            type: 'discord',
            ...(u ? { webhookUrl: u } : {}),
            ...(cid ? { channelId: cid } : {}),
            ...(tok ? { botToken: tok } : {}),
          },
        ]
      : [];
    const connectors: ConnectorView[] = [...discordConnector, ...buildGenericConnectors()];
    try {
      await onSave({ connectors });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function removeDiscord() {
    if (!confirm('Remove Discord connector from this role?')) return;
    setError(null);
    try {
      // Keep any plugin connectors; only drop discord.
      await onSave({ connectors: genericConnectors });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const labelFor = (type: string): string =>
    types.find((t) => t.type === type)?.label ?? type;

  return (
    <div className="role-section">
      <h3>
        <span>CONNECTORS</span>
        {editing ? (
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="h-edit" onClick={onCancel}>
              CANCEL
            </button>
            <button
              className="h-edit"
              onClick={() => void save()}
              style={{ color: 'var(--amber)' }}
            >
              SAVE
            </button>
          </span>
        ) : (
          <button className="h-edit" onClick={onEdit}>
            EDIT
          </button>
        )}
      </h3>

      {!editing ? (
        discord || genericConnectors.length > 0 ? (
          <>
            {discord?.webhookUrl && (
              <div className="cfg-kv">
                <span className="k">DISCORD</span>
                <span
                  className="v"
                  style={{
                    fontSize: 10.5,
                    color: 'var(--text-dim)',
                    wordBreak: 'break-all',
                  }}
                >
                  {discord.webhookUrl}
                </span>
              </div>
            )}
            {discord?.channelId && (
              <div className="cfg-kv">
                <span className="k">CHANNEL ID</span>
                <span className="v" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
                  {discord.channelId}
                </span>
              </div>
            )}
            {discord?.botToken && (
              <div className="cfg-kv">
                <span className="k">BOT TOKEN</span>
                <span className="v" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
                  configured
                </span>
              </div>
            )}
            {genericConnectors.map((c) => (
              <div className="cfg-kv" key={c.type}>
                <span className="k">{labelFor(c.type).toUpperCase()}</span>
                <span className="v" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
                  {Object.keys(c.config).length > 0 ? 'configured' : 'no config'}
                </span>
              </div>
            ))}
          </>
        ) : (
          <div className="field-help">
            No connectors. Configure Discord (webhook and/or bot), or a
            plugin-provided channel connector below.
          </div>
        )
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          <div style={{ display: 'grid', gap: 12 }}>
            <DiscordOnboarding
              webhookUrl={url}
              setWebhookUrl={setUrl}
              channelId={channelId}
              setChannelId={setChannelId}
              botToken={botToken}
              setBotToken={setBotToken}
            />
            {discord && (
              <button
                className="btn danger"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => void removeDiscord()}
              >
                REMOVE DISCORD
              </button>
            )}
          </div>

          {pluginTypes.map((t) => (
            <div key={t.type} style={{ display: 'grid', gap: 8 }}>
              <h4 style={{ margin: 0, fontSize: 12, letterSpacing: 0.5 }}>
                {t.label.toUpperCase()}
              </h4>
              <GenericConnectorFields
                schema={t.schema as ConnectorSchema}
                value={drafts[t.type] ?? {}}
                onChange={(key, v) =>
                  setDrafts((prev) => ({
                    ...prev,
                    [t.type]: { ...(prev[t.type] ?? {}), [key]: v },
                  }))
                }
              />
            </div>
          ))}

          {error && (
            <div
              className="field-warn"
              style={{ color: 'var(--bad)', borderLeftColor: 'var(--bad)' }}
            >
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

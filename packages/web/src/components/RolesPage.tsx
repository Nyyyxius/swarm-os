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
import type { ConnectorView, RoleView, RoleInput } from '../api/client';

interface Props {
  /** When `false`, the overlay is not rendered. The caller (App.tsx today,
   *  DesktopShell tomorrow) controls the mount lifecycle by toggling the
   *  `#/roles` hash route. */
  open: boolean;
  /** Called when the user clicks "← BACK TO MAP" or otherwise asks to close.
   *  The parent flips the hash back to `#/`. */
  onClose: () => void;
}

const MODELS = [
  { value: '', label: '(inherit global default)' },
  { value: 'claude-opus-4-7', label: 'opus-4-7' },
  { value: 'claude-sonnet-4-6', label: 'sonnet-4-6' },
  { value: 'claude-haiku-4-5-20251001', label: 'haiku-4-5' },
] as const;

const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

const PERMS = [
  '',
  'auto',
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
] as const;

type SectionId =
  | 'defaults'
  | 'leadPrompt'
  | 'leadPreamble'
  | 'workerPreamble'
  | 'connectors';

export function RolesPage({ open, onClose }: Props) {
  const { roles, loading, error, create, update, destroy } = useRoles();
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [editingSection, setEditingSection] = useState<SectionId | null>(null);
  const [opError, setOpError] = useState<string | null>(null);

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
    if (id === selectedRoleId) return;
    if (editingSection && !confirm('Discard unsaved changes?')) return;
    setEditingSection(null);
    setSelectedRoleId(id);
  }

  async function patchSelected(body: Partial<RoleInput>): Promise<void> {
    if (!role) return;
    setOpError(null);
    try {
      await update(role.id, body);
      setEditingSection(null);
    } catch (e) {
      setOpError(e instanceof Error ? e.message : String(e));
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
        connectors: role.connectors,
      });
      setSelectedRoleId(r.id);
      setEditingSection(null);
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
    } catch (e) {
      setOpError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!open) return null;

  return (
    <div className="roles-overlay" onClick={(e) => e.stopPropagation()}>
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
              editing={editingSection === 'leadPreamble'}
              onEdit={() => setEditingSection('leadPreamble')}
              onCancel={() => setEditingSection(null)}
              onSave={(body) => patchSelected(body)}
            />

            <PreambleSection
              kind="worker"
              role={role}
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
  const [workerCount, setWorkerCount] = useState<string>('');
  const [model, setModel] = useState<string>('');
  const [effort, setEffort] = useState<string>('');
  const [perm, setPerm] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // Re-init buffers when (a) the selected role changes, or (b) we toggle
  // EDIT mode (entering -> snapshot current values, exiting -> snap to
  // refreshed values from the next poll).
  useEffect(() => {
    setWorkerCount(role.workerCount != null ? String(role.workerCount) : '');
    setModel(role.defaultModel ?? '');
    setEffort(role.defaultEffort ?? '');
    setPerm(role.defaultPermissionMode ?? '');
    setError(null);
  }, [role.id, editing]);

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
          <div className="field">
            <label>MODEL</label>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>EFFORT</label>
            <div className="seg-radio">
              {EFFORTS.map((ef) => (
                <button
                  key={ef || '(inherit)'}
                  type="button"
                  className={effort === ef ? 'on' : ''}
                  onClick={() => setEffort(ef)}
                >
                  {ef || 'inherit'}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>PERMISSION</label>
            <select value={perm} onChange={(e) => setPerm(e.target.value)}>
              {PERMS.map((p) => (
                <option key={p || '(inherit)'} value={p}>
                  {p || '(inherit)'}
                </option>
              ))}
            </select>
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

  return (
    <div className="role-section">
      <h3>
        <span>LEAD PROMPT</span>
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
        <div className="cfg-pre">{role.leadPrompt || '— (none) —'}</div>
      ) : (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="What the lead should focus on by default."
            style={{ width: '100%', minHeight: 140 }}
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
  editing,
  onEdit,
  onCancel,
  onSave,
}: {
  kind: 'lead' | 'worker';
  role: RoleView;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (body: Partial<RoleInput>) => Promise<void>;
}) {
  const current = kind === 'lead' ? role.leadPreamble : role.workerPreamble;
  const title = kind === 'lead' ? 'LEAD PREAMBLE' : 'WORKER PREAMBLE';
  const [draft, setDraft] = useState(current ?? '');
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="role-section">
      <h3>
        <span>{title}</span>
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
        <div className="cfg-pre">{current || '— (none) —'}</div>
      ) : (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              kind === 'lead'
                ? 'System preamble injected before the lead prompt. Inherited at team creation unless overridden.'
                : 'System preamble for workers spawned in teams using this role. Overridable per worker via team.spawn_worker(preamble=…).'
            }
            style={{ width: '100%', minHeight: 140 }}
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

// ───────────────────────────── CONNECTORS ───────────────────────────────────
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
  const discord = role.connectors.find((c) => c.type === 'discord');
  const [url, setUrl] = useState(discord?.webhookUrl ?? '');
  const [channelId, setChannelId] = useState(discord?.channelId ?? '');
  const [botToken, setBotToken] = useState(discord?.botToken ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUrl(discord?.webhookUrl ?? '');
    setChannelId(discord?.channelId ?? '');
    setBotToken(discord?.botToken ?? '');
    setError(null);
  }, [role.id, discord?.webhookUrl, discord?.channelId, discord?.botToken, editing]);

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
    if (!u && (cid || tok)) {
      setError('Set a webhook URL before adding a channel ID or bot token');
      return;
    }
    const connectors: ConnectorView[] = u
      ? [{
          type: 'discord',
          webhookUrl: u,
          ...(cid ? { channelId: cid } : {}),
          ...(tok ? { botToken: tok } : {}),
        }]
      : [];
    try {
      await onSave({ connectors });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove() {
    if (!confirm('Remove Discord webhook from this role?')) return;
    setError(null);
    try {
      await onSave({ connectors: [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

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
        discord ? (
          <>
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
            {discord.channelId && (
              <div className="cfg-kv">
                <span className="k">CHANNEL ID</span>
                <span
                  className="v"
                  style={{ fontSize: 10.5, color: 'var(--text-dim)' }}
                >
                  {discord.channelId}
                </span>
              </div>
            )}
            {discord.botToken && (
              <div className="cfg-kv">
                <span className="k">BOT TOKEN</span>
                <span
                  className="v"
                  style={{ fontSize: 10.5, color: 'var(--text-dim)' }}
                >
                  configured
                </span>
              </div>
            )}
          </>
        ) : (
          <div className="field-help">
            No Discord webhook. Configure to relay session-waiting events to a
            channel.
          </div>
        )
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="field">
            <label>DISCORD WEBHOOK URL</label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://discord.com/api/webhooks/…"
            />
            <div className="field-help">
              When set, orchestrators created with this role route their
              notifications to this webhook instead of the global one. Leave
              empty to remove.
            </div>
          </div>
          <div className="field">
            <label>DISCORD CHANNEL ID (optional)</label>
            <input
              type="text"
              inputMode="numeric"
              pattern="\d{17,20}"
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
              placeholder="1234567890123456789"
            />
            <div className="field-help">
              When set AND a bot token is configured below, the role's bot
              subscribes to this channel: every human message lands in the
              lead's inbox, and the lead can write back via the{' '}
              <code>discord.send_message</code> tool. Enable Developer Mode in
              Discord, right-click the channel → Copy Channel ID.
            </div>
          </div>
          <div className="field">
            <label>DISCORD BOT TOKEN (optional)</label>
            <input
              type="password"
              autoComplete="off"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="MTAxxxxxxxxxxxxxxxxx.xxxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            />
            <div className="field-help">
              Bot OAuth token from the Discord Developer Portal. Each role can
              have its own bot user (e.g. Marketing-Bot, Support-Bot). Leave
              empty to disable bidirectional Discord for this role.
            </div>
          </div>
          {discord && (
            <button
              className="btn danger"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => void remove()}
            >
              REMOVE WEBHOOK
            </button>
          )}
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

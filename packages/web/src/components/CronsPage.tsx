// Agent crons — the dedicated `#/crons` screen (docs/crons-agents.md §2.4).
//
// Skeleton copied from `RolesPage` (`roles-overlay` / `roles-side` /
// `roles-main`), the way `SkillsPage` and `PluginsPage` already do:
//
//   ┌────────────────────┬─────────────────────────────────────────────┐
//   │ .roles-side 320px  │  .roles-main 1fr                            │
//   │  - BACK TO MAP     │  - <h2> cron name  + id / target role       │
//   │  - CRONS title     │  - RUN NOW · PAUSE (header actions)         │
//   │  - role filter     │  - SCHEDULE section   [EDIT]                │
//   │  - cron list       │  - ACTION section     [EDIT]                │
//   │  - + NEW CRON      │  - LAST RUNS section                        │
//   │                    │  - DELETE (alone, at the bottom)            │
//   └────────────────────┴─────────────────────────────────────────────┘
//
// Three things here are deliberate and easy to undo by accident:
//
//  - `nextRun` is DISPLAYED, never computed. The server reads it off the armed
//    croner job so it lands in `SWARM_OS_SCHEDULE_TZ`; recomputing it in the
//    browser would silently answer in the viewer's timezone. The local `croner`
//    dependency is used ONLY to validate an expression before POSTing it and to
//    preview a brand-new cadence — both clearly labelled as browser-local.
//  - creation goes through a MODAL, unlike ROLES (which POSTs a blank item then
//    edits it inline): a cron has three NOT NULL columns at birth, so there is
//    no such thing as a blank one.
//  - mutations are not optimistic (`useCrons` awaits a refresh): after a PAUSE
//    the list shows what the server stored and what the re-armed scheduler
//    recomputed, not what we hoped it would.
//
// Language convention: structural labels in ALL CAPS mono, operator-facing
// prose (errors, help) in French.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Cron } from 'croner';
import { useCrons } from '../hooks/useCrons';
import { useShellMode } from '../hooks/useShellMode';
import { useSwarmController } from '../controller/SwarmController';
import { formatCronWhen } from '../lib/format';
import ConfirmModal from './desktop/ConfirmModal';
import {
  api,
  apiErrorMessage,
  CRON_INTERPRETERS,
  HttpError,
  type CronInput,
  type CronRunView,
  type CronView,
  type RoleView,
} from '../api/client';

interface Props {
  /** When `false` nothing renders AND `useCrons` issues no request. */
  open: boolean;
  /** Selected cron, carried by the route (`#/crons/<cronId>` deep link). */
  cronId: string | null;
  /**
   * Show only the crons of this role. Comes from `onOpenCrons(roleId)` (the
   * `🕐 N CRONS` badge of RolesPage), NOT from the URL: the hash router
   * compares by strict equality and would rewrite `#/crons?role=x` to `#/`.
   */
  roleFilter?: string | null;
  onClearRoleFilter?: () => void;
  /** Push a selection into the route, so the detail pane is deep-linkable. */
  onSelectCron?: (id: string | null) => void;
  onClose: () => void;
}

type SectionId = 'schedule' | 'action';

/** Mirror of the server's `CRON_NAME_RE` (`modules/crons/store.ts`). */
const CRON_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const NAME_HELP =
  'Slug de 1 à 64 caractères : lettres, chiffres, point, tiret, tiret bas. '
  + "Il sert aussi d'expéditeur des messages (`cron:<nom>`), il doit donc être unique.";

const TOKENS_HELP =
  'Tokens disponibles : {{fire}} (horodatage du tir, utile comme clé '
  + "d'idempotence), {{now}} (heure courante), {{window:6h}} / {{window:30m}} "
  + "(début de la fenêtre, pour un « depuis ... »).";

// ── helpers (exported: the test asserts on the validation, not on the DOM) ───

export interface SchedulePreview {
  ok: boolean;
  /** French, field-level. `null` when the expression is valid. */
  error: string | null;
  /** Up to 3 upcoming fires, computed in the BROWSER's timezone. */
  next: Date[];
}

/**
 * Validate a cron expression client-side, with the same engine as the server
 * (croner) and the same 5-field restriction. This runs BEFORE the POST on
 * purpose: a typo answered by an instant inline message beats a round-trip
 * that loses the half-filled form behind an HTTP error.
 *
 * The 5-field rule is not croner's — croner happily accepts a 6-field,
 * to-the-second pattern. A per-second script cron is a fork bomb bounded only
 * by the overlap guard, so the server refuses it and so do we.
 */
export function previewSchedule(expr: string): SchedulePreview {
  const trimmed = expr.trim();
  if (trimmed === '') {
    return { ok: false, error: "L'expression est requise.", next: [] };
  }
  if (trimmed.split(/\s+/).length !== 5) {
    return {
      ok: false,
      error:
        "L'expression doit comporter exactement 5 champs (minute heure jour mois "
        + 'jour-de-semaine) — les expressions à la seconde sont refusées.',
      next: [],
    };
  }
  try {
    const next = new Cron(trimmed).nextRuns(3);
    if (next.length === 0) {
      return {
        ok: false,
        error: 'Cette expression est syntaxiquement valide mais ne se déclenchera jamais.',
        next: [],
      };
    }
    return { ok: true, error: null, next };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Expression cron invalide : ${msg}`, next: [] };
  }
}

/** Same shape, for the name. */
export function validateCronName(name: string): string | null {
  return CRON_NAME_RE.test(name.trim()) ? null : NAME_HELP;
}

/**
 * Turn a server refusal into French prose. The server's own messages are
 * English (they are also read from curl and from the logs), so the codes the
 * route documents are mapped here rather than surfaced raw.
 */
export function cronErrorMessage(err: unknown): string {
  if (err instanceof HttpError) {
    const body = err.body as { code?: string; error?: string } | undefined;
    switch (body?.code) {
      case 'NAME_TAKEN':
        return 'Un cron porte déjà ce nom. Les noms sont uniques : ils servent '
          + "d'expéditeur (`cron:<nom>`) aux messages livrés.";
      case 'UNKNOWN_ROLE':
        return "Ce rôle n'existe pas (ou plus). Choisissez un rôle existant.";
      case 'RUN_IN_FLIGHT':
        return 'Un run de ce cron est déjà en cours — attendez qu’il se termine.';
      case 'NOT_FOUND':
        return 'Ce cron n’existe plus (supprimé depuis un autre onglet ?).';
      default:
        break;
    }
  }
  return apiErrorMessage(err);
}

/**
 * Wall-clock rendering of a fire instant. Lifted to `lib/format` in Lot 4 —
 * the RightPanel header line and the CONFIG tab render the same instants and
 * must not drift from this screen.
 */
const fmtWhen = formatCronWhen;

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Outcome → theme colour. `overlap` is amber, not red: it is a warning. */
const OUTCOME_COLOR: Record<string, string> = {
  wake: 'var(--ok)',
  skip: 'var(--text-dim)',
  noop: 'var(--text-mute)',
  overlap: 'var(--amber)',
  error: 'var(--bad)',
};

function roleLabelOf(roles: readonly RoleView[], roleId: string): string | null {
  return roles.find((r) => r.id === roleId)?.label ?? null;
}

// ── screen ──────────────────────────────────────────────────────────────────

export function CronsPage({
  open,
  cronId,
  roleFilter,
  onClearRoleFilter,
  onSelectCron,
  onClose,
}: Props) {
  const {
    crons, schedulingEnabled, loading, error, unavailable,
    create, update, destroy, fire,
  } = useCrons(5000, open);
  const { isMobile } = useShellMode();
  const c = useSwarmController();

  // Selection fallback, kept LOCAL. The route is the source of truth when it
  // carries an id, but auto-selecting the first cron must not rewrite the hash
  // — that would push a history entry the operator never asked for.
  const [localSel, setLocalSel] = useState<string | null>(null);
  const [editingSection, setEditingSection] = useState<SectionId | null>(null);
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list');
  const [opError, setOpError] = useState<string | null>(null);
  const [opNote, setOpNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [runs, setRuns] = useState<CronRunView[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);

  useEffect(() => {
    if (open) setMobileView('list');
  }, [open]);

  const visible = useMemo(
    () => (roleFilter ? crons.filter((x) => x.roleId === roleFilter) : crons),
    [crons, roleFilter],
  );

  // A deep link wins, then the local fallback, then the first row. Resolving
  // through the list (rather than trusting the id) is what keeps a stale
  // `#/crons/<deleted>` from leaving the detail pane permanently empty.
  const cron = useMemo<CronView | null>(
    () =>
      visible.find((x) => x.id === cronId)
      ?? visible.find((x) => x.id === localSel)
      ?? visible[0]
      ?? null,
    [visible, cronId, localSel],
  );

  const loadRuns = useCallback(async (id: string) => {
    setRunsLoading(true);
    try {
      const r = await api.listCronRuns(id);
      setRuns(r.runs);
    } catch {
      // History is a debugging aid, not the point of the screen: a failed read
      // shows an empty section rather than an error banner over the config.
      setRuns([]);
    } finally {
      setRunsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || !cron) {
      setRuns([]);
      return;
    }
    void loadRuns(cron.id);
  }, [open, cron?.id, loadRuns]); // eslint-disable-line react-hooks/exhaustive-deps

  function tryClose(): void {
    if (editingSection && !confirm('Abandonner les modifications non enregistrées ?')) return;
    setEditingSection(null);
    onClose();
  }

  function trySelect(id: string): void {
    if (id !== cron?.id) {
      if (editingSection && !confirm('Abandonner les modifications ?')) return;
      setEditingSection(null);
      setOpError(null);
      setOpNote(null);
      setLocalSel(id);
      onSelectCron?.(id);
    }
    // Selecting navigates into the detail pane on mobile even when the row was
    // already the selected one (tapping the auto-selected first cron must open
    // it instead of being a no-op) — same rule as RolesPage.
    if (isMobile) setMobileView('detail');
  }

  async function patchSelected(body: Partial<CronInput>): Promise<void> {
    if (!cron) return;
    setOpError(null);
    setOpNote(null);
    try {
      await update(cron.id, body);
      setEditingSection(null);
    } catch (e) {
      setOpError(cronErrorMessage(e));
      throw e;
    }
  }

  async function togglePause(): Promise<void> {
    if (!cron) return;
    setBusy(true);
    setOpError(null);
    setOpNote(null);
    try {
      await update(cron.id, { paused: !cron.paused });
    } catch (e) {
      setOpError(cronErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function runNow(): Promise<void> {
    if (!cron) return;
    setBusy(true);
    setOpError(null);
    setOpNote(null);
    try {
      const run = await fire(cron.id);
      // A script cron's run row lands only when the child process settles —
      // the 202 carries `run: null`; the refreshed LAST RUNS will show it.
      setOpNote(
        run
          ? `Tir manuel enregistré (${run.outcome}).`
          : 'Script lancé — le résultat apparaîtra dans LAST RUNS.',
      );
      await loadRuns(cron.id);
    } catch (e) {
      setOpError(cronErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function doDelete(): Promise<void> {
    if (!cron) return;
    setConfirmDelete(false);
    setBusy(true);
    setOpError(null);
    try {
      await destroy(cron.id);
      setLocalSel(null);
      onSelectCron?.(null);
      if (isMobile) setMobileView('list');
    } catch (e) {
      setOpError(cronErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const filteredRoleLabel = roleFilter ? roleLabelOf(c.roles, roleFilter) : null;

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
          <div className="title">CRONS</div>
          <div className="sub">scheduled wake-ups — one cadence per row, targeting a role</div>

          {/* The global switch. Shown here rather than over the detail: it
              invalidates EVERY next-run on the screen, not just the selected
              cron's. */}
          {!schedulingEnabled && !unavailable && (
            <div className="field-warn" style={{ marginTop: 10 }}>
              ⚠ SCHEDULING DISABLED — aucune cadence n’est armée sur cette
              instance (SWARM_OS_SCHEDULE_ENABLED). Les crons restent éditables
              et RUN NOW fonctionne toujours.
            </div>
          )}

          {roleFilter && (
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="tag-pill">
                ROLE :: {(filteredRoleLabel ?? roleFilter).toUpperCase()}
              </span>
              <button
                className="h-edit"
                style={{ fontSize: 9 }}
                onClick={() => onClearRoleFilter?.()}
              >
                CLEAR
              </button>
            </div>
          )}
        </div>

        <div className="roles-list">
          {loading && crons.length === 0 && (
            <div className="field-help" style={{ padding: '14px 20px' }}>
              loading…
            </div>
          )}
          {unavailable && (
            <div className="field-help" style={{ padding: '14px 20px' }}>
              Cette instance ne connaît pas encore les crons — mettez le serveur
              à jour pour utiliser cet écran.
            </div>
          )}
          {error && (
            <div className="field-warn" style={{ margin: 12 }}>
              {error}
            </div>
          )}
          {!loading && !error && !unavailable && visible.length === 0 && (
            <div className="field-help" style={{ padding: '14px 20px' }}>
              {roleFilter
                ? 'Aucun cron pour ce rôle — cliquez sur « + NEW CRON » ci-dessous.'
                : 'Aucun cron pour l’instant — cliquez sur « + NEW CRON » ci-dessous.'}
            </div>
          )}
          {visible.map((x) => {
            const label = roleLabelOf(c.roles, x.roleId);
            return (
              <div
                key={x.id}
                className={`role-item ${cron?.id === x.id ? 'active' : ''}`}
                onClick={() => trySelect(x.id)}
              >
                <div className="r-name">{x.name.toUpperCase()}</div>
                <div className="r-id">{x.schedule}</div>
                <div className="r-tags">
                  <span className={`tag-pill ${x.action === 'script' ? 'script' : ''}`}>
                    {x.action.toUpperCase()}
                  </span>
                  {/* An orphan cron (its role was deleted — §6.2, no cascade)
                      ticks forever into nothing. It has to be visible. */}
                  <span
                    className="tag-pill"
                    style={label ? undefined : { color: 'var(--bad)', borderColor: 'var(--bad)' }}
                  >
                    → {(label ?? 'ROLE MISSING').toUpperCase()}
                  </span>
                  {x.paused && <span className="tag-pill paused">PAUSED</span>}
                  {x.nextRun && <span className="tag-pill">NEXT {fmtWhen(x.nextRun)}</span>}
                </div>
              </div>
            );
          })}
        </div>

        <div className="roles-add">
          <button
            className="btn"
            style={{ flex: 1 }}
            onClick={() => setCreateOpen(true)}
            disabled={unavailable}
          >
            + NEW CRON
          </button>
        </div>
      </aside>

      <main className="roles-main">
        {isMobile && (
          <button type="button" className="m-roles-back" onClick={() => setMobileView('list')}>
            ← CRONS
          </button>
        )}

        {cron ? (
          <>
            <h2>{cron.name.toUpperCase()}</h2>
            <div className="role-id">
              {cron.id} · → {(roleLabelOf(c.roles, cron.roleId) ?? cron.roleId).toUpperCase()}
            </div>

            {/* RUN NOW / PAUSE sit next to the header: they act on the whole
                cron, not on one section. DELETE does NOT live here — it is
                alone at the bottom (RolesPage convention). */}
            <div style={{ display: 'flex', gap: 10, marginBottom: 22, flexWrap: 'wrap' }}>
              <button
                className="btn"
                disabled={busy || cron.running}
                title={
                  cron.running
                    ? 'Un run est déjà en vol'
                    : 'Exécuter maintenant — autorisé même en pause'
                }
                onClick={() => void runNow()}
              >
                {cron.running ? 'RUNNING…' : 'RUN NOW'}
              </button>
              <button
                className="btn"
                style={{ color: cron.paused ? 'var(--ok)' : 'var(--amber)' }}
                disabled={busy}
                onClick={() => void togglePause()}
              >
                {cron.paused ? 'RESUME' : 'PAUSE'}
              </button>
            </div>

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
            {opNote && (
              <div className="field-help" style={{ color: 'var(--ok)', marginBottom: 20 }}>
                {opNote}
              </div>
            )}

            <ScheduleSection
              cron={cron}
              editing={editingSection === 'schedule'}
              onEdit={() => setEditingSection('schedule')}
              onCancel={() => setEditingSection(null)}
              onSave={(body) => patchSelected(body)}
            />

            <ActionSection
              cron={cron}
              editing={editingSection === 'action'}
              onEdit={() => setEditingSection('action')}
              onCancel={() => setEditingSection(null)}
              onSave={(body) => patchSelected(body)}
            />

            <RunsSection runs={runs} loading={runsLoading} />

            <div style={{ display: 'flex', gap: 10, marginTop: 30 }}>
              <button
                className="btn danger"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                DELETE
              </button>
            </div>
          </>
        ) : (
          <div className="field-help">Aucun cron sélectionné.</div>
        )}
      </main>

      {createOpen && (
        <CronCreateModal
          roles={c.roles}
          defaultRoleId={roleFilter ?? cron?.roleId ?? null}
          onClose={() => setCreateOpen(false)}
          onCreate={async (body) => {
            const created = await create(body);
            setCreateOpen(false);
            setLocalSel(created.id);
            onSelectCron?.(created.id);
            if (isMobile) setMobileView('detail');
          }}
        />
      )}

      {confirmDelete && cron && (
        <ConfirmModal
          label="DELETE CRON"
          body={`Supprimer le cron « ${cron.name} » ? Sa cadence est désarmée immédiatement et son historique de runs est supprimé avec lui. Le rôle ciblé n'est pas affecté.`}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void doDelete()}
        />
      )}
    </div>
  );
}

// ───────────────────────────── SCHEDULE ─────────────────────────────────────

function ScheduleSection({
  cron,
  editing,
  onEdit,
  onCancel,
  onSave,
}: {
  cron: CronView;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (body: Partial<CronInput>) => Promise<void>;
}) {
  const [name, setName] = useState(cron.name);
  const [schedule, setSchedule] = useState(cron.schedule);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the buffers when the selected cron changes, or when EDIT is
  // toggled — entering snapshots the current values, leaving snaps back to
  // whatever the next poll brought.
  useEffect(() => {
    setName(cron.name);
    setSchedule(cron.schedule);
    setError(null);
  }, [cron.id, cron.name, cron.schedule, editing]);

  const preview = useMemo(() => previewSchedule(schedule), [schedule]);

  async function save(): Promise<void> {
    const nameError = validateCronName(name);
    if (nameError) {
      setError(nameError);
      return;
    }
    if (!preview.ok) {
      setError(preview.error);
      return;
    }
    setError(null);
    try {
      await onSave({ name: name.trim(), schedule: schedule.trim() });
    } catch {
      // The parent already painted the server's refusal in its banner.
    }
  }

  return (
    <div className="role-section">
      <h3>
        <span>SCHEDULE</span>
        {editing ? (
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="h-edit" onClick={onCancel}>CANCEL</button>
            <button className="h-edit" onClick={() => void save()}>SAVE</button>
          </span>
        ) : (
          <button className="h-edit" onClick={onEdit}>EDIT</button>
        )}
      </h3>

      {editing ? (
        <div style={{ display: 'grid', gap: 14 }}>
          <div className="field">
            <label htmlFor="cron-name">NAME</label>
            <input id="cron-name" value={name} onChange={(e) => setName(e.target.value)} />
            <div className="field-help">{NAME_HELP}</div>
          </div>
          <div className="field">
            <label htmlFor="cron-schedule">EXPRESSION</label>
            <input
              id="cron-schedule"
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              placeholder="0 6,12,20 * * *"
            />
            <SchedulePreviewHint preview={preview} />
          </div>
          {error && <div className="field-warn">⚠ {error}</div>}
        </div>
      ) : (
        <div className="cfg-kv">
          <span className="k">expression</span>
          <span className="v" style={{ fontFamily: 'monospace' }}>{cron.schedule}</span>
          <span className="k">next run</span>
          <span className="v">
            {cron.nextRun ? (
              fmtWhen(cron.nextRun)
            ) : (
              <span style={{ color: 'var(--text-mute)' }}>
                — {cron.paused ? 'en pause' : 'cadence désarmée'}
              </span>
            )}
          </span>
          <span className="k">state</span>
          <span className="v">
            {cron.paused
              ? <span style={{ color: 'var(--text-mute)' }}>PAUSED</span>
              : <span style={{ color: 'var(--ok)' }}>ACTIVE</span>}
          </span>
          <span className="k">created</span>
          <span className="v">{fmtWhen(cron.createdAt)}</span>
          <span className="k">updated</span>
          <span className="v">{fmtWhen(cron.updatedAt)}</span>
        </div>
      )}
    </div>
  );
}

/** Shared between the SCHEDULE section and the creation modal. */
function SchedulePreviewHint({ preview }: { preview: SchedulePreview }) {
  if (!preview.ok) {
    return <div className="field-warn">⚠ {preview.error}</div>;
  }
  return (
    <div className="field-help">
      Prochains tirs : {preview.next.map((d) => fmtWhen(d.toISOString())).join(' · ')}.
      {' '}Aperçu calculé dans le fuseau de ce navigateur ; le serveur applique
      SWARM_OS_SCHEDULE_TZ, les heures affichées ensuite peuvent donc différer.
    </div>
  );
}

// ────────────────────────────── ACTION ──────────────────────────────────────

function ActionSection({
  cron,
  editing,
  onEdit,
  onCancel,
  onSave,
}: {
  cron: CronView;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (body: Partial<CronInput>) => Promise<void>;
}) {
  const [action, setAction] = useState(cron.action);
  const [message, setMessage] = useState(cron.message ?? '');
  const [scriptPath, setScriptPath] = useState(cron.scriptPath ?? '');
  const [interpreter, setInterpreter] = useState(cron.interpreter ?? 'python3');
  const [argsText, setArgsText] = useState((cron.scriptArgs ?? []).join('\n'));
  const [timeoutS, setTimeoutS] = useState(
    cron.timeoutMs != null ? String(Math.round(cron.timeoutMs / 1000)) : '',
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAction(cron.action);
    setMessage(cron.message ?? '');
    setScriptPath(cron.scriptPath ?? '');
    setInterpreter(cron.interpreter ?? 'python3');
    setArgsText((cron.scriptArgs ?? []).join('\n'));
    setTimeoutS(cron.timeoutMs != null ? String(Math.round(cron.timeoutMs / 1000)) : '');
    setError(null);
  }, [cron.id, editing]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(): Promise<void> {
    const body = buildActionPatch({ action, message, scriptPath, interpreter, argsText, timeoutS });
    if (typeof body === 'string') {
      setError(body);
      return;
    }
    setError(null);
    try {
      await onSave(body);
    } catch {
      // Server refusal already surfaced by the parent.
    }
  }

  return (
    <div className="role-section">
      <h3>
        <span>ACTION</span>
        {editing ? (
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="h-edit" onClick={onCancel}>CANCEL</button>
            <button className="h-edit" onClick={() => void save()}>SAVE</button>
          </span>
        ) : (
          <button className="h-edit" onClick={onEdit}>EDIT</button>
        )}
      </h3>

      {editing ? (
        <div style={{ display: 'grid', gap: 14 }}>
          <ActionFields
            action={action} setAction={setAction}
            message={message} setMessage={setMessage}
            scriptPath={scriptPath} setScriptPath={setScriptPath}
            interpreter={interpreter} setInterpreter={setInterpreter}
            argsText={argsText} setArgsText={setArgsText}
            timeoutS={timeoutS} setTimeoutS={setTimeoutS}
          />
          {error && <div className="field-warn">⚠ {error}</div>}
        </div>
      ) : cron.action === 'message' ? (
        <>
          <div className="field-help" style={{ marginBottom: 6 }}>
            À chaque tir, ce template est rendu puis livré dans l’inbox du lead de
            chaque instance vivante du rôle (expéditeur <code>cron:{cron.name}</code>).
          </div>
          <pre className="cfg-pre" style={{ whiteSpace: 'pre-wrap' }}>
            {cron.message || '(template vide)'}
          </pre>
        </>
      ) : (
        <div className="cfg-kv">
          <span className="k">script</span>
          <span className="v" style={{ fontFamily: 'monospace' }}>{cron.scriptPath ?? '—'}</span>
          <span className="k">interpreter</span>
          <span className="v">{cron.interpreter ?? '—'}</span>
          <span className="k">args</span>
          <span className="v" style={{ fontFamily: 'monospace' }}>
            {(cron.scriptArgs ?? []).join(' ') || '—'}
          </span>
          <span className="k">timeout</span>
          <span className="v">
            {cron.timeoutMs != null ? `${Math.round(cron.timeoutMs / 1000)} s` : 'défaut serveur'}
          </span>
        </div>
      )}
    </div>
  );
}

/** Validate + shape the ACTION half of a body. Returns a French error string. */
function buildActionPatch(v: {
  action: CronView['action'];
  message: string;
  scriptPath: string;
  interpreter: string;
  argsText: string;
  timeoutS: string;
}): Partial<CronInput> | string {
  if (v.action === 'message') {
    if (v.message.trim() === '') {
      return 'Le template est requis pour une action MESSAGE — un cron qui ne livre rien tickerait dans le vide.';
    }
    return { action: 'message', message: v.message };
  }
  if (v.scriptPath.trim() === '') {
    return 'Le chemin du script est requis pour une action SCRIPT.';
  }
  if (!CRON_INTERPRETERS.includes(v.interpreter as (typeof CRON_INTERPRETERS)[number])) {
    return `L'interpréteur doit être l'un de : ${CRON_INTERPRETERS.join(', ')}.`;
  }
  let timeoutMs: number | null = null;
  if (v.timeoutS.trim() !== '') {
    const seconds = Number(v.timeoutS);
    if (!Number.isFinite(seconds) || !Number.isInteger(seconds) || seconds < 1 || seconds > 240) {
      return 'Le timeout doit être un entier de 1 à 240 secondes (plafond serveur).';
    }
    timeoutMs = seconds * 1000;
  }
  const scriptArgs = v.argsText
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return {
    action: 'script',
    scriptPath: v.scriptPath.trim(),
    interpreter: v.interpreter,
    scriptArgs: scriptArgs.length > 0 ? scriptArgs : null,
    timeoutMs,
  };
}

/** The MESSAGE ↔ SCRIPT form, shared by the inline section and the modal. */
function ActionFields(p: {
  action: CronView['action'];
  setAction: (a: CronView['action']) => void;
  message: string;
  setMessage: (v: string) => void;
  scriptPath: string;
  setScriptPath: (v: string) => void;
  interpreter: string;
  setInterpreter: (v: string) => void;
  argsText: string;
  setArgsText: (v: string) => void;
  timeoutS: string;
  setTimeoutS: (v: string) => void;
}) {
  return (
    <>
      <div className="field">
        <label>ACTION</label>
        <div className="seg-radio" role="radiogroup" aria-label="action">
          {(['message', 'script'] as const).map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={p.action === a}
              className={p.action === a ? 'on' : ''}
              onClick={() => p.setAction(a)}
            >
              {a.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {p.action === 'message' ? (
        <div className="field">
          <label htmlFor="cron-message">TEMPLATE</label>
          <textarea
            id="cron-message"
            rows={5}
            value={p.message}
            onChange={(e) => p.setMessage(e.target.value)}
            placeholder="Point d'étape {{now}} — résume ce qui a bougé depuis {{window:6h}}."
          />
          <div className="field-help">{TOKENS_HELP}</div>
        </div>
      ) : (
        <>
          <div className="field">
            <label htmlFor="cron-script-path">SCRIPT PATH</label>
            <input
              id="cron-script-path"
              value={p.scriptPath}
              onChange={(e) => p.setScriptPath(e.target.value)}
              placeholder="/data/crons/jira_dev.py"
            />
            <div className="field-help">
              Chemin <strong>dans le conteneur</strong> (les agents, eux, affichent
              des chemins hôte), sous la racine du workspace ou sous le dossier de
              données. Recommandation : posez les scripts sensibles sous
              <code> /data/crons/</code>, non accessible aux agents.
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="cron-interpreter">INTERPRETER</label>
              <select
                id="cron-interpreter"
                value={p.interpreter}
                onChange={(e) => p.setInterpreter(e.target.value)}
              >
                {CRON_INTERPRETERS.map((i) => (
                  <option key={i} value={i}>{i}</option>
                ))}
              </select>
              <div className="field-help">
                Explicite : le bit <code>+x</code> d’un fichier monté depuis l’hôte
                n’est pas fiable, il n’y a donc pas de repli « fichier exécutable ».
              </div>
            </div>
            <div className="field">
              <label htmlFor="cron-timeout">TIMEOUT (S)</label>
              <input
                id="cron-timeout"
                value={p.timeoutS}
                onChange={(e) => p.setTimeoutS(e.target.value)}
                placeholder="60"
              />
              <div className="field-help">1 à 240 s. Vide = défaut serveur (60 s).</div>
            </div>
          </div>
          <div className="field">
            <label htmlFor="cron-args">ARGS</label>
            <textarea
              id="cron-args"
              rows={3}
              value={p.argsText}
              onChange={(e) => p.setArgsText(e.target.value)}
              placeholder="--since&#10;6h"
            />
            <div className="field-help">
              Un argument par ligne (pas de découpage sur les espaces : un
              argument peut en contenir).
            </div>
          </div>
          <div className="field-help">
            Contrat de sortie : la dernière ligne non vide de stdout doit être un
            JSON <code>{'{"wake": true, "message": "..."}'}</code>. <code>wake:false</code>
            {' '}ou un code de sortie non nul = aucun réveil, le run reste journalisé.
          </div>
        </>
      )}
    </>
  );
}

// ───────────────────────────── LAST RUNS ────────────────────────────────────

function RunsSection({ runs, loading }: { runs: readonly CronRunView[]; loading: boolean }) {
  return (
    <div className="role-section">
      <h3>
        <span>LAST RUNS</span>
      </h3>
      {loading && runs.length === 0 && <div className="field-help">loading…</div>}
      {!loading && runs.length === 0 && (
        <div className="field-help">
          Aucun run enregistré — ce cron n’a pas encore tiré (ou l’historique a
          été purgé avec lui).
        </div>
      )}
      {runs.map((r) => (
        <div
          key={r.id}
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            flexWrap: 'wrap',
            fontSize: 12,
            padding: '5px 0',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <span
            className="tag-pill"
            style={{
              color: OUTCOME_COLOR[r.outcome] ?? 'var(--text-mute)',
              borderColor: OUTCOME_COLOR[r.outcome] ?? 'var(--border)',
            }}
          >
            {r.outcome.toUpperCase()}
          </span>
          <span style={{ color: 'var(--text-dim)', fontFamily: 'monospace' }}>
            {fmtWhen(r.firedAt)}
          </span>
          <span className="tag-pill">{r.kind.toUpperCase()}</span>
          <span style={{ color: 'var(--text-mute)' }}>{fmtDuration(r.durationMs)}</span>
          {r.exitCode != null && (
            <span style={{ color: 'var(--text-mute)' }}>exit {r.exitCode}</span>
          )}
          {r.deliveredTo.length > 0 && (
            <span style={{ color: 'var(--text-mute)' }}>
              → {r.deliveredTo.length} lead{r.deliveredTo.length > 1 ? 's' : ''}
            </span>
          )}
          {r.outputExcerpt && (
            <span
              style={{
                color: 'var(--text-mute)',
                fontFamily: 'monospace',
                flexBasis: '100%',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {r.outputExcerpt}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ──────────────────────────── CREATE MODAL ──────────────────────────────────

/**
 * A cron cannot be born blank (name, roleId and schedule are NOT NULL), so
 * creation is a modal rather than the "POST an empty item, then edit inline"
 * flow of ROLES. Known and accepted defect, shared with `SkillImportModal`:
 * ⌘K renders above a modal that lives inside an overlay.
 */
function CronCreateModal({
  roles,
  defaultRoleId,
  onClose,
  onCreate,
}: {
  roles: readonly RoleView[];
  defaultRoleId: string | null;
  onClose: () => void;
  onCreate: (body: CronInput) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [roleId, setRoleId] = useState(defaultRoleId ?? roles[0]?.id ?? '');
  const [schedule, setSchedule] = useState('0 9 * * 1-5');
  const [action, setAction] = useState<CronView['action']>('message');
  const [message, setMessage] = useState('');
  const [scriptPath, setScriptPath] = useState('');
  const [interpreter, setInterpreter] = useState('python3');
  const [argsText, setArgsText] = useState('');
  const [timeoutS, setTimeoutS] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const preview = useMemo(() => previewSchedule(schedule), [schedule]);

  async function submit(): Promise<void> {
    const nameError = validateCronName(name);
    if (nameError) {
      setError(nameError);
      return;
    }
    if (!roleId) {
      setError('Choisissez le rôle ciblé par ce cron.');
      return;
    }
    // Client-side croner check BEFORE the POST: the same engine as the server,
    // so a pattern that passes here passes there.
    if (!preview.ok) {
      setError(preview.error);
      return;
    }
    const actionBody = buildActionPatch({
      action, message, scriptPath, interpreter, argsText, timeoutS,
    });
    if (typeof actionBody === 'string') {
      setError(actionBody);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await onCreate({
        name: name.trim(),
        roleId,
        schedule: schedule.trim(),
        action,
        ...actionBody,
      } as CronInput);
    } catch (e) {
      setError(cronErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            {/* Braced string, not a bare `//` text node: eslint reads the
                latter as a stray JS comment (react/jsx-no-comment-textnodes). */}
            + NEW CRON <span className="sub">{'// scheduled wake-up for a role'}</span>
          </div>
          <button className="pr-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="modal-body">
          <div className="field-row">
            <div className="field">
              <label htmlFor="new-cron-name">NAME</label>
              <input
                id="new-cron-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="daily-standup"
              />
              <div className="field-help">{NAME_HELP}</div>
            </div>
            <div className="field">
              <label htmlFor="new-cron-role">ROLE</label>
              <select
                id="new-cron-role"
                value={roleId}
                onChange={(e) => setRoleId(e.target.value)}
              >
                {roles.length === 0 && <option value="">(aucun rôle)</option>}
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>{r.label}</option>
                ))}
              </select>
              <div className="field-help">
                Le tir est diffusé au lead de <strong>chaque instance vivante</strong>
                {' '}de ce rôle. Aucune instance en vie = run journalisé en
                <code> noop</code>, l’équipe n’est pas redémarrée.
              </div>
            </div>
          </div>

          <div className="field">
            <label htmlFor="new-cron-schedule">SCHEDULE</label>
            <input
              id="new-cron-schedule"
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              placeholder="0 6,12,20 * * *"
            />
            <SchedulePreviewHint preview={preview} />
          </div>

          <ActionFields
            action={action} setAction={setAction}
            message={message} setMessage={setMessage}
            scriptPath={scriptPath} setScriptPath={setScriptPath}
            interpreter={interpreter} setInterpreter={setInterpreter}
            argsText={argsText} setArgsText={setArgsText}
            timeoutS={timeoutS} setTimeoutS={setTimeoutS}
          />

          {error && <div className="field-warn" role="alert">⚠ {error}</div>}
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={busy}>CANCEL</button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'CREATING…' : 'CREATE CRON'}
          </button>
        </div>
      </div>
    </div>
  );
}

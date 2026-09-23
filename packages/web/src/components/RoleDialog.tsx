import { useEffect, useState, type CSSProperties } from 'react';
import {
  api,
  apiErrorMessage,
  isDiscordConnectorView,
  type BudgetAction,
  type ConnectorView,
  type RoleView,
  type SkillView,
  type SkillActivation,
} from '../api/client';
import { budgetFieldValue, parseCostBudget, toBudgetAction } from '../lib/budget';
import { autoCompactFieldValue, parseAutoCompactPct } from '../lib/autoCompact';
import { DiscordOnboarding } from './DiscordOnboarding';
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

interface SubmitBody {
  label: string;
  leadPrompt: string | null;
  leadPreamble: string | null;
  workerPreamble: string | null;
  workerCount: number | null;
  defaultModel: string | null;
  defaultEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  defaultPermissionMode: string | null;
  /** `null` = inherit the instance default, same convention as `defaultModel`. */
  defaultProvider: string | null;
  connectors: ConnectorView[];
  /** Skills activated for this role (mode 'inject'). */
  skills: SkillActivation[];
  /** Dead-worker reaper: soft-remove terminal workers after the delay. */
  autoRemoveDeadWorkers: boolean;
  autoRemoveDeadWorkersDelayMs: number;
  /**
   * Cost budget (Lot 14) — `null` = no budget. Always SENT, including as
   * `null`, because clearing a budget has to be expressible: a field that is
   * only sent when filled can set a ceiling and never remove one.
   */
  costBudgetUsd: number | null;
  budgetAction: BudgetAction;
  /**
   * Auto-compact threshold (docs/auto-compact.md) — `null` = inherit the
   * instance default, `0` = disabled for this role, `1..100` = the percentage.
   * Always SENT, `null` included, for the same reason as `costBudgetUsd`:
   * going back to inheriting has to be expressible.
   */
  autoCompactPct: number | null;
}

const INHERIT_LABEL = '(inherit global default)';

/**
 * The two budget outcomes, in the order they escalate. `PAUSE TEAM` rather
 * than `PAUSE`: what is suspended is the whole team, lead included, and a
 * two-letter saving here would be paid for by an operator who thought only
 * the worker that overspent would stop.
 */
const BUDGET_ACTIONS: ReadonlyArray<{ value: BudgetAction; label: string }> = [
  { value: 'notify', label: 'NOTIFY' },
  { value: 'pause', label: 'PAUSE TEAM' },
];

interface Props {
  open: boolean;
  onClose: () => void;
  onSubmit: (body: SubmitBody) => Promise<RoleView>;
  /** When provided, the dialog edits an existing role. */
  initial?: RoleView | null;
  /**
   * Optional inline styles for the outer fixed wrapper. Used by the v2
   * NewOrchestratorDialog (Step 9) to bump z-index above the warm-black
   * `.modal-backdrop` until RoleDialog itself is ported (Step 10).
   */
  containerStyle?: CSSProperties;
}

// `disabled:` variants matter since Lot 3: EFFORT / PERMISSION are disabled
// when the selected provider cannot express them, and an unstyled disabled
// select is indistinguishable from an enabled one.
const inputCls =
  'w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100 focus:outline-none focus:border-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed';

export function RoleDialog({ open, onClose, onSubmit, initial, containerStyle }: Props) {
  const editing = !!initial;
  const {
    providers,
    defaultProvider: serverDefaultProvider,
    transport,
    refresh: refreshProviders,
  } = useProviders();
  const [label, setLabel] = useState('');
  const [leadPrompt, setLeadPrompt] = useState('');
  const [leadPreamble, setLeadPreamble] = useState('');
  const [workerPreamble, setWorkerPreamble] = useState('');
  const [workerCount, setWorkerCount] = useState<string>('');
  const [provider, setProvider] = useState<string>(INHERIT);
  const [model, setModel] = useState<string>('');
  const [effort, setEffort] = useState<string>('');
  const [perm, setPerm] = useState<string>('');
  const [discordUrl, setDiscordUrl] = useState<string>('');
  const [discordChannelId, setDiscordChannelId] = useState<string>('');
  const [discordBotToken, setDiscordBotToken] = useState<string>('');
  const [autoRemoveDead, setAutoRemoveDead] = useState<boolean>(false);
  const [autoRemoveDelayMin, setAutoRemoveDelayMin] = useState<string>('10');
  const [costBudget, setCostBudget] = useState<string>('');
  const [budgetAction, setBudgetAction] = useState<BudgetAction>('notify');
  // Empty string = inherit the instance threshold; `'0'` = disabled. Kept as a
  // string so those two stay distinguishable while the operator types.
  const [autoCompact, setAutoCompact] = useState<string>('');
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [availableSkills, setAvailableSkills] = useState<SkillView[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [defaults, setDefaults] = useState<{ lead: string; worker: string } | null>(null);
  const [improving, setImproving] = useState<
    null | 'leadPrompt' | 'leadPreamble' | 'workerPreamble'
  >(null);

  useEffect(() => {
    if (!open || defaults !== null) return;
    let cancelled = false;
    void api
      .getPreambleDefaults()
      .then((res) => {
        if (!cancelled) setDefaults(res);
      })
      .catch(() => {
        /* placeholder simply stays as the fallback string */
      });
    return () => {
      cancelled = true;
    };
  }, [open, defaults]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (initial) {
      setLabel(initial.label);
      setLeadPrompt(initial.leadPrompt ?? '');
      setLeadPreamble(initial.leadPreamble ?? '');
      setWorkerPreamble(initial.workerPreamble ?? '');
      setWorkerCount(initial.workerCount != null ? String(initial.workerCount) : '');
      setProvider(initial.defaultProvider ?? INHERIT);
      setModel(initial.defaultModel ?? '');
      setEffort(initial.defaultEffort ?? '');
      setPerm(initial.defaultPermissionMode ?? '');
      const discord = initial.connectors.find(isDiscordConnectorView);
      setDiscordUrl(discord?.webhookUrl ?? '');
      setDiscordChannelId(discord?.channelId ?? '');
      setDiscordBotToken(discord?.botToken ?? '');
      setAutoRemoveDead(initial.autoRemoveDeadWorkers ?? false);
      setAutoRemoveDelayMin(
        String(Math.round((initial.autoRemoveDeadWorkersDelayMs ?? 600000) / 60000)),
      );
      // Absent on a server predating Lot 14 — read as "no budget", never as 0.
      setCostBudget(budgetFieldValue(initial.costBudgetUsd));
      setBudgetAction(toBudgetAction(initial.budgetAction));
      // Absent on a server predating auto-compact — read as "inherit", and `0`
      // as the explicit opt-out it is, never as an empty field.
      setAutoCompact(autoCompactFieldValue(initial.autoCompactPct));
      setSelectedSkills((initial.skills ?? []).map((s) => s.name));
    } else {
      setLabel('');
      setLeadPrompt('');
      setLeadPreamble('');
      setWorkerPreamble('');
      setWorkerCount('');
      setProvider(INHERIT);
      setModel('');
      setEffort('');
      setPerm('');
      setDiscordUrl('');
      setDiscordChannelId('');
      setDiscordBotToken('');
      setAutoRemoveDead(false);
      setAutoRemoveDelayMin('10');
      setCostBudget('');
      setBudgetAction('notify');
      setAutoCompact('');
      setSelectedSkills([]);
    }
  }, [open, initial]);

  // Multi-provider Lot 3 — re-probe on open so a CLI installed on the host
  // since the page loaded is selectable without a reload (60 s server TTL).
  useEffect(() => {
    if (!open) return;
    void refreshProviders();
  }, [open, refreshProviders]);

  // Fetch available skills on open (best-effort; empty list is fine).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void api
      .listSkills()
      .then((r) => { if (!cancelled) setAvailableSkills(r.skills); })
      .catch(() => { /* silent — skills feature may not be deployed yet */ });
    return () => { cancelled = true; };
  }, [open]);

  // `defaultProvider = null` means "inherit", so the controls below are filtered
  // by the provider that would ACTUALLY be used — the instance default.
  const effectiveProvider = findProvider(providers, provider || serverDefaultProvider);
  const efforts = effortsFor(effectiveProvider);
  const perms = permissionsFor(effectiveProvider);
  const permIsChoice = isPermissionChoice(effectiveProvider);

  if (!open) return null;

  async function handleImprove(field: 'leadPrompt' | 'leadPreamble' | 'workerPreamble') {
    if (improving) return;
    const current =
      field === 'leadPrompt' ? leadPrompt : field === 'leadPreamble' ? leadPreamble : workerPreamble;
    setError(null);
    setImproving(field);
    try {
      const { text } = await api.improveText({ field, text: current });
      if (field === 'leadPrompt') setLeadPrompt(text);
      else if (field === 'leadPreamble') setLeadPreamble(text);
      else setWorkerPreamble(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImproving(null);
    }
  }

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      const connectors: ConnectorView[] = [];
      const url = discordUrl.trim();
      const channelId = discordChannelId.trim();
      const botToken = discordBotToken.trim();
      if (url && !/^https?:\/\//i.test(url)) {
        throw new Error('L’URL du webhook Discord doit commencer par http(s)://');
      }
      if (channelId && !/^\d{17,20}$/.test(channelId)) {
        throw new Error('Le channel ID Discord doit être un snowflake (17–20 chiffres).');
      }
      if (botToken && !channelId) {
        throw new Error('Renseigne un channel ID avec le bot token (le bot doit écouter quelque part).');
      }
      const hasAny = !!url || !!(botToken && channelId);
      if (hasAny) {
        connectors.push({
          type: 'discord',
          ...(url ? { webhookUrl: url } : {}),
          ...(channelId ? { channelId } : {}),
          ...(botToken ? { botToken } : {}),
        });
      } else if (url || channelId || botToken) {
        // Some fields set but no complete mechanism — e.g. channelId alone.
        throw new Error('Configure soit un webhook URL, soit un bot token + channel ID (ou les deux).');
      }
      let parsedCount: number | null = null;
      if (workerCount.trim()) {
        const n = Number.parseInt(workerCount, 10);
        if (!Number.isInteger(n) || n < 0) {
          throw new Error('workerCount must be a non-negative integer');
        }
        parsedCount = n;
      }
      let autoRemoveDelayMs = 600000;
      if (autoRemoveDead) {
        const n = Number.parseInt(autoRemoveDelayMin, 10);
        if (!Number.isInteger(n) || n < 0) {
          throw new Error('Le délai de retrait des workers morts doit être un entier de minutes ≥ 0.');
        }
        autoRemoveDelayMs = n * 60000;
      }
      // Rejected rather than coerced: a budget silently dropped on a typo
      // leaves the operator believing a ceiling exists. See `parseCostBudget`.
      const budget = parseCostBudget(costBudget);
      if (!budget.ok) throw new Error(budget.error);
      // Same contract as the budget: rejected rather than rounded, since the
      // server answers 400 on a non-integer and the role would look saved.
      const compact = parseAutoCompactPct(autoCompact);
      if (!compact.ok) throw new Error(compact.error);
      await onSubmit({
        label: label.trim(),
        leadPrompt: leadPrompt.trim() ? leadPrompt : null,
        leadPreamble: leadPreamble.trim() ? leadPreamble : null,
        workerPreamble: workerPreamble.trim() ? workerPreamble : null,
        workerCount: parsedCount,
        defaultModel: model || null,
        defaultEffort: (effort || null) as SubmitBody['defaultEffort'],
        defaultPermissionMode: perm || null,
        // `null` = inherit `config.defaultProvider` (nullable server-side).
        defaultProvider: provider || null,
        connectors,
        skills: selectedSkills.map((name) => ({ name, mode: 'inject' as const })),
        autoRemoveDeadWorkers: autoRemoveDead,
        autoRemoveDeadWorkersDelayMs: autoRemoveDelayMs,
        costBudgetUsd: budget.value,
        budgetAction,
        autoCompactPct: compact.value,
      });
      onClose();
    } catch (err) {
      // Unwrap the server's `{error, code}` body — a bare
      // "HTTP 400 POST /roles" hides which field it rejected.
      setError(apiErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 z-40 flex items-center justify-center p-4"
      style={containerStyle}
    >
      <div className="bg-slate-900 border border-slate-700 rounded-lg w-full max-w-2xl p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
        <h2 className="text-xl font-semibold mb-4">{editing ? 'Edit role' : 'New role'}</h2>
        <div className="grid grid-cols-2 gap-3">
          <Field label="label (required)" wide>
            <input
              className={inputCls}
              placeholder="researcher"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
          <Field label="lead prompt (optional)" wide>
            <div className="relative">
              <textarea
                className={`${inputCls} min-h-[80px] resize-y font-mono text-xs pr-24`}
                placeholder="What the lead should focus on by default…"
                value={leadPrompt}
                onChange={(e) => setLeadPrompt(e.target.value)}
              />
              <ImproveButton
                field="leadPrompt"
                improving={improving}
                onClick={() => void handleImprove('leadPrompt')}
              />
            </div>
          </Field>
          <Field label="lead preamble override (optional)" wide>
            <div className="relative">
              <textarea
                className={`${inputCls} min-h-[80px] resize-y font-mono text-xs pr-24`}
                placeholder={defaults?.lead ?? 'Chargement du preamble par défaut…'}
                value={leadPreamble}
                onChange={(e) => setLeadPreamble(e.target.value)}
              />
              <ImproveButton
                field="leadPreamble"
                improving={improving}
                onClick={() => void handleImprove('leadPreamble')}
              />
            </div>
          </Field>
          <Field label="worker preamble override (optional)" wide>
            <div className="relative">
              <textarea
                className={`${inputCls} min-h-[80px] resize-y font-mono text-xs pr-24`}
                placeholder={defaults?.worker ?? 'Chargement du preamble par défaut…'}
                value={workerPreamble}
                onChange={(e) => setWorkerPreamble(e.target.value)}
              />
              <ImproveButton
                field="workerPreamble"
                improving={improving}
                onClick={() => void handleImprove('workerPreamble')}
              />
            </div>
          </Field>
          <Field label="initial workers (optional)">
            <input
              className={inputCls}
              type="number"
              min={0}
              placeholder="0"
              value={workerCount}
              onChange={(e) => setWorkerCount(e.target.value)}
            />
          </Field>
          {/* PROVIDER before MODEL: the model catalogue below is this
              provider's. Unavailable adapters remain listed and disabled with
              their reason rather than vanishing. */}
          <Field label="default provider">
            <ProviderSelect
              className={inputCls}
              value={provider}
              providers={providers}
              inheritLabel={INHERIT_LABEL}
              onChange={(id) => {
                setProvider(id);
                // Never keep another provider's model id behind a new provider.
                setModel('');
              }}
            />
            {unavailableNote(effectiveProvider, transport) && (
              <p className="mt-1 text-[11px] text-amber-400">
                ⚠ {unavailableNote(effectiveProvider, transport)}
              </p>
            )}
          </Field>
          <Field label="default model">
            <ModelSelect
              className={inputCls}
              value={model}
              provider={effectiveProvider}
              inheritLabel={INHERIT_LABEL}
              onChange={setModel}
            />
          </Field>
          <Field label="default effort">
            <select
              className={inputCls}
              value={effort}
              disabled={efforts.length === 0}
              onChange={(e) => setEffort(e.target.value)}
            >
              {[INHERIT, ...efforts].map((v) => (
                <option key={v} value={v}>
                  {v || '(inherit)'}
                </option>
              ))}
            </select>
            {effortNote(effectiveProvider) && (
              <p className="mt-1 text-[11px] text-slate-400">{effortNote(effectiveProvider)}</p>
            )}
          </Field>
          <Field label="default permission mode">
            <select
              className={inputCls}
              value={perm}
              disabled={!permIsChoice}
              onChange={(e) => setPerm(e.target.value)}
            >
              {[INHERIT, ...perms].map((v) => (
                <option key={v} value={v}>
                  {v || '(inherit)'}
                </option>
              ))}
            </select>
            {permissionNote(effectiveProvider) && (
              <p className="mt-1 text-[11px] text-slate-400">{permissionNote(effectiveProvider)}</p>
            )}
          </Field>
          <div className="col-span-2 mt-1">
            <label className="flex items-center gap-2 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={autoRemoveDead}
                onChange={(e) => setAutoRemoveDead(e.target.checked)}
              />
              <span>Retirer automatiquement les workers morts</span>
            </label>
          </div>
          <Field label="délai (min) avant retrait">
            <input
              className={inputCls}
              type="number"
              min={0}
              placeholder="10"
              value={autoRemoveDelayMin}
              disabled={!autoRemoveDead}
              onChange={(e) => setAutoRemoveDelayMin(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-slate-400">
              Un worker terminé (killed / exited / failed) est retiré de l’affichage une fois ce
              délai écoulé. Leads et sessions actives jamais touchés.
            </p>
          </Field>

          {/* ── AUTO-COMPACT (docs/auto-compact.md) ──
              Under the reaper, above the budget: the three of them are the
              per-role guard rails the server applies by itself, and this one
              is the only one that is ON by default — hence the placeholder
              showing what an empty field actually inherits. */}
          <Field label="auto-compact (%)">
            <input
              className={inputCls}
              type="number"
              min={0}
              max={100}
              placeholder="35"
              value={autoCompact}
              onChange={(e) => setAutoCompact(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-slate-400">
              Le serveur arme « /compact » quand le contexte de l’agent dépasse ce pourcentage
              de sa fenêtre, seulement quand l’agent est idle avec une inbox vide. Vide = valeur
              de l’instance (35 % par défaut). 0 = désactivé pour ce rôle.
            </p>
          </Field>

          {/* ── COST BUDGET (Lot 14) ──
              Under the reaper on purpose: both are per-role guard rails the
              server enforces on its own, and both are about a team that has
              stopped being watched. The amount and its consequence sit side by
              side because neither is readable alone — `$50` says nothing about
              whether crossing it stops the swarm. */}
          <div className="col-span-2 mt-2 border-t border-slate-700 pt-3">
            <span className="block text-xs uppercase tracking-wide text-slate-400">
              cost budget
            </span>
          </div>
          <Field label="cost budget (usd)">
            <input
              className={inputCls}
              type="number"
              min={0}
              step="0.01"
              placeholder="50"
              value={costBudget}
              onChange={(e) => setCostBudget(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-slate-400">
              Cumulé par TEAM de ce rôle, workers retirés inclus. Vide = pas de budget.
            </p>
          </Field>
          {/* NOT wrapped in `Field`: that renders a <label>, and a label around
              buttons labels nothing while stealing their clicks. */}
          <div>
            <span className="block text-xs uppercase tracking-wide text-slate-400 mb-1">
              on budget exceeded
            </span>
            <div className="seg-radio" role="radiogroup" aria-label="on budget exceeded">
              {BUDGET_ACTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={budgetAction === opt.value}
                  className={budgetAction === opt.value ? 'on' : ''}
                  onClick={() => setBudgetAction(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-slate-400">
              NOTIFY : toast + Discord (si webhook). PAUSE TEAM : SIGSTOP de toute l’équipe,
              reprise manuelle.
            </p>
          </div>

          <div className="col-span-2 mt-2">
            <DiscordOnboarding
              webhookUrl={discordUrl}
              setWebhookUrl={setDiscordUrl}
              channelId={discordChannelId}
              setChannelId={setDiscordChannelId}
              botToken={discordBotToken}
              setBotToken={setDiscordBotToken}
              inputClassName={inputCls}
            />
          </div>

          {/* Skills multiselect — only shown when at least one skill is installed */}
          {availableSkills.length > 0 && (
            <div className="col-span-2 mt-2">
              <span className="block text-xs uppercase tracking-wide text-slate-400 mb-1">
                skills (active on this role)
              </span>
              <div className="flex flex-wrap gap-2">
                {availableSkills.map((s) => {
                  const active = selectedSkills.includes(s.name);
                  const needsReview = s.reviewRequired && !s.reviewed;
                  return (
                    <button
                      key={s.name}
                      type="button"
                      className="px-2 py-1 text-xs rounded border transition-colors"
                      style={
                        active
                          ? { borderColor: 'var(--amber, #f59e0b)', color: 'var(--amber, #f59e0b)', background: 'rgba(245,158,11,0.08)' }
                          : needsReview
                          ? { borderColor: 'var(--bad, #e0654a)', color: 'var(--bad, #e0654a)', background: 'transparent', opacity: 0.75 }
                          : { borderColor: '#475569', color: '#94a3b8', background: 'transparent' }
                      }
                      onClick={() => {
                        setSelectedSkills((prev) =>
                          active ? prev.filter((n) => n !== s.name) : [...prev, s.name],
                        );
                      }}
                      title={
                        needsReview
                          ? `${s.description ?? s.name} — review required before assets are staged`
                          : (s.description ?? s.name)
                      }
                    >
                      {s.displayName ?? s.name}
                      {active ? ' ✓' : ''}
                      {needsReview ? ' ⚠' : ''}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-[11px] text-slate-400">
                Activated skills inject instructions into agent preambles (mode: inject).
                Hot activation is immediate but <em>lost on /clear</em> — guaranteed at next spawn/resume.
                Skills marked ⚠ require review before their executable assets are staged at spawn.
              </p>
            </div>
          )}
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
            disabled={submitting || !label.trim()}
          >
            {submitting ? 'Saving…' : editing ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

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

function ImproveButton({
  field,
  improving,
  onClick,
}: {
  field: 'leadPrompt' | 'leadPreamble' | 'workerPreamble';
  improving: 'leadPrompt' | 'leadPreamble' | 'workerPreamble' | null;
  onClick: () => void;
}) {
  const isThis = improving === field;
  const disabled = improving !== null;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title="Améliorer avec Claude"
      className="absolute top-1 right-1 text-[10px] px-1.5 py-0.5 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-100"
    >
      {isThis ? '… Amélioration' : '✨ Améliorer'}
    </button>
  );
}

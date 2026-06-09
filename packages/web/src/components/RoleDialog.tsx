import { useEffect, useState, type CSSProperties } from 'react';
import { api, type ConnectorView, type RoleView } from '../api/client';

interface SubmitBody {
  label: string;
  leadPrompt: string | null;
  leadPreamble: string | null;
  workerPreamble: string | null;
  workerCount: number | null;
  defaultModel: string | null;
  defaultEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  defaultPermissionMode: string | null;
  connectors: ConnectorView[];
}

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
const MODELS = [
  { value: '', label: '(inherit global default)' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8 (claude-opus-4-8)' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (claude-sonnet-4-6)' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (claude-haiku-4-5-20251001)' },
] as const;

const inputCls =
  'w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100 focus:outline-none focus:border-emerald-500';

export function RoleDialog({ open, onClose, onSubmit, initial, containerStyle }: Props) {
  const editing = !!initial;
  const [label, setLabel] = useState('');
  const [leadPrompt, setLeadPrompt] = useState('');
  const [leadPreamble, setLeadPreamble] = useState('');
  const [workerPreamble, setWorkerPreamble] = useState('');
  const [workerCount, setWorkerCount] = useState<string>('');
  const [model, setModel] = useState<string>('');
  const [effort, setEffort] = useState<string>('');
  const [perm, setPerm] = useState<string>('');
  const [discordUrl, setDiscordUrl] = useState<string>('');
  const [discordChannelId, setDiscordChannelId] = useState<string>('');
  const [discordBotToken, setDiscordBotToken] = useState<string>('');
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
      setModel(initial.defaultModel ?? '');
      setEffort(initial.defaultEffort ?? '');
      setPerm(initial.defaultPermissionMode ?? '');
      const discord = initial.connectors.find((c) => c.type === 'discord');
      setDiscordUrl(discord?.webhookUrl ?? '');
      setDiscordChannelId(discord?.channelId ?? '');
      setDiscordBotToken(discord?.botToken ?? '');
    } else {
      setLabel('');
      setLeadPrompt('');
      setLeadPreamble('');
      setWorkerPreamble('');
      setWorkerCount('');
      setModel('');
      setEffort('');
      setPerm('');
      setDiscordUrl('');
      setDiscordChannelId('');
      setDiscordBotToken('');
    }
  }, [open, initial]);

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
      if (url) {
        if (!/^https?:\/\//i.test(url)) {
          throw new Error('Discord webhook URL must start with http(s)://');
        }
        if (channelId && !/^\d{17,20}$/.test(channelId)) {
          throw new Error('Discord channel ID must be 17–20 digits (a Discord snowflake)');
        }
        if (botToken && !channelId) {
          throw new Error('Set a Discord channel ID alongside the bot token (the bot needs a channel to listen on)');
        }
        connectors.push({
          type: 'discord',
          webhookUrl: url,
          ...(channelId ? { channelId } : {}),
          ...(botToken ? { botToken } : {}),
        });
      } else if (channelId || botToken) {
        throw new Error('Set a Discord webhook URL before adding a channel ID or bot token');
      }
      let parsedCount: number | null = null;
      if (workerCount.trim()) {
        const n = Number.parseInt(workerCount, 10);
        if (!Number.isInteger(n) || n < 0) {
          throw new Error('workerCount must be a non-negative integer');
        }
        parsedCount = n;
      }
      await onSubmit({
        label: label.trim(),
        leadPrompt: leadPrompt.trim() ? leadPrompt : null,
        leadPreamble: leadPreamble.trim() ? leadPreamble : null,
        workerPreamble: workerPreamble.trim() ? workerPreamble : null,
        workerCount: parsedCount,
        defaultModel: model || null,
        defaultEffort: (effort || null) as SubmitBody['defaultEffort'],
        defaultPermissionMode: perm || null,
        connectors,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
          <Field label="default model">
            <select className={inputCls} value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="default effort">
            <select className={inputCls} value={effort} onChange={(e) => setEffort(e.target.value)}>
              {EFFORTS.map((v) => (
                <option key={v} value={v}>
                  {v || '(inherit)'}
                </option>
              ))}
            </select>
          </Field>
          <Field label="default permission mode">
            <select className={inputCls} value={perm} onChange={(e) => setPerm(e.target.value)}>
              {PERMS.map((v) => (
                <option key={v} value={v}>
                  {v || '(inherit)'}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Discord webhook URL (optional)" wide>
            <input
              className={inputCls}
              type="url"
              placeholder="https://discord.com/api/webhooks/…"
              value={discordUrl}
              onChange={(e) => setDiscordUrl(e.target.value)}
            />
            <p className="mt-1 text-[11px] leading-snug text-slate-400">
              When set, orchestrators created with this role will route their notifications to
              this webhook instead of the global one.
            </p>
          </Field>
          <Field label="Discord channel ID (optional — enables bot bidirectional)" wide>
            <input
              className={inputCls}
              type="text"
              inputMode="numeric"
              pattern="\d{17,20}"
              placeholder="e.g. 1234567890123456789"
              value={discordChannelId}
              onChange={(e) => setDiscordChannelId(e.target.value)}
            />
            <p className="mt-1 text-[11px] leading-snug text-slate-400">
              When set AND a <code>Bot token</code> is configured below, the role's bot
              subscribes to this channel: every human message lands in the lead's inbox
              (<code>from: discord:&lt;username&gt;</code>) and the lead can write back via the{' '}
              <code>discord.send_message</code> tool. Enable Developer Mode in Discord, right-click
              the channel, → Copy Channel ID.
            </p>
          </Field>
          <Field label="Discord bot token (optional — per-role Discord identity)" wide>
            <input
              className={inputCls}
              type="password"
              autoComplete="off"
              placeholder="MTAxxxxxxxxxxxxxxxxx.xxxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              value={discordBotToken}
              onChange={(e) => setDiscordBotToken(e.target.value)}
            />
            <p className="mt-1 text-[11px] leading-snug text-slate-400">
              Bot OAuth token from the Discord Developer Portal. Each role can have its own
              bot user (e.g. Marketing-Bot, Support-Bot). Leave empty to disable bidirectional
              Discord for this role — the webhook above keeps owning system notifications.
            </p>
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
      title="Améliorer avec Claude Opus 4.7"
      className="absolute top-1 right-1 text-[10px] px-1.5 py-0.5 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-100"
    >
      {isThis ? '… Amélioration' : '✨ Améliorer'}
    </button>
  );
}

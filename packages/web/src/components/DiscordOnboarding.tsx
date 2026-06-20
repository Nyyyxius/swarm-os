import { useState } from 'react';
import { api } from '../api/client';

/**
 * Discord guided onboarding — five steps wrapped in one self-contained box.
 *
 * Shared between RoleDialog (the modal) and RolesPage (the inline editor).
 * Owns its own validation + webhook-creation state; the only durable values
 * are the three connector fields (`webhookUrl`, `channelId`, `botToken`),
 * lifted into the parent via setters so the parent owns the submit path.
 */

interface Props {
  webhookUrl: string;
  setWebhookUrl: (v: string) => void;
  channelId: string;
  setChannelId: (v: string) => void;
  botToken: string;
  setBotToken: (v: string) => void;
  /**
   * Tailwind class string applied to all `<input>` elements. RoleDialog and
   * RolesPage use slightly different input chrome — passing the class in
   * keeps the component visually at home in either container.
   */
  inputClassName?: string;
}

const DEFAULT_INPUT =
  'w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100 focus:outline-none focus:border-emerald-500';

// View Channel (1024) | Send Messages (2048) | Read Message History (65536) |
// Manage Webhooks (536870912). The last is what lets the bot itself create
// the channel webhook in step 5.
const OAUTH_PERMISSIONS = '536939520';

export function DiscordOnboarding({
  webhookUrl,
  setWebhookUrl,
  channelId,
  setChannelId,
  botToken,
  setBotToken,
  inputClassName,
}: Props) {
  const inputCls = inputClassName ?? DEFAULT_INPUT;

  const [validatedBot, setValidatedBot] = useState<{
    id: string;
    username: string;
    avatar: string | null;
  } | null>(null);
  const [validating, setValidating] = useState(false);
  const [validateError, setValidateError] = useState<string | null>(null);
  const [creatingWebhook, setCreatingWebhook] = useState(false);
  const [webhookError, setWebhookError] = useState<string | null>(null);

  async function validateToken() {
    setValidateError(null);
    const tok = botToken.trim();
    if (!tok) {
      setValidateError('Colle d’abord un bot token.');
      return;
    }
    setValidating(true);
    try {
      const res = await api.validateDiscordToken(tok);
      if (!res.ok) {
        setValidatedBot(null);
        setValidateError(
          res.status === 401
            ? 'Token invalide ou révoqué (Discord répond 401).'
            : `Validation refusée : ${res.error}`,
        );
        return;
      }
      setValidatedBot({ id: res.bot.id, username: res.bot.username, avatar: res.bot.avatar });
    } catch (err) {
      setValidateError(err instanceof Error ? err.message : String(err));
    } finally {
      setValidating(false);
    }
  }

  async function createWebhook() {
    setWebhookError(null);
    const tok = botToken.trim();
    const cid = channelId.trim();
    if (!tok || !cid) {
      setWebhookError('Token et channel ID requis avant de créer le webhook.');
      return;
    }
    if (!/^\d{17,20}$/.test(cid)) {
      setWebhookError('Channel ID doit être un snowflake Discord (17–20 chiffres).');
      return;
    }
    setCreatingWebhook(true);
    try {
      const res = await api.createDiscordWebhook({ token: tok, channelId: cid, name: 'swarm-os' });
      if (!res.ok) {
        setWebhookError(
          res.status === 403
            ? "Le bot n’a pas la permission Manage Webhooks sur ce channel (vérifie l’invitation et les permissions du channel)."
            : res.status === 404
              ? "Channel introuvable, ou le bot n’est pas dans ce serveur."
              : `Création refusée : ${res.error}`,
        );
        return;
      }
      setWebhookUrl(res.webhookUrl);
    } catch (err) {
      setWebhookError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingWebhook(false);
    }
  }

  return (
    <div className="p-3 border border-slate-700 rounded bg-slate-950/40 text-slate-100">
      <h3 className="text-sm font-semibold text-slate-200 mb-1">Discord (optionnel)</h3>
      <p className="text-[11px] leading-snug text-slate-400 mb-3">
        Active soit les <strong>notifications système</strong> (webhook), soit la{' '}
        <strong>conversation bidirectionnelle</strong> (bot + channel), ou les deux.
      </p>

      <Step
        n={1}
        title="Crée l’application Discord"
        body={
          <>
            <p className="text-[11px] leading-snug text-slate-400 mb-2">
              Developer Portal → <em>New Application</em> → onglet <em>Bot</em> →{' '}
              <em>Reset Token</em> → copie le token.
            </p>
            <a
              href="https://discord.com/developers/applications"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-xs px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-100"
            >
              Ouvrir le Developer Portal ↗
            </a>
          </>
        }
      />

      <Step
        n={2}
        title="Colle et valide le token"
        body={
          <>
            <input
              className={inputCls}
              type="password"
              autoComplete="off"
              placeholder="MTAxxxxxxxxxxxxxxxxx.xxxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              value={botToken}
              onChange={(e) => {
                setBotToken(e.target.value);
                setValidatedBot(null);
                setValidateError(null);
              }}
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void validateToken()}
                disabled={validating || !botToken.trim()}
                className="text-xs px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-100"
              >
                {validating ? 'Validation…' : 'Valider le token'}
              </button>
              {validatedBot && (
                <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
                  {validatedBot.avatar && (
                    <img
                      alt=""
                      src={`https://cdn.discordapp.com/avatars/${validatedBot.id}/${validatedBot.avatar}.png?size=32`}
                      className="w-4 h-4 rounded-full"
                    />
                  )}
                  ✓ Connecté en tant que {validatedBot.username}
                </span>
              )}
            </div>
            {validateError && (
              <p className="mt-1 text-[11px] text-red-400 break-words">{validateError}</p>
            )}
          </>
        }
      />

      {validatedBot && (
        <Step
          n={3}
          title="Invite le bot dans ton serveur"
          body={
            <>
              <p className="text-[11px] leading-snug text-slate-400 mb-2">
                L’URL d’invitation OAuth ci-dessous donne au bot les permissions minimum
                (lire/écrire dans un channel + créer des webhooks).
              </p>
              <InviteUrl botId={validatedBot.id} />
            </>
          }
        />
      )}

      <Step
        n={4}
        title="Channel ID (pour la conversation bidirectionnelle)"
        body={
          <>
            <input
              className={inputCls}
              type="text"
              inputMode="numeric"
              pattern="\d{17,20}"
              placeholder="ex. 1234567890123456789"
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
            />
            <p className="mt-1 text-[11px] leading-snug text-slate-400">
              Active <em>Developer Mode</em> (Discord → Paramètres → Avancés), clic droit sur le
              channel → <em>Copy Channel ID</em>. Sans channel ID, le bot ne reçoit rien.
            </p>
          </>
        }
      />

      <Step
        n={5}
        title="Webhook URL (notifications système)"
        body={
          <>
            <input
              className={inputCls}
              type="url"
              placeholder="https://discord.com/api/webhooks/…"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
            />
            <p className="mt-1 text-[11px] leading-snug text-slate-400">
              Optionnel. Si tu as déjà un webhook, colle l’URL. Sinon, une fois le bot invité
              (étape 3) et le channel ID renseigné (étape 4), génère-le en un clic :
            </p>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void createWebhook()}
                disabled={
                  creatingWebhook ||
                  !validatedBot ||
                  !channelId.trim() ||
                  !botToken.trim()
                }
                title={
                  !validatedBot
                    ? 'Valide d’abord le token (étape 2)'
                    : !channelId.trim()
                      ? 'Renseigne d’abord le channel ID (étape 4)'
                      : ''
                }
                className="text-xs px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-100"
              >
                {creatingWebhook ? 'Création…' : 'Créer le webhook auto'}
              </button>
            </div>
            {webhookError && (
              <p className="mt-1 text-[11px] text-red-400 break-words">{webhookError}</p>
            )}
          </>
        }
      />
    </div>
  );
}

function Step({
  n,
  title,
  body,
}: {
  n: number;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div className="mt-3 pl-6 relative">
      <span className="absolute left-0 top-0 w-5 h-5 rounded-full bg-slate-700 text-[11px] text-slate-100 flex items-center justify-center">
        {n}
      </span>
      <div className="text-xs font-medium text-slate-200 mb-1">{title}</div>
      {body}
    </div>
  );
}

function InviteUrl({ botId }: { botId: string }) {
  const url = `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(botId)}&permissions=${OAUTH_PERMISSIONS}&scope=bot`;
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <code className="text-[10px] text-slate-400 break-all bg-slate-950 border border-slate-800 rounded px-2 py-1">
        {url}
      </code>
      <div className="flex gap-2">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-100"
        >
          Ouvrir l’invitation ↗
        </a>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(url).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="text-xs px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-100"
        >
          {copied ? '✓ Copié' : 'Copier l’URL'}
        </button>
      </div>
    </div>
  );
}

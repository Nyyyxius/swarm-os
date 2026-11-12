/**
 * Discord REST helpers used by the role onboarding flow.
 *
 * Two operations only:
 *   - `validateBotToken`: confirms a freshly-pasted bot token actually
 *     authenticates against `GET /users/@me`, and returns the bot user's
 *     identity (id, username, avatar) so the UI can show a connection
 *     badge and build the OAuth invite URL.
 *   - `createChannelWebhook`: once the bot is in the guild and has the
 *     `Manage Webhooks` permission, asks Discord to create a webhook on
 *     a channel and returns the resulting URL. Saves the operator from
 *     having to dig through *Server Settings → Integrations → Webhooks*.
 *
 * Both wrap `fetch` with a bounded timeout. `fetchImpl` is injectable so
 * the unit tests can mock without hitting the network.
 */

import { withModule } from '../../logger.js';

const log = withModule('discord-portal');

const DEFAULT_TIMEOUT_MS = 5000;
const DISCORD_API = 'https://discord.com/api/v10';

export interface DiscordBotIdentity {
  id: string;
  username: string;
  discriminator?: string;
  avatar: string | null;
}

export interface ValidateOk {
  ok: true;
  bot: DiscordBotIdentity;
}

export interface DiscordError {
  ok: false;
  status: number;
  error: string;
}

export type ValidateResult = ValidateOk | DiscordError;

export interface CreateWebhookOk {
  ok: true;
  webhookUrl: string;
  id: string;
}

export type CreateWebhookResult = CreateWebhookOk | DiscordError;

export interface PortalOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function withTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  return fetchImpl(url, { ...init, signal: ac.signal }).finally(() => clearTimeout(timer));
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    if (body && typeof body.message === 'string') return body.message;
  } catch {
    /* not JSON — fall through */
  }
  return `HTTP ${res.status}`;
}

export async function validateBotToken(
  token: string,
  opts: PortalOptions = {},
): Promise<ValidateResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const res = await withTimeout(
      fetchImpl,
      `${DISCORD_API}/users/@me`,
      {
        method: 'GET',
        headers: { Authorization: `Bot ${token}` },
      },
      timeoutMs,
    );
    if (!res.ok) {
      const error = await readError(res);
      log.info({ event: 'portal.validate.bad_status', status: res.status });
      return { ok: false, status: res.status, error };
    }
    const data = (await res.json()) as {
      id: string;
      username: string;
      discriminator?: string;
      avatar: string | null;
    };
    return {
      ok: true,
      bot: {
        id: data.id,
        username: data.username,
        discriminator: data.discriminator,
        avatar: data.avatar ?? null,
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn({ event: 'portal.validate.failed', error });
    return { ok: false, status: 0, error };
  }
}

export interface CreateWebhookInput {
  token: string;
  channelId: string;
  name?: string;
}

export async function createChannelWebhook(
  input: CreateWebhookInput,
  opts: PortalOptions = {},
): Promise<CreateWebhookResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const name = (input.name ?? 'swarm-os notifications').slice(0, 80);
  try {
    const res = await withTimeout(
      fetchImpl,
      `${DISCORD_API}/channels/${encodeURIComponent(input.channelId)}/webhooks`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bot ${input.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name }),
      },
      timeoutMs,
    );
    if (!res.ok) {
      const error = await readError(res);
      log.info({ event: 'portal.webhook.bad_status', status: res.status });
      return { ok: false, status: res.status, error };
    }
    const data = (await res.json()) as { id: string; token: string };
    if (!data.id || !data.token) {
      return { ok: false, status: 500, error: 'malformed Discord response' };
    }
    return {
      ok: true,
      id: data.id,
      webhookUrl: `https://discord.com/api/webhooks/${data.id}/${data.token}`,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn({ event: 'portal.webhook.failed', error });
    return { ok: false, status: 0, error };
  }
}

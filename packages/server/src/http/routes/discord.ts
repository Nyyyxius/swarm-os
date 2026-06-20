/**
 * Discord onboarding endpoints — used by the role modal to (a) validate a
 * freshly-pasted bot token by hitting `GET /users/@me`, and (b) auto-create
 * a channel webhook so the operator does not have to dig through Discord's
 * server settings.
 *
 * Both routes are thin proxies over `modules/discord/portal.ts`. They exist
 * server-side rather than client-side because the browser cannot hit
 * `discord.com/api` directly (CORS) and because the bot token must never
 * be exposed in the SPA fetch headers.
 *
 * Tokens are NEVER logged here — only HTTP status and the bot user id on
 * success, which is already public (it appears in every message Discord
 * routes).
 */

import { Router, type Request, type Response } from 'express';
import { validateBotToken, createChannelWebhook } from '../../modules/discord/portal.js';
import { withModule } from '../../logger.js';

const log = withModule('http-discord');

const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;
const DISCORD_BOT_TOKEN_MAX = 256;

interface ValidateBody {
  token?: unknown;
}

interface CreateWebhookBody {
  token?: unknown;
  channelId?: unknown;
  name?: unknown;
}

export function createDiscordRouter(): Router {
  const router = Router();

  router.post('/api/discord/validate-token', async (req: Request, res: Response) => {
    const body = req.body as ValidateBody;
    if (typeof body?.token !== 'string' || body.token.length === 0) {
      res.status(400).json({ ok: false, error: 'token must be a non-empty string' });
      return;
    }
    if (body.token.length > DISCORD_BOT_TOKEN_MAX) {
      res.status(400).json({ ok: false, error: 'token is too long' });
      return;
    }
    const result = await validateBotToken(body.token);
    if (!result.ok) {
      log.info({ event: 'discord.validate.fail', status: result.status });
      res.json({ ok: false, status: result.status, error: result.error });
      return;
    }
    log.info({ event: 'discord.validate.ok', botId: result.bot.id });
    res.json({ ok: true, bot: result.bot });
  });

  router.post('/api/discord/create-webhook', async (req: Request, res: Response) => {
    const body = req.body as CreateWebhookBody;
    if (typeof body?.token !== 'string' || body.token.length === 0) {
      res.status(400).json({ ok: false, error: 'token must be a non-empty string' });
      return;
    }
    if (body.token.length > DISCORD_BOT_TOKEN_MAX) {
      res.status(400).json({ ok: false, error: 'token is too long' });
      return;
    }
    if (typeof body.channelId !== 'string' || !DISCORD_SNOWFLAKE_RE.test(body.channelId)) {
      res.status(400).json({ ok: false, error: 'channelId must be a Discord snowflake (17–20 digits)' });
      return;
    }
    const name = typeof body.name === 'string' && body.name.length > 0 ? body.name : undefined;
    const result = await createChannelWebhook({ token: body.token, channelId: body.channelId, name });
    if (!result.ok) {
      log.info({ event: 'discord.webhook.fail', status: result.status });
      res.json({ ok: false, status: result.status, error: result.error });
      return;
    }
    log.info({ event: 'discord.webhook.ok', webhookId: result.id });
    res.json({ ok: true, webhookUrl: result.webhookUrl });
  });

  return router;
}

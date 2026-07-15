/**
 * Phase 4 — structured logging via `pino`.
 *
 * Replaces the ad-hoc `console.log(JSON.stringify({...}))` and
 * `console.error(...)` patterns inherited from Phases 1–3.
 *
 * Important invariants (plan §14, §15):
 *
 *  - Output goes to **stdout only**. `docker logs` is the rotation strategy
 *    (Phase 5). No file rotation in MVP.
 *  - **Redaction** is configured for fields that hold or look like secrets:
 *    `token`, `session_secret`/`sessionSecret`, `Authorization`/`authorization`,
 *    `X-Auth-Token`/`x-auth-token`/`xAuthToken`, `webhookUrl`, `discordWebhookUrl`.
 *  - **Mailbox bodies are never logged**. The audit lines emitted by
 *    `messaging.ts` already exclude `content` and only carry `len`/`queueSize`.
 *    The redact list is a defence-in-depth backstop in case a future caller
 *    forgets and includes `body`/`content` — those keys are NOT in the redact
 *    list deliberately, since `body` is also a legitimate Express-related key.
 *    We rely on per-call discipline + this comment to enforce.
 *  - In dev (TTY + non-prod), pretty-prints via `pino-pretty` for readability.
 *    Production stays JSON.
 *
 * Usage pattern:
 *
 *   import { rootLogger, withModule } from './logger.js';
 *   const log = withModule('mcp');
 *   log.info({ event: 'mcp.listen', host, port });
 *   log.warn({ event: 'mail.dropped', to, evictedId });
 */

import pino, { type Logger, type LoggerOptions } from 'pino';
import type { Config } from './config.js';

let _root: Logger | null = null;

const REDACT_PATHS = [
  // User token (X-Auth-Token).
  'token',
  '*.token',
  '*.*.token',
  // Hook token (Authorization: Bearer ...).
  'hookToken',
  '*.hookToken',
  // MCP per-session secret.
  'session_secret',
  'sessionSecret',
  '*.session_secret',
  '*.sessionSecret',
  // HTTP auth headers in any shape.
  'Authorization',
  'authorization',
  '*.Authorization',
  '*.authorization',
  'X-Auth-Token',
  'x-auth-token',
  'xAuthToken',
  '*.X-Auth-Token',
  '*.x-auth-token',
  '*.xAuthToken',
  // Discord webhook URL — pseudo-secret (anyone with it can post).
  'webhookUrl',
  'discordWebhookUrl',
  '*.webhookUrl',
  '*.discordWebhookUrl',
  // Discord bot token — full account credential. Held per-role on the
  // `DiscordConnector.botToken` field; pino redact walks objects by key,
  // so the wildcard catches it wherever the connector is logged.
  'botToken',
  '*.botToken',
  // Plugin config blob — may hold plugin secrets (API tokens etc.) declared
  // via a `format:'password'` field. Redacted wherever a plugin row is logged.
  'config_json',
  '*.config_json',
];

export function buildLogger(config?: Pick<Config, 'logLevel' | 'logPretty' | 'projectName'>): Logger {
  const opts: LoggerOptions = {
    level: config?.logLevel ?? 'info',
    base: {
      pid: process.pid,
      project: config?.projectName,
    },
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  if (config?.logPretty) {
    return pino({
      ...opts,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
    });
  }
  // We pass `process.stdout` explicitly (instead of letting pino default to
  // sonic-boom on fd 1) so tests can intercept by spying on
  // `process.stdout.write`. Production uses the same stream — `docker logs`
  // captures stdout regardless.
  return pino(opts, process.stdout);
}

/**
 * The shared root logger. Initialise once at boot via `initRootLogger(config)`,
 * then call `withModule(name)` to derive a child with `{ module: name }`.
 *
 * Modules called BEFORE `initRootLogger` get a default `info`-level JSON logger;
 * config-driven settings only apply post-init.
 */
export function initRootLogger(config: Config): Logger {
  _root = buildLogger(config);
  return _root;
}

export function rootLogger(): Logger {
  if (!_root) {
    _root = buildLogger();
  }
  return _root;
}

/** Derive a child logger tagged with a module name. */
export function withModule(name: string): Logger {
  return rootLogger().child({ module: name });
}

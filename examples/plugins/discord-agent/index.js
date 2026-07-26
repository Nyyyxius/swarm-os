// discord-agent — connect one Discord channel (text + voice clips) to a
// permanent swarm lead agent. Hybrid architecture: a marker connector wires the
// inbound path (host -> subscribeOrch), while this plugin owns the discord.js
// Gateway and the outbound reply tool.
//
//   Inbound  : Discord message -> allowlist -> (voice) OpenAI Whisper STT ->
//              lead inbox (structured `source:discord`), at-most-once via a kv
//              cursor.
//   Outbound : lead calls `discord-agent.reply` -> text (chunked) or a native
//              Discord voice message (OpenAI TTS -> OGG/Opus, raw REST).
//
// Pure ESM, Node 24 globals (fetch/FormData/Blob), single dep discord.js. No
// event callback ever throws (they are not host-guarded); the reply handler
// returns { ok:false, error } on any failure (a throw is charged to quarantine).
//
// @typedef {import('@swarm-os/plugin-sdk').SwarmPlugin} SwarmPlugin
// @typedef {import('@swarm-os/plugin-sdk').SwarmPluginApi} SwarmPluginApi
// @typedef {import('@swarm-os/plugin-sdk').PluginOrchSubscription} PluginOrchSubscription

/**
 * Parsed, static-per-activation plugin configuration.
 * @typedef {object} DiscordAgentConfig
 * @property {string} botToken
 * @property {string} channelId
 * @property {string} openaiApiKey
 * @property {Set<string>} allowedUserIds
 * @property {string} leadModel
 * @property {string} ttsVoice
 * @property {string} ttsModel
 * @property {string} sttModel
 * @property {string} language
 * @property {string} workDir
 */

/**
 * The gateway handle owned by lib/gateway.js.
 * @typedef {object} Gateway
 * @property {() => boolean} isReady
 * @property {() => Promise<void>} start
 * @property {() => Promise<void>} destroy
 * @property {() => Promise<void>} pump
 * @property {() => void} schedulePump
 */

/**
 * Shared per-activation runtime handed to every lib module.
 * @typedef {object} Runtime
 * @property {SwarmPluginApi} api
 * @property {import('@swarm-os/plugin-sdk').Logger} log
 * @property {DiscordAgentConfig} cfg
 * @property {any} client                       discord.js Client (set by gateway)
 * @property {Gateway|null} gateway
 * @property {{ orchId: string, sub: PluginOrchSubscription }|null} binding
 * @property {Promise<void>|null} ensureTeamPromise
 * @property {Promise<void>} pumpChain          serialises catch-up runs
 * @property {any} loginTimer
 */

import { ensureRole } from './lib/provision.js';
import { createGateway } from './lib/gateway.js';
import { createConnectorProvider } from './lib/connector.js';
import { buildReplyToolDef } from './lib/reply.js';
import { buildStatusRouter } from './lib/status.js';

/** @type {Runtime|null} — module scope is per-activation (ESM cache-buster). */
let runtime = null;

/**
 * @param {SwarmPluginApi} api
 * @returns {DiscordAgentConfig}
 */
function parseConfig(api) {
  const raw = /** @type {Record<string, unknown>} */ (api.config.get() || {});
  const str = (k, d = '') => (typeof raw[k] === 'string' ? /** @type {string} */ (raw[k]) : d);
  const allowedUserIds = new Set(
    str('allowedUserIds')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return {
    botToken: str('botToken'),
    channelId: str('channelId'),
    openaiApiKey: str('openaiApiKey'),
    allowedUserIds,
    leadModel: str('leadModel', 'claude-opus-4-8[1m]'),
    ttsVoice: str('ttsVoice', 'alloy'),
    ttsModel: str('ttsModel', 'gpt-4o-mini-tts'),
    sttModel: str('sttModel', 'whisper-1'),
    language: str('language', 'fr'),
    workDir: str('workDir', 'discord-agent'),
  };
}

/** @type {SwarmPlugin} */
const plugin = {
  /** @param {SwarmPluginApi} api */
  async activate(api) {
    const cfg = parseConfig(api);
    /** @type {Runtime} */
    const rt = {
      api,
      log: api.log,
      cfg,
      client: null,
      gateway: null,
      binding: null,
      ensureTeamPromise: null,
      pumpChain: Promise.resolve(),
      loginTimer: null,
    };
    runtime = rt;

    // Always expose /status so the operator can diagnose even an incomplete config.
    api.http.registerRouter(buildStatusRouter(rt));

    // Incomplete config: log + surface on /status, never throw or connect.
    if (!cfg.botToken || !cfg.channelId || !cfg.openaiApiKey) {
      api.log.warn(
        { event: 'discord-agent.not_configured' },
        'discord-agent: configuration incomplete — set botToken/channelId/openaiApiKey (waiting)',
      );
      return;
    }

    // Outbound reply tool (lead-only + team-guarded inside the handler).
    api.mcp.registerTool(buildReplyToolDef(rt));

    // Marker connector — the host wires subscribeOrch at create/resume/retro-wire.
    api.connectors.register('discord-agent', createConnectorProvider(rt));

    // Idempotent role (a DB row; safe to touch before the boot auto-resume).
    try {
      ensureRole(rt);
    } catch (err) {
      api.log.warn(
        { event: 'discord-agent.ensure_role_failed', error: String(err) },
        'discord-agent ensureRole failed',
      );
    }

    // Gateway: log in the BACKGROUND (activate has a ~10s budget; login is 15s).
    createGateway(rt);
    void rt.gateway?.start();

    api.log.info({ event: 'discord-agent.activated' }, 'discord-agent activated');
  },

  async deactivate() {
    const rt = runtime;
    runtime = null;
    if (!rt) return;
    // Detach handlers synchronously then race client.destroy() (inside destroy),
    // closing any double-Gateway window on a reload.
    if (rt.gateway) {
      try {
        await rt.gateway.destroy();
      } catch (err) {
        rt.log.warn(
          { event: 'discord-agent.deactivate_error', error: String(err) },
          'discord-agent deactivate failed',
        );
      }
    }
  },
};

export default plugin;

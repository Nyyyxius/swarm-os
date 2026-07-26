// status.js — GET /plugin-api/discord-agent/status (authenticated JSON).
//
// A read-only operator diagnostic: gateway readiness, current binding, team/role
// ids, the catch-up cursor, allowlist posture (fail-closed when empty), the
// preamble version in effect, early-death counters, and setup hints (privileged
// MessageContent intent, Discord permissions). A rich HTML panel is v1.1.

import { PREAMBLE_VERSION } from './preamble.js';

/**
 * @param {import('../index.js').Runtime} rt
 * @returns {import('@swarm-os/plugin-sdk').Router}
 */
export function buildStatusRouter(rt) {
  const router = rt.api.http.createRouter();
  router.get('/status', (_req, res) => {
    try {
      const kv = rt.api.storage.kv;
      const cfg = rt.cfg;
      const configured = Boolean(cfg.botToken && cfg.channelId && cfg.openaiApiKey);
      const allowlistCount = cfg.allowedUserIds.size;

      const hints = [];
      if (!configured) {
        hints.push('Configuration incomplete: renseigner botToken, channelId et openaiApiKey.');
      }
      if (allowlistCount === 0) {
        hints.push('FAIL-CLOSED: allowedUserIds vide -> tous les messages Discord sont ignores.');
      }
      hints.push("Portail Discord: activer l'intent PRIVILEGIE MessageContent (sinon message.content est vide).");
      hints.push('Permissions du bot requises: Read Message History, Send Messages, Send Voice Messages.');

      res.json({
        ok: true,
        plugin: 'discord-agent',
        configured,
        gateway: { ready: rt.gateway ? rt.gateway.isReady() : false },
        binding: rt.binding ? { orchestratorId: rt.binding.orchId } : null,
        teamId: kv.get('teamId') || null,
        roleId: kv.get('roleId') || null,
        cursor: kv.get('lastProcessedMessageId') || null,
        lastInbound: safeJson(kv.get('last_inbound')),
        allowlist: { count: allowlistCount, failClosed: allowlistCount === 0 },
        preamble: {
          version: PREAMBLE_VERSION,
          applied: kv.get('preambleVersion') || null,
        },
        leadModel: cfg.leadModel,
        earlyDeaths: Number(kv.get('earlyDeathCount') || '0'),
        backoffUntil: kv.get('backoffUntil') || null,
        channelId: cfg.channelId || null,
        hints,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
  return router;
}

function safeJson(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

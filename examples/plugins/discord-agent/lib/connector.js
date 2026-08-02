// connector.js — the `discord-agent` channel connector provider.
//
// A MARKER connector: it declares no schema and ignores the connector config
// entirely (the real config lives in the plugin config, read at activate). Its
// job is purely wiring: the host calls `subscribeOrch` at team create / resume /
// retro-wire, handing us the `PluginOrchSubscription` whose `pushToLeadInbox`
// carries structured `source` metadata into the lead's inbox. We record it as the
// single active binding and kick a cursor catch-up so any messages that arrived
// while unbound are delivered in order.
//
// @typedef {import('@swarm-os/plugin-sdk').ChannelConnectorProvider} ChannelConnectorProvider
// @typedef {import('@swarm-os/plugin-sdk').PluginOrchSubscription} PluginOrchSubscription

import { sendText } from './reply.js';
import { reactSafe } from './gateway.js';

/** The three approval reactions, pre-seeded in this order: approve, approve+dontAskAgain, deny. */
const APPROVAL_REACTIONS = ['✅', '♾️', '❌'];

/**
 * @param {import('../index.js').Runtime} rt
 * @returns {ChannelConnectorProvider}
 */
export function createConnectorProvider(rt) {
  return {
    /**
     * @param {Record<string, unknown>} _config
     * @param {PluginOrchSubscription} sub
     */
    async subscribeOrch(_config, sub) {
      rt.binding = { orchId: sub.orchestratorId, sub };
      // Keep the reply-tool guard in sync with the currently-bound orch (covers
      // heal/recreate where ensureTeam mints a fresh id, and resume where the id
      // is preserved).
      rt.api.storage.kv.set('teamId', sub.orchestratorId);
      rt.log.info(
        { event: 'discord-agent.subscribed', orchId: sub.orchestratorId },
        'discord-agent connector bound',
      );
      // Deliver anything queued since the cursor (boot backlog, unbound window).
      // Scheduled (not awaited) so we never block the host wiring path.
      if (rt.gateway) rt.gateway.schedulePump();
    },

    /**
     * P5 — outbound seam used by the server's approval hook
     * (modules/approvals/discord-notify.ts) to post the "approval requested"
     * message THROUGH the plugin's Gateway and return the posted message id, so
     * a later native reply to it can be routed back to the approval. Additive
     * and fail-safe: returns null (never throws) when this orch isn't the bound
     * one, the gateway isn't ready, or the send yields no id — the server then
     * silently falls back to its bot/webhook path.
     *
     * @param {string} orchId
     * @param {string} text
     * @returns {Promise<{ messageId: string } | null>}
     */
    async sendToOrchChannel(orchId, text) {
      try {
        if (!rt.binding || rt.binding.orchId !== orchId) return null;
        if (!rt.gateway || !rt.gateway.isReady()) return null;
        if (!rt.cfg.channelId) return null;
        const res = await sendText(rt, rt.cfg.channelId, text, undefined);
        const id = res && res.ok && Array.isArray(res.message_ids) ? res.message_ids[0] : undefined;
        if (!id) return null;
        rt.log.info(
          { event: 'discord-agent.approval_posted', orchId, messageId: id },
          'discord-agent posted approval request to channel',
        );
        // P5: pre-seed the three decision reactions under the card so the operator
        // resolves with a single click. Fail-safe: reactSafe never throws, and the
        // approval is already posted+correlated regardless of whether these land.
        // Awaited (not fire-and-forget) so they appear in a deterministic order.
        const card = res.messages && res.messages.length > 0 ? res.messages[0] : null;
        if (card) {
          for (const emoji of APPROVAL_REACTIONS) {
            await reactSafe(card, emoji);
          }
        }
        return { messageId: id };
      } catch (err) {
        rt.log.warn(
          { event: 'discord-agent.approval_post_failed', orchId, error: String(err) },
          'discord-agent approval post failed (server falls back)',
        );
        return null;
      }
    },

    /** @param {string} orchId */
    async unsubscribeOrch(orchId) {
      if (rt.binding && rt.binding.orchId === orchId) {
        rt.binding = null;
        rt.log.info(
          { event: 'discord-agent.unsubscribed', orchId },
          'discord-agent connector unbound',
        );
      }
    },

    async stopAll() {
      rt.binding = null;
    },
  };
}

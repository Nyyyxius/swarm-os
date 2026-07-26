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

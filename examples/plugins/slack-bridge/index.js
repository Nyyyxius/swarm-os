/**
 * slack-bridge — a swarm-os channel connector for Slack over Socket Mode.
 *
 * Socket Mode means swarm-os opens an OUTBOUND WebSocket to Slack, so no public
 * URL / inbound webhook is required — the connector works behind NAT, exactly
 * like the built-in Discord Gateway bridge.
 *
 * Flow:
 *   - Inbound  (Slack → lead inbox): every human `message` in the configured
 *     channel is pushed into the orchestrator lead's inbox via
 *     `sub.pushToLeadInbox`. Bot/app messages are dropped by default (loop
 *     guard) unless the plugin's `includeBotMessages` config is on.
 *   - Outbound (lead → Slack): the lead calls the `slack.send` MCP tool, which
 *     posts to the orchestrator's bound channel via the Slack Web API.
 *
 * This example is INTENTIONALLY simple: it opens one Socket Mode connection per
 * subscribed orchestrator. A production bridge would pool connections by app
 * token (like the built-in Discord pool) — kept single-per-orch here for
 * readability.
 *
 * Types come from `@swarm-os/plugin-sdk` (devDependency only — no runtime dep).
 * @typedef {import('@swarm-os/plugin-sdk').SwarmPlugin} SwarmPlugin
 * @typedef {import('@swarm-os/plugin-sdk').SwarmPluginApi} SwarmPluginApi
 * @typedef {import('@swarm-os/plugin-sdk').ChannelConnectorProvider} ChannelConnectorProvider
 * @typedef {import('@swarm-os/plugin-sdk').PluginOrchSubscription} PluginOrchSubscription
 */

import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';

/**
 * Live Slack bindings keyed by orchestrator id. Module-scoped so the outbound
 * MCP tool can resolve the Web client + channel for the calling orchestrator.
 * @type {Map<string, { socket: SocketModeClient, web: WebClient, channel: string }>}
 */
const bindings = new Map();

/** @param {unknown} v */
function asString(v) {
  return typeof v === 'string' ? v : '';
}

/** @implements {ChannelConnectorProvider} */
class SlackConnectorProvider {
  /**
   * @param {SwarmPluginApi} api
   * @param {() => boolean} includeBotMessages
   */
  constructor(api, includeBotMessages) {
    this.api = api;
    this.includeBotMessages = includeBotMessages;
  }

  /**
   * @param {Record<string, unknown>} config
   * @param {PluginOrchSubscription} sub
   */
  async subscribeOrch(config, sub) {
    const appToken = asString(config.appToken);
    const botToken = asString(config.botToken);
    const channel = asString(config.channel);
    if (!appToken || !botToken || !channel) {
      this.api.log.warn(
        { event: 'slack.subscribe_skipped', orchId: sub.orchestratorId },
        'slack connector missing appToken/botToken/channel',
      );
      return;
    }

    // Replace any prior binding for this orch (idempotent re-subscribe).
    await this.unsubscribeOrch(sub.orchestratorId);

    const web = new WebClient(botToken);
    const socket = new SocketModeClient({ appToken });

    socket.on('message', async ({ event, ack }) => {
      // Socket Mode requires an ack for every envelope.
      try {
        await ack();
      } catch {
        /* best-effort ack */
      }
      if (!event || typeof event !== 'object') return;
      const ev = /** @type {Record<string, unknown>} */ (event);
      if (asString(ev.channel) !== channel) return;
      // Drop message edits/deletes and our own/other bot posts (loop guard).
      if (ev.subtype != null && ev.subtype !== 'thread_broadcast') return;
      if (!this.includeBotMessages() && (ev.bot_id != null || ev.app_id != null)) return;
      const text = asString(ev.text);
      if (!text) return;
      const user = asString(ev.user) || 'unknown';
      const threadTs = asString(ev.thread_ts) || undefined;
      sub.pushToLeadInbox(text, {
        from: `slack:${user}`,
        sourceKind: 'slack',
        sourceMessageId: asString(ev.ts) || undefined,
        threadId: threadTs,
      });
    });

    await socket.start();
    bindings.set(sub.orchestratorId, { socket, web, channel });
    this.api.log.info(
      { event: 'slack.subscribed', orchId: sub.orchestratorId, channel },
      'slack socket mode connected',
    );
  }

  /** @param {string} orchId */
  async unsubscribeOrch(orchId) {
    const b = bindings.get(orchId);
    if (!b) return;
    bindings.delete(orchId);
    try {
      await b.socket.disconnect();
    } catch (err) {
      this.api.log.warn(
        { event: 'slack.disconnect_failed', orchId, error: String(err) },
        'slack socket disconnect failed',
      );
    }
  }

  async stopAll() {
    const orchIds = [...bindings.keys()];
    for (const orchId of orchIds) {
      await this.unsubscribeOrch(orchId);
    }
  }
}

/** @type {SwarmPlugin} */
const plugin = {
  /** @param {SwarmPluginApi} api */
  activate(api) {
    const cfg = api.config.get();
    const includeBotMessages = () =>
      Boolean(/** @type {Record<string, unknown>} */ (api.config.get()).includeBotMessages);

    const provider = new SlackConnectorProvider(api, includeBotMessages);
    api.connectors.register('slack', provider);

    // Outbound: lead → Slack. Lead-only; posts to the orchestrator's bound channel.
    const z = api.zod;
    api.mcp.registerTool({
      name: 'send',
      title: 'Post to Slack',
      description:
        "Lead-only. Posts `text` to the Slack channel bound to this orchestrator's role connector. Use the thread_ts from an inbound message's source to reply in-thread.",
      leadOnly: true,
      inputSchema: {
        text: z.string().min(1).max(3900),
        thread_ts: z.string().optional(),
      },
      outputSchema: { ok: z.boolean(), ts: z.string().optional() },
      async handler(args, ctx) {
        const b = bindings.get(ctx.orchestratorId);
        if (!b) {
          return { ok: false };
        }
        const res = await b.web.chat.postMessage({
          channel: b.channel,
          text: String(args.text ?? ''),
          ...(typeof args.thread_ts === 'string' ? { thread_ts: args.thread_ts } : {}),
        });
        return { ok: Boolean(res.ok), ts: typeof res.ts === 'string' ? res.ts : undefined };
      },
    });

    api.log.info({ event: 'slack.activated', includeBotMessages: includeBotMessages() }, 'slack-bridge ready');
    void cfg;
  },
};

export default plugin;

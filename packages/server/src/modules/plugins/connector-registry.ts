/**
 * ConnectorRegistry — channel connectors exposed to roles (plan §J4).
 *
 * A *connector* binds an orchestrator's lead to an external channel (Discord,
 * Slack, …): inbound platform messages land in the lead's inbox, and the lead
 * writes back through whatever outbound path the connector provides. J1–J3
 * shipped one hard-wired connector type (`discord`); J4 turns that into a
 * pluggable surface.
 *
 * Like the MCP-tool and HTTP registries, this is a mutable `Map<type,
 * provider>` consulted at wire time by `Spawner.wireConnectors`. Enable/disable
 * of a plugin that provides a connector type is a Map mutation:
 *   - `register(type, provider, meta)` adds the provider AND retro-wires every
 *     already-live orchestrator whose role carries that type (red-team I1).
 *   - the returned `Disposable` removes it AND calls `provider.stopAll()` so a
 *     disabled plugin leaves no dangling subscriptions.
 *
 * The built-in `discord` provider (below) wraps the existing `DiscordBotPool`
 * unchanged — the pool/bot internals and their unit tests are untouched.
 */

import type { Mailbox } from '../orchestrator/mailbox.js';
import type { DiscordBotPool } from '../discord/pool.js';
import type { PluginConfigSchema } from './config-schema.js';
import type {
  ChannelConnectorProvider,
  Disposable,
  PluginOrchSubscription,
} from './api-types.js';
import { withModule } from '../../logger.js';

const log = withModule('plugins.connectors');

/** Metadata surfaced to the UI (`GET /connector-types`) for one registered type. */
export interface ConnectorTypeInfo {
  type: string;
  label: string;
  /** Form/validation schema (parsed subset JSON Schema); null when undeclared. */
  schema: PluginConfigSchema | null;
  /** True for the host-provided `discord` connector; false for plugin-provided. */
  builtin: boolean;
}

interface RegisterMeta {
  label: string;
  schema: PluginConfigSchema | null;
  builtin?: boolean;
}

interface Registered {
  provider: ChannelConnectorProvider;
  info: ConnectorTypeInfo;
}

export class ConnectorRegistry {
  private readonly providers = new Map<string, Registered>();
  /**
   * Set once by the Spawner. When a provider is registered late (a plugin
   * enabled while teams are already running), this callback wires the existing
   * orchestrators of matching roles (red-team I1). Kept as a single hook rather
   * than an event emitter — there is exactly one consumer (the Spawner).
   */
  private retroactiveWirer?: (type: string) => void;

  setRetroactiveWirer(cb: (type: string) => void): void {
    this.retroactiveWirer = cb;
  }

  /**
   * Register `provider` under `type`. Returns a `Disposable` that removes it and
   * tears down its subscriptions (`stopAll`). A built-in type cannot be shadowed
   * by a plugin (the override throws so the plugin's enable fails cleanly).
   */
  register(
    type: string,
    provider: ChannelConnectorProvider,
    meta: RegisterMeta,
  ): Disposable {
    const existing = this.providers.get(type);
    if (existing?.info.builtin) {
      throw new Error(`connector type '${type}' is reserved by a built-in provider`);
    }
    const entry: Registered = {
      provider,
      info: {
        type,
        label: meta.label,
        schema: meta.schema,
        builtin: meta.builtin ?? false,
      },
    };
    this.providers.set(type, entry);
    log.info({ event: 'plugins.connector_registered', type, builtin: entry.info.builtin });
    // Retro-wire live orchestrators bound to a role carrying this type. Guarded
    // so a wiring throw can never escape the register() call (24/7 safety).
    try {
      this.retroactiveWirer?.(type);
    } catch (err) {
      log.warn({
        event: 'plugins.connector_retro_wire_failed',
        type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return {
      dispose: () => {
        // Only remove if still OUR entry (a re-register may have swapped it).
        const cur = this.providers.get(type);
        if (cur !== entry) return;
        this.providers.delete(type);
        log.info({ event: 'plugins.connector_unregistered', type });
        void Promise.resolve()
          .then(() => provider.stopAll())
          .catch((err: unknown) => {
            log.warn({
              event: 'plugins.connector_stop_all_failed',
              type,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      },
    };
  }

  get(type: string): ChannelConnectorProvider | null {
    return this.providers.get(type)?.provider ?? null;
  }

  has(type: string): boolean {
    return this.providers.has(type);
  }

  /** Schema declared for `type` (drives the UI form + role config validation). */
  schemaFor(type: string): PluginConfigSchema | null {
    return this.providers.get(type)?.info.schema ?? null;
  }

  /** Every registered type — the payload of `GET /connector-types`. */
  types(): ConnectorTypeInfo[] {
    return [...this.providers.values()].map((r) => r.info);
  }

  /**
   * Detach `orchId` from EVERY provider (destroy / hide / restart). Each
   * provider ignores an orch it never saw, so a blanket call is cheap and
   * avoids tracking which types an orch was wired to. Best-effort.
   */
  async unsubscribeAll(orchId: string): Promise<void> {
    await Promise.allSettled(
      [...this.providers.values()].map((r) => r.provider.unsubscribeOrch(orchId)),
    );
  }
}

/**
 * Built-in `discord` connector — adapts the generic `ChannelConnectorProvider`
 * surface onto the existing `DiscordBotPool` WITHOUT touching the pool/bot
 * internals. The pool's `OrchSubscription` needs a `Mailbox`; we hand it a shim
 * whose `push` delegates to the generic `sub.pushToLeadInbox` (which itself does
 * `mailbox.push` + `emitMailboxMessage` + idle wake). Because `pushToLeadInbox`
 * already wakes the lead, the pool-side `notifyLead` is a no-op — so the lead is
 * signalled exactly once, matching the pre-J4 single-wake behaviour.
 */
export class DiscordConnectorProvider implements ChannelConnectorProvider {
  constructor(private readonly pool: DiscordBotPool) {}

  async subscribeOrch(
    config: Record<string, unknown>,
    sub: PluginOrchSubscription,
  ): Promise<void> {
    const channelId = typeof config.channelId === 'string' ? config.channelId : undefined;
    const botToken = typeof config.botToken === 'string' ? config.botToken : undefined;
    // Parity with the pre-J4 `wireDiscordBot`: a discord connector with only a
    // webhook (no bot token / channel) opens no Gateway connection.
    if (!channelId || !botToken) return;

    const shimMailbox = {
      push: (
        _leadId: string,
        msg: {
          from: string;
          content: string;
          sourceKind?: string;
          sourceMessageId?: string;
          threadId?: string;
          threadName?: string;
        },
      ): { dropped: boolean; queueSize: number } => {
        sub.pushToLeadInbox(msg.content, {
          from: msg.from,
          sourceKind: msg.sourceKind,
          sourceMessageId: msg.sourceMessageId,
          threadId: msg.threadId,
          threadName: msg.threadName,
        });
        return { dropped: false, queueSize: 0 };
      },
    } as unknown as Mailbox;

    await this.pool.subscribeOrch(botToken, {
      orchestratorId: sub.orchestratorId,
      channelId,
      getLeadSessionId: sub.getLeadSessionId,
      mailbox: shimMailbox,
      // Wake already handled inside `pushToLeadInbox` — avoid a double signal.
      notifyLead: () => {},
    });
  }

  async unsubscribeOrch(orchId: string): Promise<void> {
    await this.pool.unsubscribeOrch(orchId);
  }

  async stopAll(): Promise<void> {
    await this.pool.stopAll();
  }
}

/**
 * Schema for the built-in `discord` connector (drives the UI form + role config
 * validation + password masking). `botToken` is a password field — masked on
 * read, preserved on write when the operator leaves the sentinel untouched.
 * `webhookUrl` is intentionally NOT a password: the read-only role view shows it
 * so operators can confirm which webhook is wired.
 */
export const DISCORD_CONNECTOR_SCHEMA: PluginConfigSchema = {
  type: 'object',
  properties: {
    webhookUrl: {
      type: 'string',
      title: 'Webhook URL',
      description: 'Outbound system notifications (session waiting, orch ended, exit anomaly).',
    },
    channelId: {
      type: 'string',
      title: 'Channel ID',
      description: 'Discord channel snowflake the lead converses in (requires a bot token).',
    },
    botToken: {
      type: 'string',
      format: 'password',
      title: 'Bot Token',
      description: 'Per-role Discord bot OAuth token for the inbound/outbound bridge.',
    },
  },
};

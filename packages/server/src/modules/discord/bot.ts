/**
 * Bidirectional Discord integration for swarm-os.
 *
 * Owns a single `discord.js` Gateway connection and a reverse-map of
 * `channelId → live orchestrator subscriptions`. Boundaries:
 *
 *  - **Inbound** (Discord → lead inbox): every `messageCreate` event for a
 *    subscribed channel is pushed into each matching lead's mailbox via the
 *    existing `Mailbox.push` primitive. Bot/system messages are dropped to
 *    avoid loops.
 *  - **Outbound** (lead → Discord): the MCP tool `discord.send_message`
 *    resolves the orch's role channel and calls `sendMessage()`.
 *
 * Reliability mirrors the webhook notifier: every async path is timeout-
 * bounded (5 s) and never blocks the orchestrator. Login failure at boot
 * leaves the service in a "disabled" state — callers see clean errors,
 * the server keeps running.
 *
 * Per-role: instantiated lazily by `DiscordBotPool` when an orch whose
 * role carries a `botToken` first subscribes. The pool keeps one
 * `DiscordBotService` per distinct token.
 */

import {
  Client,
  GatewayIntentBits,
  type Message,
  type Channel,
} from 'discord.js';
import { withModule } from '../../logger.js';
import type { Mailbox } from '../orchestrator/mailbox.js';

const log = withModule('discord-bot');

const DEFAULT_SEND_TIMEOUT_MS = 5000;
const READY_TIMEOUT_MS = 15_000;

/**
 * One live orchestrator listening on a Discord channel. The lead session id
 * is read lazily because, while the current code does not respawn the lead,
 * the indirection costs nothing and keeps us forward-compatible.
 */
export interface OrchSubscription {
  orchestratorId: string;
  channelId: string;
  getLeadSessionId: () => string | null;
  mailbox: Mailbox;
}

export interface DiscordBotServiceOptions {
  token: string;
  /** For tests — defaults to `DEFAULT_SEND_TIMEOUT_MS`. */
  sendTimeoutMs?: number;
}

export class DiscordBotService {
  private readonly client: Client;
  private readonly token: string;
  private readonly sendTimeoutMs: number;
  /** channelId → subs. A channelId may serve multiple orchs of the same role. */
  private readonly subscriptions = new Map<string, Set<OrchSubscription>>();
  /** Inverse index for O(1) unsubscribe by orchestratorId. */
  private readonly subsByOrch = new Map<string, OrchSubscription>();
  private ready = false;

  constructor(opts: DiscordBotServiceOptions) {
    this.token = opts.token;
    this.sendTimeoutMs = opts.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        // PRIVILEGED — must be enabled in the Discord Developer Portal.
        // Without it, `message.content` is always empty for non-mention
        // messages and the inbound flow appears silently broken.
        GatewayIntentBits.MessageContent,
      ],
    });
  }

  /**
   * Log into Discord and register the `messageCreate` listener. Resolves
   * once the gateway emits `ready`. Throws if login fails or the ready
   * event never fires within `READY_TIMEOUT_MS` — the caller (`index.ts`)
   * catches and logs without crashing the server.
   */
  async start(): Promise<void> {
    this.client.on('messageCreate', (msg) => {
      try {
        this.handleMessageCreate(msg);
      } catch (err) {
        log.warn({
          event: 'discord.bot.handler_error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    this.client.on('error', (err) => {
      log.warn({ event: 'discord.bot.client_error', error: err.message });
    });
    this.client.on('shardError', (err) => {
      log.warn({ event: 'discord.bot.shard_error', error: err.message });
    });
    const readyPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`discord bot did not emit 'ready' within ${READY_TIMEOUT_MS}ms`));
      }, READY_TIMEOUT_MS);
      this.client.once('clientReady', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await this.client.login(this.token);
    await readyPromise;
    this.ready = true;
    log.info({
      event: 'discord.bot.ready',
      botUserId: this.client.user?.id ?? null,
      botUsername: this.client.user?.username ?? null,
    });
  }

  async stop(): Promise<void> {
    this.ready = false;
    try {
      await this.client.destroy();
      log.info({ event: 'discord.bot.stopped' });
    } catch (err) {
      log.warn({
        event: 'discord.bot.stop_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Register an orchestrator for inbound messages on `channelId`. Idempotent
   * on `orchestratorId` — re-subscribing replaces the previous entry.
   */
  subscribeOrchestrator(sub: OrchSubscription): void {
    const previous = this.subsByOrch.get(sub.orchestratorId);
    if (previous) {
      const prevSet = this.subscriptions.get(previous.channelId);
      prevSet?.delete(previous);
      if (prevSet && prevSet.size === 0) this.subscriptions.delete(previous.channelId);
    }
    let set = this.subscriptions.get(sub.channelId);
    if (!set) {
      set = new Set();
      this.subscriptions.set(sub.channelId, set);
    }
    set.add(sub);
    this.subsByOrch.set(sub.orchestratorId, sub);
    log.info({
      event: 'discord.bot.subscribed',
      orchId: sub.orchestratorId,
      channelId: sub.channelId,
      subsOnChannel: set.size,
    });
  }

  unsubscribeOrchestrator(orchestratorId: string): void {
    const sub = this.subsByOrch.get(orchestratorId);
    if (!sub) return;
    const set = this.subscriptions.get(sub.channelId);
    set?.delete(sub);
    if (set && set.size === 0) this.subscriptions.delete(sub.channelId);
    this.subsByOrch.delete(orchestratorId);
    log.info({
      event: 'discord.bot.unsubscribed',
      orchId: orchestratorId,
      channelId: sub.channelId,
    });
  }

  /**
   * Post `content` to `channelId`. Wrapped in a 5 s timeout. Throws on
   * any failure so the MCP tool can surface a clean error to the lead.
   */
  async sendMessage(channelId: string, content: string): Promise<void> {
    if (!this.ready) {
      throw new Error('discord bot not ready');
    }
    const channel = await this.fetchSendableChannel(channelId);
    const sendPromise = channel.send({ content });
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`discord send timed out after ${this.sendTimeoutMs}ms`)),
        this.sendTimeoutMs,
      );
    });
    try {
      await Promise.race([sendPromise, timeoutPromise]);
      log.info({
        event: 'discord.bot.sent',
        channelId,
        length: content.length,
      });
    } catch (err) {
      log.warn({
        event: 'discord.bot.send_failed',
        channelId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // -- internals ----------------------------------------------------------

  private async fetchSendableChannel(channelId: string): Promise<
    Channel & { send: (payload: { content: string }) => Promise<unknown> }
  > {
    const cached = this.client.channels.cache.get(channelId);
    const channel = cached ?? (await this.client.channels.fetch(channelId));
    if (!channel) {
      throw new Error(`discord channel not found: ${channelId}`);
    }
    if (!channel.isTextBased() || !('send' in channel)) {
      throw new Error(`discord channel ${channelId} is not text-based`);
    }
    return channel as Channel & { send: (payload: { content: string }) => Promise<unknown> };
  }

  /**
   * Public for testability. Fans out an inbound channel message to every
   * orchestrator subscribed to that channel. Bot/system messages are
   * dropped to avoid loops (this catches our own bot, webhooks, and any
   * other automated poster sharing the channel).
   */
  handleMessageCreate(msg: Message): void {
    if (msg.author?.bot === true) return;
    if (msg.system === true) return;
    const subs = this.subscriptions.get(msg.channelId);
    if (!subs || subs.size === 0) return;

    const content = renderMessage(msg);
    for (const sub of subs) {
      const leadSessionId = sub.getLeadSessionId();
      if (!leadSessionId) {
        log.warn({
          event: 'discord.bot.skip_no_lead',
          orchId: sub.orchestratorId,
          channelId: msg.channelId,
        });
        continue;
      }
      try {
        sub.mailbox.push(leadSessionId, {
          from: `discord:${msg.author.username}`,
          content,
        });
        log.info({
          event: 'discord.bot.message_received',
          orchId: sub.orchestratorId,
          channelId: msg.channelId,
          authorId: msg.author.id,
          length: content.length,
        });
      } catch (err) {
        log.warn({
          event: 'discord.bot.push_failed',
          orchId: sub.orchestratorId,
          channelId: msg.channelId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/**
 * Build the content string that lands in the lead's inbox. Includes the
 * message body, attachment URLs (if any), and a short quoted snippet when
 * the message is a reply.
 */
function renderMessage(msg: Message): string {
  const parts: string[] = [];
  if (msg.reference?.messageId) {
    const ref = msg.channel.messages?.cache?.get(msg.reference.messageId);
    if (ref) {
      const quoted = truncate(ref.content ?? '', 200);
      if (quoted) {
        parts.push(`> (replying to ${ref.author?.username ?? 'unknown'}: ${quoted})`);
      }
    }
  }
  if (msg.content && msg.content.length > 0) {
    parts.push(msg.content);
  }
  if (msg.attachments && msg.attachments.size > 0) {
    const urls = [...msg.attachments.values()].map((a) => a.url);
    parts.push(`Attachments:\n${urls.join('\n')}`);
  }
  return parts.join('\n\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}

/**
 * Bidirectional Discord integration for swarm-os.
 *
 * Owns a single `discord.js` Gateway connection and a reverse-map of
 * `channelId → live orchestrator subscriptions`. Boundaries:
 *
 *  - **Inbound** (Discord → lead inbox): every `messageCreate` event for a
 *    subscribed channel is pushed into each matching lead's mailbox via the
 *    existing `Mailbox.push` primitive, then `notifyLead` is invoked so the
 *    spawner can wake the (idle) lead via the standard PTY signal — the same
 *    path `team.send_message` / `team.broadcast` use. Bot/system messages
 *    are dropped to avoid loops.
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
  ChannelType,
  type Message,
  type Channel,
} from 'discord.js';
import { withModule } from '../../logger.js';
import type { Mailbox } from '../orchestrator/mailbox.js';

const log = withModule('discord-bot');

const DEFAULT_SEND_TIMEOUT_MS = 5000;
const READY_TIMEOUT_MS = 15_000;

/**
 * Payload accepted by `TextChannel.send` / `ThreadChannel.send`. We narrow to
 * the fields we actually use (content + optional Discord native reply) so the
 * private channel cast stays tight.
 */
type SendPayload = {
  content: string;
  reply?: {
    messageReference: string;
    failIfNotExists?: boolean;
  };
};

/**
 * Minimal structural type of a thread-capable parent channel
 * (`TextChannel` / `NewsChannel` / `ForumChannel` at runtime). We only call
 * `messages.fetch` and `threads.create`, so we keep the shape narrow and
 * sidestep importing the full channel union from discord.js.
 */
type ThreadParentChannel = {
  messages?: { fetch: (id: string) => Promise<unknown> };
  threads?: {
    create: (opts: {
      name: string;
      autoArchiveDuration: number;
      type: number;
    }) => Promise<{ id: string; name: string }>;
  };
};

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
  /**
   * Wake the lead session after a successful mailbox push, so Claude calls
   * `team.read_inbox` instead of leaving the message stranded until the next
   * idle window. Best-effort: the spawner gates on `isIdle` and swallows
   * write errors. Same pattern as `messaging.ts` for in-process traffic.
   */
  notifyLead: () => void;
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
   * Post `content` to a channel. Wrapped in a 5 s timeout. Throws on any
   * failure so the MCP tool can surface a clean error to the lead.
   *
   * - `opts.threadId`: post into that thread instead of the channel root.
   *   A `ThreadChannel` is itself a `Channel`, so we just `fetch` by id.
   * - `opts.replyToMessageId`: attach a Discord native reply reference.
   *   `failIfNotExists: false` keeps the post as a normal message if the
   *   referenced message has been deleted (friendlier than throwing).
   *
   * Returns the freshly-posted message id (Discord snowflake) so the lead
   * can chain follow-ups (reply, start_thread).
   */
  async sendMessage(
    channelId: string,
    content: string,
    opts?: { threadId?: string; replyToMessageId?: string },
  ): Promise<{ messageId: string; channelId: string }> {
    if (!this.ready) {
      throw new Error('discord bot not ready');
    }
    const target = opts?.threadId ?? channelId;
    const channel = await this.fetchSendableChannel(target);
    const payload: SendPayload = { content };
    if (opts?.replyToMessageId) {
      payload.reply = {
        messageReference: opts.replyToMessageId,
        failIfNotExists: false,
      };
    }
    const sendPromise = channel.send(payload);
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`discord send timed out after ${this.sendTimeoutMs}ms`)),
        this.sendTimeoutMs,
      );
    });
    try {
      const sent = await Promise.race([sendPromise, timeoutPromise]);
      log.info({
        event: 'discord.bot.sent',
        channelId: target,
        threadId: opts?.threadId,
        length: content.length,
      });
      return { messageId: sent.id, channelId: target };
    } catch (err) {
      log.warn({
        event: 'discord.bot.send_failed',
        channelId: target,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Open a new Discord thread on `channelId`. Two modes:
   *  - `opts.fromMessageId` set → anchored to that message via
   *    `Message.startThread()`; the new thread inherits the message as its
   *    starter.
   *  - `opts.fromMessageId` absent → free-standing thread created on the
   *    channel itself via `channel.threads.create({ type: PublicThread })`.
   *
   * Both paths are wrapped in the same 5 s timeout as `sendMessage`.
   * Returns the new thread's id and name so the lead can immediately post
   * into it via `sendMessage({ threadId })`.
   */
  async createThread(
    channelId: string,
    opts: { name: string; fromMessageId?: string; autoArchiveMinutes?: number },
  ): Promise<{ threadId: string; threadName: string }> {
    if (!this.ready) {
      throw new Error('discord bot not ready');
    }
    const autoArchiveDuration = opts.autoArchiveMinutes ?? 1440;
    const cached = this.client.channels.cache.get(channelId);
    const channel = cached ?? (await this.client.channels.fetch(channelId));
    if (!channel) {
      throw new Error(`discord channel not found: ${channelId}`);
    }
    const createPromise = (async () => {
      if (opts.fromMessageId) {
        const parent = channel as ThreadParentChannel;
        if (!parent.messages || typeof parent.messages.fetch !== 'function') {
          throw new Error(
            `DISCORD_THREAD_CHANNEL_NOT_THREADABLE: ${channelId} cannot host threads`,
          );
        }
        let msg: { startThread?: (o: unknown) => Promise<{ id: string; name: string }> };
        try {
          msg = (await parent.messages.fetch(opts.fromMessageId)) as typeof msg;
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          throw new Error(`DISCORD_THREAD_PARENT_MESSAGE_NOT_FOUND: ${m}`);
        }
        if (!msg || typeof msg.startThread !== 'function') {
          throw new Error(
            `DISCORD_THREAD_CHANNEL_NOT_THREADABLE: message ${opts.fromMessageId} cannot start a thread`,
          );
        }
        const t = await msg.startThread({ name: opts.name, autoArchiveDuration });
        return { threadId: t.id, threadName: t.name };
      }
      const parent = channel as ThreadParentChannel;
      if (!parent.threads || typeof parent.threads.create !== 'function') {
        throw new Error(
          `DISCORD_THREAD_CHANNEL_NOT_THREADABLE: ${channelId} cannot host threads`,
        );
      }
      const t = await parent.threads.create({
        name: opts.name,
        autoArchiveDuration,
        type: ChannelType.PublicThread,
      });
      return { threadId: t.id, threadName: t.name };
    })();
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`discord create_thread timed out after ${this.sendTimeoutMs}ms`)),
        this.sendTimeoutMs,
      );
    });
    try {
      const result = await Promise.race([createPromise, timeoutPromise]);
      log.info({
        event: 'discord.bot.thread_created',
        channelId,
        threadId: result.threadId,
        fromMessageId: opts.fromMessageId,
      });
      return result;
    } catch (err) {
      log.warn({
        event: 'discord.bot.thread_create_failed',
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
    Channel & { send: (payload: SendPayload) => Promise<{ id: string }> }
  > {
    const cached = this.client.channels.cache.get(channelId);
    const channel = cached ?? (await this.client.channels.fetch(channelId));
    if (!channel) {
      throw new Error(`discord channel not found: ${channelId}`);
    }
    if (!channel.isTextBased() || !('send' in channel)) {
      throw new Error(`discord channel ${channelId} is not text-based`);
    }
    return channel as Channel & { send: (payload: SendPayload) => Promise<{ id: string }> };
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
    // When the message is posted inside a thread, `msg.channelId` is the
    // thread's own snowflake and `msg.channel.parentId` is the parent text
    // channel. Subscriptions are keyed by the PARENT id (that's what the
    // role's `channelId` resolves to), so we must resolve to the parent
    // before lookup — otherwise thread messages would never reach the lead.
    const channel = msg.channel as {
      isThread?: () => boolean;
      parentId?: string | null;
      name?: string;
    };
    const isThread = typeof channel.isThread === 'function' && channel.isThread();
    const parentChannelId = isThread
      ? channel.parentId ?? msg.channelId
      : msg.channelId;
    const subs = this.subscriptions.get(parentChannelId);
    if (!subs || subs.size === 0) return;

    const content = renderMessage(msg);
    const threadId = isThread ? msg.channelId : undefined;
    const threadName = isThread ? channel.name : undefined;
    for (const sub of subs) {
      const leadSessionId = sub.getLeadSessionId();
      if (!leadSessionId) {
        log.warn({
          event: 'discord.bot.skip_no_lead',
          orchId: sub.orchestratorId,
          channelId: parentChannelId,
        });
        continue;
      }
      try {
        sub.mailbox.push(leadSessionId, {
          from: `discord:${msg.author.username}`,
          content,
          sourceKind: 'discord',
          sourceMessageId: msg.id,
          ...(threadId ? { threadId } : {}),
          ...(threadName ? { threadName } : {}),
        });
        log.info({
          event: 'discord.bot.message_received',
          orchId: sub.orchestratorId,
          channelId: parentChannelId,
          threadId,
          authorId: msg.author.id,
          length: content.length,
        });
      } catch (err) {
        log.warn({
          event: 'discord.bot.push_failed',
          orchId: sub.orchestratorId,
          channelId: parentChannelId,
          threadId,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      try {
        sub.notifyLead();
      } catch (err) {
        log.warn({
          event: 'discord.bot.notify_failed',
          orchId: sub.orchestratorId,
          channelId: parentChannelId,
          threadId,
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

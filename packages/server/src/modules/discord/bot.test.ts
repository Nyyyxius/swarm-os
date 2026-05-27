import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Message } from 'discord.js';
import { DiscordBotService, type OrchSubscription } from './bot.js';
import { Mailbox } from '../orchestrator/mailbox.js';

/**
 * Unit tests for `DiscordBotService.handleMessageCreate` — the inbound fan-out
 * from a Discord channel to every orchestrator subscribed to that channel.
 *
 * We instantiate `DiscordBotService` without ever calling `start()` so no
 * gateway connection is opened. The bot client is unused by
 * `handleMessageCreate` itself; the method is public to make this kind of
 * test cheap.
 */

function makeBot(): DiscordBotService {
  return new DiscordBotService({ token: 'test-token' });
}

/** Build a minimal Message-like fixture sufficient for handleMessageCreate. */
function makeMessage(over: Partial<Record<string, unknown>> = {}): Message {
  const base = {
    id: 'discord-msg-1',
    channelId: 'channel-1',
    system: false,
    author: { id: 'user-1', username: 'alice', bot: false },
    content: 'hello',
    attachments: new Map(),
    reference: null,
    // `isThread()` is the canonical "this message lives in a thread" signal
    // in discord.js v14. Default false so the fixture mirrors a normal
    // channel-root post; thread-aware tests override `channel`.
    channel: {
      messages: { cache: new Map() },
      isThread: () => false,
    },
  };
  return { ...base, ...over } as unknown as Message;
}

function makeThreadMessage(over: Partial<Record<string, unknown>> = {}): Message {
  // In a thread, `channelId` IS the thread snowflake, and
  // `channel.parentId` points at the parent text channel. The lookup at
  // `handleMessageCreate` must resolve to `parentId` for subscriptions.
  return makeMessage({
    id: 'discord-msg-thread-1',
    channelId: 'thread-42',
    channel: {
      messages: { cache: new Map() },
      isThread: () => true,
      parentId: 'channel-1',
      name: 'feature-discussion',
    },
    ...over,
  });
}

function makeSubscription(over: Partial<OrchSubscription> = {}): OrchSubscription & {
  mailbox: Mailbox;
  notifyLead: ReturnType<typeof vi.fn>;
} {
  const mailbox = new Mailbox();
  return {
    orchestratorId: 'orch-1',
    channelId: 'channel-1',
    getLeadSessionId: () => 'lead-1',
    mailbox,
    notifyLead: vi.fn(),
    ...over,
  } as OrchSubscription & { mailbox: Mailbox; notifyLead: ReturnType<typeof vi.fn> };
}

describe('DiscordBotService.handleMessageCreate', () => {
  let bot: DiscordBotService;
  beforeEach(() => {
    bot = makeBot();
  });

  it('pushes a human message into every subscribed lead\'s mailbox', () => {
    const sub = makeSubscription();
    bot.subscribeOrchestrator(sub);
    bot.handleMessageCreate(makeMessage());
    const pending = sub.mailbox.peek('lead-1');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.from).toBe('discord:alice');
    expect(pending[0]?.content).toBe('hello');
  });

  it('drops messages from bot accounts (loop guard)', () => {
    const sub = makeSubscription();
    bot.subscribeOrchestrator(sub);
    bot.handleMessageCreate(
      makeMessage({
        author: { id: 'bot-1', username: 'swarm-bot', bot: true },
      }),
    );
    expect(sub.mailbox.peek('lead-1')).toHaveLength(0);
  });

  it('drops Discord system messages', () => {
    const sub = makeSubscription();
    bot.subscribeOrchestrator(sub);
    bot.handleMessageCreate(makeMessage({ system: true }));
    expect(sub.mailbox.peek('lead-1')).toHaveLength(0);
  });

  it('does nothing for channels with no subscribers', () => {
    const sub = makeSubscription({ channelId: 'channel-1' });
    bot.subscribeOrchestrator(sub);
    bot.handleMessageCreate(makeMessage({ channelId: 'channel-unknown' }));
    expect(sub.mailbox.peek('lead-1')).toHaveLength(0);
  });

  it('fans out to multiple orchestrators sharing the same channel', () => {
    const subA = makeSubscription({ orchestratorId: 'orch-A', getLeadSessionId: () => 'lead-A' });
    const subB = makeSubscription({ orchestratorId: 'orch-B', getLeadSessionId: () => 'lead-B' });
    bot.subscribeOrchestrator(subA);
    bot.subscribeOrchestrator(subB);
    bot.handleMessageCreate(makeMessage());
    expect(subA.mailbox.peek('lead-A')).toHaveLength(1);
    expect(subB.mailbox.peek('lead-B')).toHaveLength(1);
  });

  it('skips orchs whose lead session id is null', () => {
    const sub = makeSubscription({ getLeadSessionId: () => null });
    bot.subscribeOrchestrator(sub);
    bot.handleMessageCreate(makeMessage());
    // Mailbox key would be the string 'null' if we didn't skip — verify no
    // queue was created either way.
    expect(sub.mailbox.totalSize()).toBe(0);
  });

  it('invokes notifyLead after a successful push so the lead wakes up', () => {
    const sub = makeSubscription();
    bot.subscribeOrchestrator(sub);
    bot.handleMessageCreate(makeMessage());
    expect(sub.notifyLead).toHaveBeenCalledTimes(1);
  });

  it('does not invoke notifyLead for dropped bot/system messages', () => {
    const sub = makeSubscription();
    bot.subscribeOrchestrator(sub);
    bot.handleMessageCreate(
      makeMessage({ author: { id: 'bot-1', username: 'swarm-bot', bot: true } }),
    );
    bot.handleMessageCreate(makeMessage({ system: true }));
    expect(sub.notifyLead).not.toHaveBeenCalled();
  });

  it('swallows notifyLead exceptions without breaking the handler', () => {
    const sub = makeSubscription({
      notifyLead: vi.fn(() => {
        throw new Error('boom');
      }),
    });
    bot.subscribeOrchestrator(sub);
    expect(() => bot.handleMessageCreate(makeMessage())).not.toThrow();
    // The push must still have succeeded — notify is best-effort downstream.
    expect(sub.mailbox.peek('lead-1')).toHaveLength(1);
  });

  it('appends attachment URLs to the rendered content', () => {
    const sub = makeSubscription();
    bot.subscribeOrchestrator(sub);
    const attachments = new Map<string, { url: string }>();
    attachments.set('a1', { url: 'https://cdn.discord/img.png' });
    bot.handleMessageCreate(makeMessage({ attachments }));
    const msg = sub.mailbox.peek('lead-1')[0];
    expect(msg?.content).toContain('hello');
    expect(msg?.content).toContain('https://cdn.discord/img.png');
  });

  it('exposes the Discord message id on every inbound push (sourceKind/sourceMessageId)', () => {
    const sub = makeSubscription();
    bot.subscribeOrchestrator(sub);
    bot.handleMessageCreate(makeMessage({ id: 'snowflake-7' }));
    const msg = sub.mailbox.peek('lead-1')[0];
    expect(msg?.sourceKind).toBe('discord');
    expect(msg?.sourceMessageId).toBe('snowflake-7');
    // Channel-root messages must NOT carry thread context.
    expect(msg?.threadId).toBeUndefined();
    expect(msg?.threadName).toBeUndefined();
  });

  it('captures thread context when the message comes from a thread', () => {
    const sub = makeSubscription({ channelId: 'channel-1' });
    bot.subscribeOrchestrator(sub);
    bot.handleMessageCreate(makeThreadMessage({ id: 'msg-in-thread' }));
    const msg = sub.mailbox.peek('lead-1')[0];
    // Delivery alone proves the parent-id lookup works — `msg.channelId`
    // here is the thread id, so without the parent-id resolution the
    // message would silently never reach the inbox.
    expect(msg).toBeDefined();
    expect(msg?.sourceMessageId).toBe('msg-in-thread');
    expect(msg?.threadId).toBe('thread-42');
    expect(msg?.threadName).toBe('feature-discussion');
  });

  it('resolves the subscription via the parent channel id, not the thread id', () => {
    // Subscription is on the PARENT channel. The thread message's own
    // `channelId` is the thread snowflake — we must still find the
    // subscriber via `channel.parentId`.
    const sub = makeSubscription({ channelId: 'channel-1' });
    bot.subscribeOrchestrator(sub);
    bot.handleMessageCreate(makeThreadMessage());
    expect(sub.mailbox.peek('lead-1')).toHaveLength(1);
  });

  it('does not capture thread context for non-thread messages', () => {
    const sub = makeSubscription();
    bot.subscribeOrchestrator(sub);
    bot.handleMessageCreate(makeMessage());
    const msg = sub.mailbox.peek('lead-1')[0];
    expect(msg?.threadId).toBeUndefined();
    expect(msg?.threadName).toBeUndefined();
  });
});

describe('DiscordBotService subscription management', () => {
  it('unsubscribes an orchestrator and stops fan-out', () => {
    const bot = makeBot();
    const sub = makeSubscription();
    bot.subscribeOrchestrator(sub);
    bot.unsubscribeOrchestrator('orch-1');
    bot.handleMessageCreate(makeMessage());
    expect(sub.mailbox.peek('lead-1')).toHaveLength(0);
  });

  it('replaces a previous subscription when an orch resubscribes on a different channel', () => {
    const bot = makeBot();
    const sub1 = makeSubscription({ channelId: 'channel-A' });
    bot.subscribeOrchestrator(sub1);
    const sub2 = makeSubscription({ channelId: 'channel-B', mailbox: new Mailbox() });
    bot.subscribeOrchestrator(sub2);
    // Message on the old channel must not be delivered anymore.
    bot.handleMessageCreate(makeMessage({ channelId: 'channel-A' }));
    expect(sub1.mailbox.peek('lead-1')).toHaveLength(0);
    // Message on the new channel must be delivered.
    bot.handleMessageCreate(makeMessage({ channelId: 'channel-B' }));
    expect(sub2.mailbox.peek('lead-1')).toHaveLength(1);
  });

  it('handles unsubscribe for an unknown orchestrator without throwing', () => {
    const bot = makeBot();
    expect(() => bot.unsubscribeOrchestrator('does-not-exist')).not.toThrow();
  });
});

/**
 * Stand up a ready bot whose `client.channels` is wholly replaced by a stub
 * (the real `ChannelManager` exposes `cache` as a non-writable getter, so we
 * swap the whole manager instead of patching its internals). We can't call
 * `start()` in tests (it would open a real gateway), so we flip the private
 * `ready` flag directly — same shortcut used everywhere else in this file.
 */
function makeReadyBotWithChannel(fakeChannel: unknown): DiscordBotService {
  const bot = makeBot();
  (bot as unknown as { ready: boolean }).ready = true;
  const client = (bot as unknown as { client: Record<string, unknown> }).client;
  client.channels = {
    cache: new Map<string, unknown>(),
    fetch: vi.fn(async () => fakeChannel),
  };
  return bot;
}

describe('DiscordBotService.sendMessage', () => {
  it('throws when the bot is not ready', async () => {
    const bot = makeBot();
    await expect(bot.sendMessage('channel-1', 'hi')).rejects.toThrow(/not ready/);
  });

  it('returns the freshly-posted Discord message id', async () => {
    const send = vi.fn(async () => ({ id: 'snowflake-99' }));
    const bot = makeReadyBotWithChannel({
      isTextBased: () => true,
      send,
    });
    const out = await bot.sendMessage('channel-1', 'hi');
    expect(out).toEqual({ messageId: 'snowflake-99', channelId: 'channel-1' });
    expect(send).toHaveBeenCalledWith({ content: 'hi' });
  });

  it('routes through `threadId` when provided', async () => {
    const send = vi.fn(async () => ({ id: 'snowflake-thread-msg' }));
    const fetchSpy = vi.fn(async () => ({ isTextBased: () => true, send }));
    const bot = makeBot();
    (bot as unknown as { ready: boolean }).ready = true;
    const client = (bot as unknown as { client: Record<string, unknown> }).client;
    client.channels = { cache: new Map<string, unknown>(), fetch: fetchSpy };
    const out = await bot.sendMessage('channel-1', 'reply', { threadId: 'thread-42' });
    // Fetch must be called with the THREAD id, not the channel id.
    expect(fetchSpy).toHaveBeenCalledWith('thread-42');
    expect(out.channelId).toBe('thread-42');
    expect(send).toHaveBeenCalledWith({ content: 'reply' });
  });

  it('attaches a Discord native reply reference when `replyToMessageId` is set', async () => {
    const send = vi.fn(async () => ({ id: 'snowflake-reply' }));
    const bot = makeReadyBotWithChannel({ isTextBased: () => true, send });
    await bot.sendMessage('channel-1', 'replying', {
      replyToMessageId: 'parent-msg-id',
    });
    expect(send).toHaveBeenCalledWith({
      content: 'replying',
      reply: {
        messageReference: 'parent-msg-id',
        failIfNotExists: false,
      },
    });
  });

  it('combines `threadId` and `replyToMessageId` correctly', async () => {
    const send = vi.fn(async () => ({ id: 'snowflake-combo' }));
    const bot = makeReadyBotWithChannel({ isTextBased: () => true, send });
    await bot.sendMessage('channel-1', 'both', {
      threadId: 'thread-7',
      replyToMessageId: 'msg-3',
    });
    expect(send).toHaveBeenCalledWith({
      content: 'both',
      reply: { messageReference: 'msg-3', failIfNotExists: false },
    });
  });
});

describe('DiscordBotService.createThread', () => {
  it('throws when the bot is not ready', async () => {
    const bot = makeBot();
    await expect(
      bot.createThread('channel-1', { name: 'whatever' }),
    ).rejects.toThrow(/not ready/);
  });

  it('anchors the thread on a message when `fromMessageId` is given', async () => {
    const startThread = vi.fn(async () => ({ id: 'new-thread-id', name: 'support-thread' }));
    const messages = {
      fetch: vi.fn(async () => ({ startThread })),
    };
    const bot = makeReadyBotWithChannel({ messages });
    const out = await bot.createThread('channel-1', {
      name: 'support-thread',
      fromMessageId: 'msg-1',
      autoArchiveMinutes: 60,
    });
    expect(messages.fetch).toHaveBeenCalledWith('msg-1');
    expect(startThread).toHaveBeenCalledWith({
      name: 'support-thread',
      autoArchiveDuration: 60,
    });
    expect(out).toEqual({ threadId: 'new-thread-id', threadName: 'support-thread' });
  });

  it('defaults `autoArchiveMinutes` to 1440 (24h)', async () => {
    const startThread = vi.fn(async () => ({ id: 't', name: 'n' }));
    const bot = makeReadyBotWithChannel({
      messages: { fetch: vi.fn(async () => ({ startThread })) },
    });
    await bot.createThread('channel-1', { name: 'n', fromMessageId: 'm' });
    expect(startThread).toHaveBeenCalledWith({
      name: 'n',
      autoArchiveDuration: 1440,
    });
  });

  it('creates a free-standing thread when `fromMessageId` is absent', async () => {
    const create = vi.fn(async () => ({ id: 'standalone-thread', name: 'general' }));
    const bot = makeReadyBotWithChannel({
      threads: { create },
    });
    const out = await bot.createThread('channel-1', { name: 'general' });
    expect(create).toHaveBeenCalledWith({
      name: 'general',
      autoArchiveDuration: 1440,
      // ChannelType.PublicThread === 11 in discord.js v14.
      type: 11,
    });
    expect(out).toEqual({ threadId: 'standalone-thread', threadName: 'general' });
  });

  it('surfaces DISCORD_THREAD_PARENT_MESSAGE_NOT_FOUND when the anchor message is gone', async () => {
    const bot = makeReadyBotWithChannel({
      messages: {
        fetch: vi.fn(async () => {
          throw new Error('Unknown Message');
        }),
      },
    });
    await expect(
      bot.createThread('channel-1', { name: 'x', fromMessageId: 'gone' }),
    ).rejects.toThrow(/DISCORD_THREAD_PARENT_MESSAGE_NOT_FOUND/);
  });

  it('surfaces DISCORD_THREAD_CHANNEL_NOT_THREADABLE when the channel has no threads manager', async () => {
    const bot = makeReadyBotWithChannel({ /* no threads, no messages */ });
    await expect(
      bot.createThread('channel-1', { name: 'x' }),
    ).rejects.toThrow(/DISCORD_THREAD_CHANNEL_NOT_THREADABLE/);
  });
});

// Coverage note: a full end-to-end test of the MCP `discord.send_message`
// tool (including NO_DISCORD_CHANNEL / DISCORD_BOT_DISABLED branches) would
// require wiring a real `Spawner` + `RoleStore` + `Orchestrator`, which the
// integration test suite already does. The unit tests above isolate the
// pieces unique to the Discord bot service.

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
    // Auto-⏳-on-delivery reacts on the live Message object; give every fixture
    // its own resolvable mock so a test can assert the acknowledgement.
    react: vi.fn(async () => undefined),
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

/** Read the `react` mock off a fixture message built by `makeMessage`. */
function reactMock(msg: Message): ReturnType<typeof vi.fn> {
  return (msg as unknown as { react: ReturnType<typeof vi.fn> }).react;
}

describe('DiscordBotService.handleMessageCreate — auto ⏳ acknowledgement', () => {
  let bot: DiscordBotService;
  beforeEach(() => {
    bot = makeBot();
  });

  it('adds a ⏳ reaction to a message once it is delivered to an inbox', () => {
    const sub = makeSubscription();
    bot.subscribeOrchestrator(sub);
    const msg = makeMessage();
    bot.handleMessageCreate(msg);
    // The reaction is issued synchronously (only its result is awaited).
    expect(reactMock(msg)).toHaveBeenCalledTimes(1);
    expect(reactMock(msg)).toHaveBeenCalledWith('⏳');
  });

  it('does NOT react to a bot/system message (never delivered)', () => {
    const sub = makeSubscription();
    bot.subscribeOrchestrator(sub);
    const botMsg = makeMessage({ author: { id: 'b', username: 'bot', bot: true } });
    const sysMsg = makeMessage({ system: true });
    bot.handleMessageCreate(botMsg);
    bot.handleMessageCreate(sysMsg);
    expect(reactMock(botMsg)).not.toHaveBeenCalled();
    expect(reactMock(sysMsg)).not.toHaveBeenCalled();
  });

  it('does NOT react when there is no subscriber for the channel', () => {
    const sub = makeSubscription();
    bot.subscribeOrchestrator(sub);
    const msg = makeMessage({ channelId: 'channel-unknown' });
    bot.handleMessageCreate(msg);
    expect(reactMock(msg)).not.toHaveBeenCalled();
  });

  it('does NOT react when the orch has no lead session (not delivered)', () => {
    const sub = makeSubscription({ getLeadSessionId: () => null });
    bot.subscribeOrchestrator(sub);
    const msg = makeMessage();
    bot.handleMessageCreate(msg);
    expect(reactMock(msg)).not.toHaveBeenCalled();
  });

  it('reacts only ONCE even when several orchs share the channel', () => {
    const subA = makeSubscription({ orchestratorId: 'orch-A', getLeadSessionId: () => 'lead-A' });
    const subB = makeSubscription({ orchestratorId: 'orch-B', getLeadSessionId: () => 'lead-B' });
    bot.subscribeOrchestrator(subA);
    bot.subscribeOrchestrator(subB);
    const msg = makeMessage();
    bot.handleMessageCreate(msg);
    expect(reactMock(msg)).toHaveBeenCalledTimes(1);
  });

  it('a failing reaction never breaks inbound delivery', () => {
    const sub = makeSubscription();
    bot.subscribeOrchestrator(sub);
    const msg = makeMessage({
      // A react() that rejects must be swallowed (best-effort ack).
      react: vi.fn(async () => {
        throw new Error('Missing Permissions');
      }),
    });
    expect(() => bot.handleMessageCreate(msg)).not.toThrow();
    // The message still reached the inbox.
    expect(sub.mailbox.peek('lead-1')).toHaveLength(1);
  });

  it('a react() that throws synchronously is swallowed', () => {
    const sub = makeSubscription();
    bot.subscribeOrchestrator(sub);
    const msg = makeMessage({
      react: vi.fn(() => {
        throw new Error('sync boom');
      }),
    });
    expect(() => bot.handleMessageCreate(msg)).not.toThrow();
    expect(sub.mailbox.peek('lead-1')).toHaveLength(1);
  });

  it('does NOT react to a reply that is CONSUMED as an approval decision', () => {
    // A consumed approval reply is not delivered to the inbox — it already gets
    // its own ✅/❌ confirmation, so no ⏳ ack should be posted on it.
    vi.spyOn(bot, 'sendMessage').mockResolvedValue({ messageId: 'c', channelId: 'channel-1' });
    const sub = makeSubscription({
      tryConsumeApprovalReply: vi.fn(() => ({ consumed: true, confirmation: 'Approuvé ✅.' })),
    });
    bot.subscribeOrchestrator(sub);
    const msg = makeMessage({ id: 'reply-1', reference: { messageId: 'appr' }, content: 'oui' });
    bot.handleMessageCreate(msg);
    expect(reactMock(msg)).not.toHaveBeenCalled();
  });
});

describe('DiscordBotService.handleMessageCreate — P4 approval reply routing', () => {
  let bot: DiscordBotService;
  beforeEach(() => {
    bot = makeBot();
    // The confirmation post goes through sendMessage; stub it (bot isn't ready).
    vi.spyOn(bot, 'sendMessage').mockResolvedValue({ messageId: 'conf-1', channelId: 'channel-1' });
  });

  it('consumes a reply that resolves an approval — no inbox push, posts confirmation', () => {
    const tryConsumeApprovalReply = vi.fn(() => ({ consumed: true, confirmation: 'Approuvé ✅.' }));
    const sub = makeSubscription({ tryConsumeApprovalReply });
    bot.subscribeOrchestrator(sub);

    bot.handleMessageCreate(
      makeMessage({ id: 'reply-1', reference: { messageId: 'appr-msg' }, content: 'oui' }),
    );

    expect(tryConsumeApprovalReply).toHaveBeenCalledWith({
      referenceMessageId: 'appr-msg',
      content: 'oui',
      author: 'alice',
    });
    // NOT pushed to the inbox, lead NOT woken.
    expect(sub.mailbox.peek('lead-1')).toHaveLength(0);
    expect(sub.notifyLead).not.toHaveBeenCalled();
    // Confirmation posted as a reply to the operator's message.
    expect(bot.sendMessage).toHaveBeenCalledWith('channel-1', 'Approuvé ✅.', {
      replyToMessageId: 'reply-1',
    });
  });

  it('lets an unconsumed reply (consumed:false) flow to the inbox as normal', () => {
    const tryConsumeApprovalReply = vi.fn(() => ({ consumed: false }));
    const sub = makeSubscription({ tryConsumeApprovalReply });
    bot.subscribeOrchestrator(sub);

    bot.handleMessageCreate(
      makeMessage({ reference: { messageId: 'some-other-msg' }, content: 'a question?' }),
    );

    expect(tryConsumeApprovalReply).toHaveBeenCalledTimes(1);
    expect(sub.mailbox.peek('lead-1')).toHaveLength(1);
    expect(sub.notifyLead).toHaveBeenCalledTimes(1);
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it('does NOT call the resolver for a non-reply message (no reference)', () => {
    const tryConsumeApprovalReply = vi.fn(() => ({ consumed: false }));
    const sub = makeSubscription({ tryConsumeApprovalReply });
    bot.subscribeOrchestrator(sub);

    bot.handleMessageCreate(makeMessage({ reference: null, content: 'hello' }));

    expect(tryConsumeApprovalReply).not.toHaveBeenCalled();
    expect(sub.mailbox.peek('lead-1')).toHaveLength(1);
  });

  it('consumes even when the orch has no lead session (decision needs no lead)', () => {
    const tryConsumeApprovalReply = vi.fn(() => ({ consumed: true, confirmation: 'Refusé ❌.' }));
    const sub = makeSubscription({ getLeadSessionId: () => null, tryConsumeApprovalReply });
    bot.subscribeOrchestrator(sub);

    bot.handleMessageCreate(makeMessage({ reference: { messageId: 'appr-msg' }, content: 'non' }));

    expect(tryConsumeApprovalReply).toHaveBeenCalledTimes(1);
    expect(sub.mailbox.totalSize()).toBe(0);
    expect(bot.sendMessage).toHaveBeenCalled();
  });

  it('a resolver exception does not break the handler (message still flows to inbox)', () => {
    const tryConsumeApprovalReply = vi.fn(() => {
      throw new Error('boom');
    });
    const sub = makeSubscription({ tryConsumeApprovalReply });
    bot.subscribeOrchestrator(sub);

    expect(() =>
      bot.handleMessageCreate(makeMessage({ reference: { messageId: 'appr-msg' } })),
    ).not.toThrow();
    // Not consumed (threw) → falls through to the normal inbox push.
    expect(sub.mailbox.peek('lead-1')).toHaveLength(1);
  });

  it('does not post a confirmation when consumed but confirmation is empty', () => {
    const tryConsumeApprovalReply = vi.fn(() => ({ consumed: true }));
    const sub = makeSubscription({ tryConsumeApprovalReply });
    bot.subscribeOrchestrator(sub);

    bot.handleMessageCreate(makeMessage({ reference: { messageId: 'appr-msg' } }));

    expect(sub.mailbox.peek('lead-1')).toHaveLength(0);
    expect(bot.sendMessage).not.toHaveBeenCalled();
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

describe('DiscordBotService.addReaction', () => {
  it('throws when the bot is not ready', async () => {
    const bot = makeBot();
    await expect(bot.addReaction('channel-1', 'msg-1', '⏳')).rejects.toThrow(/not ready/);
  });

  it('fetches the message and reacts with the given emoji', async () => {
    const react = vi.fn(async () => undefined);
    const fetch = vi.fn(async () => ({ react }));
    const bot = makeReadyBotWithChannel({ messages: { fetch } });
    const out = await bot.addReaction('channel-1', 'msg-9', '⏳');
    expect(fetch).toHaveBeenCalledWith('msg-9');
    expect(react).toHaveBeenCalledWith('⏳');
    expect(out).toEqual({
      reacted: true,
      channelId: 'channel-1',
      messageId: 'msg-9',
      emoji: '⏳',
    });
  });

  it('targets the thread channel when threadId is provided', async () => {
    const react = vi.fn(async () => undefined);
    const fetchMsg = vi.fn(async () => ({ react }));
    const fetchChannel = vi.fn(async () => ({ messages: { fetch: fetchMsg } }));
    const bot = makeBot();
    (bot as unknown as { ready: boolean }).ready = true;
    const client = (bot as unknown as { client: Record<string, unknown> }).client;
    client.channels = { cache: new Map<string, unknown>(), fetch: fetchChannel };
    const out = await bot.addReaction('channel-1', 'msg-3', '👀', { threadId: 'thread-7' });
    // The channel fetched must be the THREAD, not the parent channel.
    expect(fetchChannel).toHaveBeenCalledWith('thread-7');
    expect(react).toHaveBeenCalledWith('👀');
    expect(out.channelId).toBe('thread-7');
  });

  it('throws when the channel cannot fetch messages', async () => {
    const bot = makeReadyBotWithChannel({ /* no messages manager */ });
    await expect(bot.addReaction('channel-1', 'msg-1', '⏳')).rejects.toThrow(
      /cannot fetch messages/,
    );
  });

  it('propagates a Discord-side reaction failure', async () => {
    const react = vi.fn(async () => {
      throw new Error('Missing Permissions');
    });
    const bot = makeReadyBotWithChannel({ messages: { fetch: vi.fn(async () => ({ react })) } });
    await expect(bot.addReaction('channel-1', 'msg-1', '⏳')).rejects.toThrow(/Missing Permissions/);
  });
});

// Coverage note: a full end-to-end test of the MCP `discord.send_message`
// tool (including NO_DISCORD_CHANNEL / DISCORD_BOT_DISABLED branches) would
// require wiring a real `Spawner` + `RoleStore` + `Orchestrator`, which the
// integration test suite already does. The unit tests above isolate the
// pieces unique to the Discord bot service.

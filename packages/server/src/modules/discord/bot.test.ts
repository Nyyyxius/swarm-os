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
    channelId: 'channel-1',
    system: false,
    author: { id: 'user-1', username: 'alice', bot: false },
    content: 'hello',
    attachments: new Map(),
    reference: null,
    channel: { messages: { cache: new Map() } },
  };
  return { ...base, ...over } as unknown as Message;
}

function makeSubscription(over: Partial<OrchSubscription> = {}): OrchSubscription & {
  mailbox: Mailbox;
} {
  const mailbox = new Mailbox();
  return {
    orchestratorId: 'orch-1',
    channelId: 'channel-1',
    getLeadSessionId: () => 'lead-1',
    mailbox,
    ...over,
  };
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

describe('DiscordBotService.sendMessage', () => {
  it('throws when the bot is not ready', async () => {
    const bot = makeBot();
    await expect(bot.sendMessage('channel-1', 'hi')).rejects.toThrow(/not ready/);
  });
});

// Coverage note: a full end-to-end test of the MCP `discord.send_message`
// tool (including NO_DISCORD_CHANNEL / DISCORD_BOT_DISABLED branches) would
// require wiring a real `Spawner` + `RoleStore` + `Orchestrator`, which the
// integration test suite already does. The unit tests above isolate the
// pieces unique to the Discord bot service.
vi.mock; // touch vi so unused-import lints don't fire when this file is run.

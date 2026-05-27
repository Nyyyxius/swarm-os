import { describe, it, expect, vi } from 'vitest';
import { DiscordBotPool } from './pool.js';
import { DiscordBotService, type OrchSubscription } from './bot.js';
import { Mailbox } from '../orchestrator/mailbox.js';

/**
 * Unit tests for `DiscordBotPool` — the per-token Gateway connection pool
 * that replaced the single-bot singleton (decision: identity per role).
 *
 * We never touch the real Discord gateway: a `TestPool` subclass swaps in a
 * `FakeBot` via the protected `createBot` seam. Tests cover the four
 * invariants the production code depends on:
 *
 *   1. Lazy start — `subscribeOrch` triggers `start()` the first time a
 *      given token is seen.
 *   2. Dedup    — a second subscribe with the same token reuses the bot
 *      (refCount semantics).
 *   3. Teardown — when the last orch unsubscribes from a token, the bot
 *      is `stop()`ed and dropped from the pool.
 *   4. botForOrch — outbound routing keys off subscription, NOT off the
 *      role's current token (operator decision: orchs stay on their bot).
 */

interface FakeBotState {
  token: string;
  started: boolean;
  stopped: boolean;
  startShouldReject: boolean;
  subscribed: Set<string>;
}

class FakeBot extends DiscordBotService {
  readonly state: FakeBotState;
  constructor(token: string, opts: { startShouldReject?: boolean } = {}) {
    super({ token: token });
    this.state = {
      token,
      started: false,
      stopped: false,
      startShouldReject: opts.startShouldReject ?? false,
      subscribed: new Set(),
    };
  }
  override async start(): Promise<void> {
    if (this.state.startShouldReject) {
      throw new Error(`fake bot ${this.state.token}: forced start failure`);
    }
    this.state.started = true;
  }
  override async stop(): Promise<void> {
    this.state.stopped = true;
  }
  override isReady(): boolean {
    return this.state.started && !this.state.stopped;
  }
  override subscribeOrchestrator(sub: OrchSubscription): void {
    this.state.subscribed.add(sub.orchestratorId);
  }
  override unsubscribeOrchestrator(orchId: string): void {
    this.state.subscribed.delete(orchId);
  }
}

class TestPool extends DiscordBotPool {
  readonly bots = new Map<string, FakeBot>();
  /** Tokens flagged here will cause the next `createBot` to return a bot whose `start()` rejects. */
  readonly poisoned = new Set<string>();
  protected override createBot(token: string): DiscordBotService {
    const bot = new FakeBot(token, { startShouldReject: this.poisoned.has(token) });
    this.bots.set(token, bot);
    return bot;
  }
}

function makeSubscription(over: Partial<OrchSubscription> = {}): OrchSubscription {
  return {
    orchestratorId: 'orch-1',
    channelId: 'channel-1',
    getLeadSessionId: () => 'lead-1',
    mailbox: new Mailbox(),
    ...over,
  };
}

describe('DiscordBotPool', () => {
  it('starts the bot lazily on the first subscribe for a token', async () => {
    const pool = new TestPool();
    expect(pool.bots.size).toBe(0);
    const bot = await pool.subscribeOrch('T1', makeSubscription());
    expect(bot).not.toBeNull();
    const fake = pool.bots.get('T1');
    expect(fake?.state.started).toBe(true);
    expect(fake?.state.subscribed.has('orch-1')).toBe(true);
  });

  it('dedups: two orchs on the same token share one bot instance', async () => {
    const pool = new TestPool();
    const bot1 = await pool.subscribeOrch('T1', makeSubscription({ orchestratorId: 'orch-A' }));
    const bot2 = await pool.subscribeOrch('T1', makeSubscription({ orchestratorId: 'orch-B' }));
    expect(bot1).toBe(bot2);
    expect(pool.bots.size).toBe(1);
    const fake = pool.bots.get('T1');
    expect(fake?.state.subscribed.size).toBe(2);
  });

  it('starts a separate bot per distinct token', async () => {
    const pool = new TestPool();
    await pool.subscribeOrch('T1', makeSubscription({ orchestratorId: 'orch-A' }));
    await pool.subscribeOrch('T2', makeSubscription({ orchestratorId: 'orch-B' }));
    expect(pool.bots.size).toBe(2);
    expect(pool.bots.get('T1')?.state.subscribed.has('orch-A')).toBe(true);
    expect(pool.bots.get('T2')?.state.subscribed.has('orch-B')).toBe(true);
  });

  it('stops and drops the bot when the last orch unsubscribes', async () => {
    const pool = new TestPool();
    await pool.subscribeOrch('T1', makeSubscription({ orchestratorId: 'orch-A' }));
    await pool.subscribeOrch('T1', makeSubscription({ orchestratorId: 'orch-B' }));
    const fake = pool.bots.get('T1');
    await pool.unsubscribeOrch('orch-A');
    expect(fake?.state.stopped).toBe(false); // one orch remaining
    await pool.unsubscribeOrch('orch-B');
    expect(fake?.state.stopped).toBe(true);
    // Subsequent subscribe with the same token creates a FRESH bot.
    await pool.subscribeOrch('T1', makeSubscription({ orchestratorId: 'orch-C' }));
    expect(pool.bots.get('T1')).not.toBe(fake);
  });

  it('botForOrch returns the subscription bot, not the role\'s current token', async () => {
    const pool = new TestPool();
    await pool.subscribeOrch('T-old', makeSubscription({ orchestratorId: 'orch-1' }));
    const oldBot = pool.botForOrch('orch-1');
    expect(oldBot).toBe(pool.bots.get('T-old'));
    // Operator updates role → next subscribe uses T-new — but orch-1's
    // routing must NOT shift.
    await pool.subscribeOrch('T-new', makeSubscription({ orchestratorId: 'orch-2' }));
    expect(pool.botForOrch('orch-1')).toBe(oldBot);
    expect(pool.botForOrch('orch-2')).toBe(pool.bots.get('T-new'));
  });

  it('subscribe with a token whose start() rejects returns null and leaves no refcount', async () => {
    const pool = new TestPool();
    pool.poisoned.add('T-bad');
    const result = await pool.subscribeOrch('T-bad', makeSubscription());
    expect(result).toBeNull();
    expect(pool.botForOrch('orch-1')).toBeNull();
    // No leaked entry in the pool either — the orch can be retried later
    // (e.g. after the operator fixes the token) without resurrecting a
    // dead bot.
    await pool.unsubscribeOrch('orch-1'); // safe no-op
    const result2 = await pool.subscribeOrch('T-bad', makeSubscription());
    expect(result2).toBeNull();
  });

  it('stopAll tears every bot down', async () => {
    const pool = new TestPool();
    await pool.subscribeOrch('T1', makeSubscription({ orchestratorId: 'orch-A' }));
    await pool.subscribeOrch('T2', makeSubscription({ orchestratorId: 'orch-B' }));
    const fakes = [...pool.bots.values()];
    await pool.stopAll();
    for (const f of fakes) expect(f.state.stopped).toBe(true);
    expect(pool.botForOrch('orch-A')).toBeNull();
    expect(pool.botForOrch('orch-B')).toBeNull();
  });

  it('concurrent subscribes on a fresh token share one start() call', async () => {
    const pool = new TestPool();
    const startSpy = vi.fn();
    // Wrap createBot so we can count actual constructor invocations.
    const original = (pool as unknown as { createBot: (t: string) => DiscordBotService }).createBot.bind(pool);
    (pool as unknown as { createBot: (t: string) => DiscordBotService }).createBot = (token: string) => {
      startSpy();
      return original(token);
    };
    const [a, b] = await Promise.all([
      pool.subscribeOrch('T1', makeSubscription({ orchestratorId: 'orch-A' })),
      pool.subscribeOrch('T1', makeSubscription({ orchestratorId: 'orch-B' })),
    ]);
    expect(a).toBe(b);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * Pool of Discord bot connections, keyed by bot token.
 *
 * Each role can now carry its own `botToken` (see `DiscordConnector`).
 * Instead of a single global `DiscordBotService` singleton, we maintain
 * one `DiscordBotService` per distinct token, started lazily at the
 * first orch subscription and stopped when the last orch unsubscribes.
 *
 * Invariant (operator-approved): once an orch subscribes to bot `T`,
 * it stays on `T` until it terminates — even if its role's token is
 * later changed to `T'`. The outbound `discord.send_message` therefore
 * routes via `botForOrch(orchId)`, which reads the captured-at-subscribe
 * token, not the role's current token. New orchs (or resumes after
 * restart) pick up the role's current token.
 */

import { DiscordBotService, type OrchSubscription } from './bot.js';
import { withModule } from '../../logger.js';

const log = withModule('discord-pool');

export class DiscordBotPool {
  private readonly pool = new Map<string, DiscordBotService>();
  private readonly refs = new Map<string, Set<string>>();
  private readonly orchToken = new Map<string, string>();
  /**
   * In-flight `start()` promises so two concurrent subscribes on the same
   * brand-new token share one Gateway connection attempt instead of racing.
   */
  private readonly starting = new Map<string, Promise<DiscordBotService | null>>();

  /**
   * Start (or reuse) the bot for `token` and register `sub` against it.
   * Returns the live bot, or `null` if the start failed — the caller's
   * orch keeps running, just without Discord.
   */
  async subscribeOrch(token: string, sub: OrchSubscription): Promise<DiscordBotService | null> {
    const bot = await this.getOrStart(token);
    if (!bot) return null;
    bot.subscribeOrchestrator(sub);
    let set = this.refs.get(token);
    if (!set) {
      set = new Set();
      this.refs.set(token, set);
    }
    set.add(sub.orchestratorId);
    this.orchToken.set(sub.orchestratorId, token);
    log.info({
      event: 'discord.pool.subscribed',
      orchId: sub.orchestratorId,
      channelId: sub.channelId,
      refCount: set.size,
    });
    return bot;
  }

  /**
   * Detach `orchId` from its bot. If the last orch leaves, the bot is
   * stopped and dropped from the pool — the next subscribe on that token
   * will reopen a fresh Gateway connection.
   */
  async unsubscribeOrch(orchId: string): Promise<void> {
    const token = this.orchToken.get(orchId);
    if (!token) return;
    const bot = this.pool.get(token);
    bot?.unsubscribeOrchestrator(orchId);
    this.orchToken.delete(orchId);
    const set = this.refs.get(token);
    set?.delete(orchId);
    if (set && set.size === 0) {
      this.refs.delete(token);
      this.pool.delete(token);
      log.info({ event: 'discord.pool.bot_stopping_last_unsubscribed' });
      try {
        await bot?.stop();
      } catch (err) {
        log.warn({
          event: 'discord.pool.bot_stop_failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * The bot an orch is currently bound to. `null` when the orch never
   * subscribed (no role/token) or the start originally failed.
   */
  botForOrch(orchId: string): DiscordBotService | null {
    const token = this.orchToken.get(orchId);
    if (!token) return null;
    return this.pool.get(token) ?? null;
  }

  /** Stop every bot in the pool. Used at server shutdown. */
  async stopAll(): Promise<void> {
    const bots = [...this.pool.values()];
    this.pool.clear();
    this.refs.clear();
    this.orchToken.clear();
    this.starting.clear();
    await Promise.allSettled(
      bots.map(async (bot) => {
        try {
          await bot.stop();
        } catch (err) {
          log.warn({
            event: 'discord.pool.bot_stop_failed',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
  }

  // -- internals ---------------------------------------------------------

  private async getOrStart(token: string): Promise<DiscordBotService | null> {
    const existing = this.pool.get(token);
    if (existing) return existing;
    const inFlight = this.starting.get(token);
    if (inFlight) return inFlight;

    const promise = this.startNew(token).finally(() => {
      this.starting.delete(token);
    });
    this.starting.set(token, promise);
    return promise;
  }

  private async startNew(token: string): Promise<DiscordBotService | null> {
    const bot = this.createBot(token);
    try {
      await bot.start();
      this.pool.set(token, bot);
      log.info({ event: 'discord.pool.bot_started' });
      return bot;
    } catch (err) {
      log.warn({
        event: 'discord.pool.bot_start_failed',
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        await bot.stop();
      } catch {
        /* best-effort: the start path may have left the client half-open */
      }
      return null;
    }
  }

  /**
   * Test seam: subclasses can swap in a stub `DiscordBotService` without
   * monkey-patching the real Gateway client. The production path takes
   * the default implementation.
   */
  protected createBot(token: string): DiscordBotService {
    return new DiscordBotService({ token });
  }
}

import { describe, it, expect } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext } from './tools.js';
import {
  requireLeadOrThread,
  assertAllowedReactionEmoji,
  ALLOWED_REACTION_EMOJIS,
  DEFAULT_REACTION_EMOJI,
} from './tools.js';

/**
 * Unit coverage for the Discord worker-scoping gates (feature:
 * hourglass-reactions + worker Discord capability). Both are thin, pure guards
 * the tool handlers delegate to, so exercising them directly is the honest unit:
 *   - `discord.send_message`: lead posts anywhere; a worker only inside a thread.
 *   - `discord.add_reaction`: any session, but the emoji is allowlisted so the
 *     approval-decision emojis (✅ ♾️ ❌) can never be posted through it.
 */

const ORCH = 'orch-a';
const LEAD = 'sess-lead';
const WORKER = 'sess-worker';

/** Minimal ToolContext carrying only what the gates read. */
function makeCtx(sessionId: string): ToolContext {
  return {
    orchestrator: { id: ORCH, leadSessionId: LEAD },
    session: { id: sessionId },
  } as unknown as ToolContext;
}

describe('requireLeadOrThread (discord.send_message posting rule)', () => {
  it('allows the lead at the channel root (no thread_id)', () => {
    expect(() => requireLeadOrThread(makeCtx(LEAD), undefined, 'discord.send_message')).not.toThrow();
  });

  it('allows the lead inside a thread', () => {
    expect(() =>
      requireLeadOrThread(makeCtx(LEAD), 'thread-1', 'discord.send_message'),
    ).not.toThrow();
  });

  it('allows a worker inside a thread', () => {
    expect(() =>
      requireLeadOrThread(makeCtx(WORKER), 'thread-1', 'discord.send_message'),
    ).not.toThrow();
  });

  it('refuses a worker at the channel root', () => {
    let thrown: unknown;
    try {
      requireLeadOrThread(makeCtx(WORKER), undefined, 'discord.send_message');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).message).toMatch(/PERMISSION_DENIED/);
  });
});

describe('assertAllowedReactionEmoji (discord.add_reaction allowlist)', () => {
  it('accepts every emoji in the allowlist', () => {
    for (const emoji of ALLOWED_REACTION_EMOJIS) {
      expect(() => assertAllowedReactionEmoji(emoji, 'discord.add_reaction')).not.toThrow();
    }
  });

  it('the default emoji is the hourglass and is allowed', () => {
    expect(DEFAULT_REACTION_EMOJI).toBe('⏳');
    expect(() => assertAllowedReactionEmoji(DEFAULT_REACTION_EMOJI, 'discord.add_reaction')).not.toThrow();
  });

  it('rejects the approval-decision emojis (reserved)', () => {
    for (const emoji of ['✅', '♾️', '❌']) {
      let thrown: unknown;
      try {
        assertAllowedReactionEmoji(emoji, 'discord.add_reaction');
      } catch (e) {
        thrown = e;
      }
      expect(thrown, `emoji ${emoji} must be rejected`).toBeInstanceOf(McpError);
      expect((thrown as McpError).message).toMatch(/DISCORD_EMOJI_NOT_ALLOWED/);
    }
  });

  it('rejects an arbitrary emoji not on the allowlist', () => {
    expect(() => assertAllowedReactionEmoji('💀', 'discord.add_reaction')).toThrow(
      /DISCORD_EMOJI_NOT_ALLOWED/,
    );
  });
});

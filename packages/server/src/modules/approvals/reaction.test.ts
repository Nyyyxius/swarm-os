import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../db/index.js';
import { SwarmEventBus } from '../../events.js';
import { ApprovalStore, type CreateApprovalInput } from './store.js';
import { buildApprovalReactionResolver } from './reaction.js';
import type { Spawner } from '../spawner/index.js';

/**
 * P5 reaction router — correlates a ✅/♾️/❌ reaction on an approval card to a
 * pending approval and resolves it through the SAME shared core as the reply path
 * (`reply.test.ts`). `consumed:false` means the reaction is not a decision on one
 * of our cards; a reaction is never inboxed, so the caller then does nothing.
 */

// Emojis as explicit escapes so the invisible VS16 selector never sneaks in.
const APPROVE = '✅'; // ✅
const INFINITY_VS16 = '♾️'; // ♾️ (with presentation selector)
const INFINITY_BARE = '♾'; // ♾ (as some clients deliver it)
const DENY = '❌'; // ❌
const THUMBS_UP = '\u{1F44D}'; // 👍 — not one of our three

let dir: string;
let db: SwarmDb;
let store: ApprovalStore;

const ORCH = 'orch-a';
const OTHER_ORCH = 'orch-b';
const SESSION = 'sess-1';

function insertOrch(id: string): void {
  db.db
    .prepare(
      `INSERT INTO orchestrators (id, name, role, status, default_model, default_effort, default_permission_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, `Team ${id}`, 'lead', 'running', 'claude-x', 'high', 'default', new Date().toISOString());
}

function baseInput(over: Partial<CreateApprovalInput> = {}): CreateApprovalInput {
  return {
    orchestratorId: ORCH,
    sessionId: SESSION,
    category: 'permission',
    requestedSummary: 'needs permission to use Bash',
    rawMessage: 'Claude needs your permission to use Bash',
    permissionMode: 'default',
    provider: 'claude',
    ...over,
  };
}

function fakeSpawner(keystrokes: string[] = [], present = true): Spawner {
  const session = {
    toView: () => ({ provider: 'claude' }),
    writeInput: (data: string) => keystrokes.push(data),
    submitInput: (data: string) => keystrokes.push(data),
  };
  return {
    findSession: (id: string) => (present && id === SESSION ? { session } : null),
  } as unknown as Spawner;
}

/** Create a pending approval already correlated to a Discord message id. */
function seedApproval(discordMessageId: string, over: Partial<CreateApprovalInput> = {}): string {
  const req = store.createRequest(baseInput(over));
  store.setDiscordMessageId(req!.id, discordMessageId);
  return req!.id;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-reaction-'));
  db = new SwarmDb(dir);
  insertOrch(ORCH);
  insertOrch(OTHER_ORCH);
  store = new ApprovalStore(db, { eventBus: new SwarmEventBus() });
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('buildApprovalReactionResolver', () => {
  it('resolves ✅ → consumed, keystroke "1", status approved', () => {
    const keystrokes: string[] = [];
    const id = seedApproval('dm-1');
    const resolve = buildApprovalReactionResolver({ spawner: fakeSpawner(keystrokes), store, orchestratorId: ORCH });

    const res = resolve({ messageId: 'dm-1', emoji: APPROVE, reactor: 'alice' });
    expect(res.consumed).toBe(true);
    expect(res.confirmation).toMatch(/Approuvé/);
    expect(keystrokes).toEqual(['1']);
    const stored = store.getRequest(id)!;
    expect(stored.status).toBe('approved');
    expect(stored.resolvedBy).toBe('discord:alice');
  });

  it('resolves ♾️ (with VS16) → approve + dontAskAgain, keystroke "2"', () => {
    const keystrokes: string[] = [];
    seedApproval('dm-2');
    const resolve = buildApprovalReactionResolver({ spawner: fakeSpawner(keystrokes), store, orchestratorId: ORCH });

    const res = resolve({ messageId: 'dm-2', emoji: INFINITY_VS16, reactor: 'a' });
    expect(res.consumed).toBe(true);
    expect(res.confirmation).toMatch(/ne plus demander/);
    expect(keystrokes).toEqual(['2']);
  });

  it('resolves ♾ (bare, no VS16) → keystroke "2" (robust to the selector)', () => {
    const keystrokes: string[] = [];
    seedApproval('dm-2b');
    const resolve = buildApprovalReactionResolver({ spawner: fakeSpawner(keystrokes), store, orchestratorId: ORCH });

    const res = resolve({ messageId: 'dm-2b', emoji: INFINITY_BARE, reactor: 'a' });
    expect(res.consumed).toBe(true);
    expect(keystrokes).toEqual(['2']);
  });

  it('resolves ❌ → keystroke "3", status denied', () => {
    const keystrokes: string[] = [];
    const id = seedApproval('dm-3');
    const resolve = buildApprovalReactionResolver({ spawner: fakeSpawner(keystrokes), store, orchestratorId: ORCH });

    const res = resolve({ messageId: 'dm-3', emoji: DENY, reactor: 'bob' });
    expect(res.consumed).toBe(true);
    expect(res.confirmation).toMatch(/Refusé/);
    expect(keystrokes).toEqual(['3']);
    expect(store.getRequest(id)!.status).toBe('denied');
  });

  it('does NOT consume an unknown emoji (👍) — approval untouched', () => {
    const keystrokes: string[] = [];
    const id = seedApproval('dm-4');
    const resolve = buildApprovalReactionResolver({ spawner: fakeSpawner(keystrokes), store, orchestratorId: ORCH });

    const res = resolve({ messageId: 'dm-4', emoji: THUMBS_UP, reactor: 'a' });
    expect(res.consumed).toBe(false);
    expect(res.confirmation).toBeUndefined();
    expect(keystrokes).toHaveLength(0);
    expect(store.getRequest(id)!.status).toBe('pending');
  });

  it('does NOT consume a null / empty emoji', () => {
    const resolve = buildApprovalReactionResolver({ spawner: fakeSpawner(), store, orchestratorId: ORCH });
    expect(resolve({ messageId: 'dm-4', emoji: null, reactor: 'a' }).consumed).toBe(false);
    expect(resolve({ messageId: 'dm-4', emoji: '', reactor: 'a' }).consumed).toBe(false);
  });

  it('does NOT consume a reaction on an unknown message (miss)', () => {
    const resolve = buildApprovalReactionResolver({ spawner: fakeSpawner(), store, orchestratorId: ORCH });
    const res = resolve({ messageId: 'unknown-msg', emoji: APPROVE, reactor: 'a' });
    expect(res.consumed).toBe(false);
    expect(res.confirmation).toBeUndefined();
  });

  it('is idempotent: a 2nd reaction on an already-resolved approval is a no-op ack', () => {
    const keystrokes: string[] = [];
    const id = seedApproval('dm-5');
    // First reaction wins (resolve via the shared core, e.g. an earlier ✅).
    store.resolveRequest(id, { decision: 'approved', by: 'discord:alice' });
    const resolve = buildApprovalReactionResolver({ spawner: fakeSpawner(keystrokes), store, orchestratorId: ORCH });

    const res = resolve({ messageId: 'dm-5', emoji: DENY, reactor: 'bob' });
    expect(res.consumed).toBe(true);
    expect(res.confirmation).toMatch(/déjà traitée/);
    expect(keystrokes).toHaveLength(0); // no keystroke on a terminal approval
    expect(store.getRequest(id)!.status).toBe('approved'); // unchanged — first won
  });

  it('scopes correlation by orch (a reaction in another team does not match)', () => {
    seedApproval('dm-6', { orchestratorId: ORCH });
    const resolve = buildApprovalReactionResolver({
      spawner: fakeSpawner(),
      store,
      orchestratorId: OTHER_ORCH,
    });
    const res = resolve({ messageId: 'dm-6', emoji: APPROVE, reactor: 'a' });
    expect(res.consumed).toBe(false);
  });

  it('confirms recording even when the session is gone', () => {
    const id = seedApproval('dm-7');
    const resolve = buildApprovalReactionResolver({
      spawner: fakeSpawner([], false),
      store,
      orchestratorId: ORCH,
    });
    const res = resolve({ messageId: 'dm-7', emoji: APPROVE, reactor: 'a' });
    expect(res.consumed).toBe(true);
    expect(res.confirmation).toMatch(/déjà fermée|enregistrée/);
    expect(store.getRequest(id)!.status).toBe('answered_in_console');
  });
});

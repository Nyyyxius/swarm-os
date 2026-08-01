import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../db/index.js';
import { SwarmEventBus } from '../../events.js';
import { ApprovalStore, type CreateApprovalInput } from './store.js';
import { buildApprovalReplyResolver } from './reply.js';
import type { Spawner } from '../spawner/index.js';

/**
 * P4 reply router — correlates a native Discord reply to a pending approval and
 * resolves it through the shared core. `consumed:false` means the bot lets the
 * message flow to the inbox as normal (not an approval decision).
 */

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-reply-'));
  db = new SwarmDb(dir);
  insertOrch(ORCH);
  insertOrch(OTHER_ORCH);
  store = new ApprovalStore(db, { eventBus: new SwarmEventBus() });
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('buildApprovalReplyResolver', () => {
  it('resolves an approve reply → consumed, keystroke replayed, status approved', () => {
    const keystrokes: string[] = [];
    const id = seedApproval('dm-1');
    const resolve = buildApprovalReplyResolver({ spawner: fakeSpawner(keystrokes), store, orchestratorId: ORCH });

    const res = resolve({ referenceMessageId: 'dm-1', content: 'oui ✅', author: 'alice' });
    expect(res.consumed).toBe(true);
    expect(res.confirmation).toMatch(/Approuvé/);
    expect(keystrokes).toEqual(['1']);
    const stored = store.getRequest(id)!;
    expect(stored.status).toBe('approved');
    expect(stored.resolvedBy).toBe('discord:alice');
  });

  it('resolves a deny reply → keystroke "3", status denied', () => {
    const keystrokes: string[] = [];
    const id = seedApproval('dm-2');
    const resolve = buildApprovalReplyResolver({ spawner: fakeSpawner(keystrokes), store, orchestratorId: ORCH });

    const res = resolve({ referenceMessageId: 'dm-2', content: 'non', author: 'bob' });
    expect(res.consumed).toBe(true);
    expect(res.confirmation).toMatch(/Refusé/);
    expect(keystrokes).toEqual(['3']);
    expect(store.getRequest(id)!.status).toBe('denied');
  });

  it('maps "ne plus demander" to keystroke "2"', () => {
    const keystrokes: string[] = [];
    seedApproval('dm-3');
    const resolve = buildApprovalReplyResolver({ spawner: fakeSpawner(keystrokes), store, orchestratorId: ORCH });

    const res = resolve({ referenceMessageId: 'dm-3', content: 'oui, ne plus demander', author: 'a' });
    expect(res.consumed).toBe(true);
    expect(keystrokes).toEqual(['2']);
  });

  it('does NOT consume a reply to an unknown message (flows to inbox)', () => {
    const resolve = buildApprovalReplyResolver({ spawner: fakeSpawner(), store, orchestratorId: ORCH });
    const res = resolve({ referenceMessageId: 'unknown-msg', content: 'oui', author: 'a' });
    expect(res.consumed).toBe(false);
    expect(res.confirmation).toBeUndefined();
  });

  it('does NOT consume an unrecognized reply to the approval (flows to inbox)', () => {
    const id = seedApproval('dm-4');
    const resolve = buildApprovalReplyResolver({ spawner: fakeSpawner(), store, orchestratorId: ORCH });
    const res = resolve({ referenceMessageId: 'dm-4', content: 'what does Bash do?', author: 'a' });
    expect(res.consumed).toBe(false);
    // Untouched — still pending for the web/console path.
    expect(store.getRequest(id)!.status).toBe('pending');
  });

  it('does NOT consume an ambiguous reply (both yes and no)', () => {
    const id = seedApproval('dm-5');
    const resolve = buildApprovalReplyResolver({ spawner: fakeSpawner(), store, orchestratorId: ORCH });
    const res = resolve({ referenceMessageId: 'dm-5', content: 'yes no', author: 'a' });
    expect(res.consumed).toBe(false);
    expect(store.getRequest(id)!.status).toBe('pending');
  });

  it('consumes but does not re-resolve an already-resolved approval', () => {
    const keystrokes: string[] = [];
    const id = seedApproval('dm-6');
    store.resolveRequest(id, { decision: 'approved', by: 'web' });
    const resolve = buildApprovalReplyResolver({ spawner: fakeSpawner(keystrokes), store, orchestratorId: ORCH });

    const res = resolve({ referenceMessageId: 'dm-6', content: 'non', author: 'a' });
    expect(res.consumed).toBe(true);
    expect(res.confirmation).toMatch(/déjà traitée/);
    expect(keystrokes).toHaveLength(0); // no keystroke on a terminal approval
    expect(store.getRequest(id)!.status).toBe('approved'); // unchanged
  });

  it('scopes correlation by orch (a reply in another team does not match)', () => {
    seedApproval('dm-7', { orchestratorId: ORCH });
    const resolve = buildApprovalReplyResolver({
      spawner: fakeSpawner(),
      store,
      orchestratorId: OTHER_ORCH,
    });
    const res = resolve({ referenceMessageId: 'dm-7', content: 'oui', author: 'a' });
    expect(res.consumed).toBe(false);
  });

  it('confirms recording even when the session is gone', () => {
    const id = seedApproval('dm-8');
    const resolve = buildApprovalReplyResolver({
      spawner: fakeSpawner([], false),
      store,
      orchestratorId: ORCH,
    });
    const res = resolve({ referenceMessageId: 'dm-8', content: 'oui', author: 'a' });
    expect(res.consumed).toBe(true);
    expect(res.confirmation).toMatch(/déjà fermée|enregistrée/);
    expect(store.getRequest(id)!.status).toBe('answered_in_console');
  });
});

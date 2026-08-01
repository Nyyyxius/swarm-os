import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../db/index.js';
import { SwarmEventBus } from '../../events.js';
import { ApprovalStore, type CreateApprovalInput } from './store.js';
import { resolveApproval } from './resolve.js';
import type { Spawner } from '../spawner/index.js';

/**
 * Shared resolution core (P4 extraction). This is the exact keystroke + store +
 * event logic the REST route AND the Discord-reply path both call, so it is
 * tested once here against a real store + a fake session.
 */

let dir: string;
let db: SwarmDb;
let store: ApprovalStore;

const ORCH = 'orch-a';
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

interface Keystroke {
  data: string;
  submit: boolean;
}

/** Fake spawner exposing just `findSession`, capturing keystrokes. */
function fakeSpawner(opts: {
  provider?: string;
  present?: boolean;
  throwOnWrite?: boolean;
  keystrokes?: Keystroke[];
}): Spawner {
  const provider = opts.provider ?? 'claude';
  const present = opts.present ?? true;
  const session = {
    toView: () => ({ provider }),
    writeInput: (data: string) => {
      if (opts.throwOnWrite) throw new Error('pty gone');
      opts.keystrokes?.push({ data, submit: false });
    },
    submitInput: (data: string) => {
      if (opts.throwOnWrite) throw new Error('pty gone');
      opts.keystrokes?.push({ data, submit: true });
    },
  };
  return {
    findSession: (id: string) => (present && id === SESSION ? { session } : null),
  } as unknown as Spawner;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-resolve-'));
  db = new SwarmDb(dir);
  insertOrch(ORCH);
  store = new ApprovalStore(db, { eventBus: new SwarmEventBus() });
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolveApproval (shared core)', () => {
  it('not_found for an unknown id', () => {
    const res = resolveApproval(fakeSpawner({}), store, 'nope', { decision: 'approve' });
    expect(res.outcome).toBe('not_found');
    expect(res.request).toBeNull();
  });

  it('approves: replays keystroke "1" (raw) and records approved', () => {
    const keystrokes: Keystroke[] = [];
    const req = store.createRequest(baseInput());
    const res = resolveApproval(fakeSpawner({ keystrokes }), store, req!.id, {
      decision: 'approve',
      by: 'web',
    });
    expect(res.outcome).toBe('resolved');
    expect(res.delivered).toBe(true);
    expect(res.keystroke).toBe('claude:approve(1)');
    expect(keystrokes).toEqual([{ data: '1', submit: false }]);
    expect(store.getRequest(req!.id)!.status).toBe('approved');
  });

  it('approve + dontAskAgain: keystroke "2"', () => {
    const keystrokes: Keystroke[] = [];
    const req = store.createRequest(baseInput());
    const res = resolveApproval(fakeSpawner({ keystrokes }), store, req!.id, {
      decision: 'approve',
      dontAskAgain: true,
    });
    expect(res.delivered).toBe(true);
    expect(keystrokes).toEqual([{ data: '2', submit: false }]);
  });

  it('denies: keystroke "3" and records denied', () => {
    const keystrokes: Keystroke[] = [];
    const req = store.createRequest(baseInput());
    const res = resolveApproval(fakeSpawner({ keystrokes }), store, req!.id, { decision: 'deny' });
    expect(res.outcome).toBe('resolved');
    expect(keystrokes).toEqual([{ data: '3', submit: false }]);
    expect(store.getRequest(req!.id)!.status).toBe('denied');
  });

  it('already_resolved: no keystroke, returns terminal state', () => {
    const keystrokes: Keystroke[] = [];
    const req = store.createRequest(baseInput());
    store.resolveRequest(req!.id, { decision: 'approved', by: 'web' });
    const res = resolveApproval(fakeSpawner({ keystrokes }), store, req!.id, { decision: 'deny' });
    expect(res.outcome).toBe('already_resolved');
    expect(keystrokes).toHaveLength(0);
    expect(res.request?.status).toBe('approved');
  });

  it('session_gone: records answered_in_console, types nothing', () => {
    const keystrokes: Keystroke[] = [];
    const req = store.createRequest(baseInput());
    const res = resolveApproval(fakeSpawner({ present: false, keystrokes }), store, req!.id, {
      decision: 'approve',
    });
    expect(res.outcome).toBe('session_gone');
    expect(keystrokes).toHaveLength(0);
    expect(store.getRequest(req!.id)!.status).toBe('answered_in_console');
  });

  it('noMapping: records the decision but delivers nothing for a non-claude provider', () => {
    const keystrokes: Keystroke[] = [];
    const req = store.createRequest(baseInput({ provider: 'gemini' }));
    const res = resolveApproval(fakeSpawner({ provider: 'gemini', keystrokes }), store, req!.id, {
      decision: 'approve',
    });
    expect(res.outcome).toBe('resolved');
    expect(res.delivered).toBe(false);
    expect(res.noMapping).toBe(true);
    expect(keystrokes).toHaveLength(0);
    expect(store.getRequest(req!.id)!.status).toBe('approved');
  });

  it('a PTY write failure still records the decision (delivered=false)', () => {
    const req = store.createRequest(baseInput());
    const res = resolveApproval(fakeSpawner({ throwOnWrite: true }), store, req!.id, {
      decision: 'approve',
    });
    expect(res.outcome).toBe('resolved');
    expect(res.delivered).toBe(false);
    expect(store.getRequest(req!.id)!.status).toBe('approved');
  });
});

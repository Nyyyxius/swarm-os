import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../db/index.js';
import { SwarmEventBus, type SwarmEvent } from '../../events.js';
import { ApprovalStore, type CreateApprovalInput } from './store.js';

let dir: string;
let db: SwarmDb;
let bus: SwarmEventBus;
let events: SwarmEvent[];
let store: ApprovalStore;

const ORCH_A = 'orch-a';
const ORCH_B = 'orch-b';
const SESSION_1 = 'sess-1';
const SESSION_2 = 'sess-2';

/** Insert a minimal orchestrator row so the FK (approvals → orchestrators) holds. */
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
    orchestratorId: ORCH_A,
    sessionId: SESSION_1,
    category: 'permission',
    requestedSummary: 'needs permission to use Bash',
    rawMessage: 'Claude needs your permission to use Bash',
    permissionMode: 'default',
    provider: 'claude',
    ...over,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-store-'));
  db = new SwarmDb(dir);
  bus = new SwarmEventBus();
  events = [];
  bus.onEvent((e) => events.push(e));
  insertOrch(ORCH_A);
  insertOrch(ORCH_B);
  store = new ApprovalStore(db, { eventBus: bus });
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('createRequest', () => {
  it('creates a pending approval and returns it', () => {
    const req = store.createRequest(baseInput());
    expect(req).not.toBeNull();
    expect(req!.id).toBeTruthy();
    expect(req!.status).toBe('pending');
    expect(req!.category).toBe('permission');
    expect(req!.provider).toBe('claude');
    expect(req!.permissionMode).toBe('default');
    expect(req!.resolvedAt).toBeNull();
    expect(req!.decision).toBeNull();

    const fetched = store.getRequest(req!.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.requestedSummary).toBe('needs permission to use Bash');
    expect(fetched!.rawMessage).toBe('Claude needs your permission to use Bash');
  });

  it('emits approval.requested with a per-team payload + writes a journal row', () => {
    const req = store.createRequest(baseInput());
    const emitted = events.filter((e) => e.kind === 'approval.requested');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].orchestratorId).toBe(ORCH_A);
    expect(emitted[0].sessionId).toBe(SESSION_1);
    const payload = emitted[0].payload as Record<string, unknown>;
    expect(payload.approvalId).toBe(req!.id);
    expect(payload.category).toBe('permission');
    expect(payload.requestedSummary).toBe('needs permission to use Bash');
    expect(payload.status).toBe('pending');

    const journal = store.listEvents(req!.id);
    expect(journal).toHaveLength(1);
    expect(journal[0].kind).toBe('requested');
  });

  it('normalizes an unknown category to permission', () => {
    const req = store.createRequest(baseInput({ category: 'weird' as never }));
    expect(req!.category).toBe('permission');
  });

  it('is defensive: returns null on a missing orchestratorId, never throws', () => {
    expect(store.createRequest(baseInput({ orchestratorId: '' }))).toBeNull();
    expect(store.createRequest(baseInput({ sessionId: '' }))).toBeNull();
  });
});

describe('listPending / listBySession', () => {
  it('lists pending requests, optionally scoped to one team, oldest first', () => {
    const a = store.createRequest(baseInput({ orchestratorId: ORCH_A, sessionId: SESSION_1 }));
    const b = store.createRequest(baseInput({ orchestratorId: ORCH_B, sessionId: SESSION_2 }));
    expect(a && b).toBeTruthy();

    const all = store.listPending();
    expect(all.map((r) => r.id).sort()).toEqual([a!.id, b!.id].sort());

    const teamA = store.listPending(ORCH_A);
    expect(teamA).toHaveLength(1);
    expect(teamA[0].id).toBe(a!.id);
  });

  it('excludes resolved requests from listPending', () => {
    const a = store.createRequest(baseInput());
    store.resolveRequest(a!.id, { decision: 'approved', by: 'web' });
    expect(store.listPending()).toHaveLength(0);
  });

  it('listBySession returns every status for a session, newest first', () => {
    const first = store.createRequest(baseInput({ sessionId: SESSION_1 }));
    const second = store.createRequest(baseInput({ sessionId: SESSION_1 }));
    store.createRequest(baseInput({ sessionId: SESSION_2 }));
    store.resolveRequest(first!.id, { decision: 'denied', by: 'discord' });

    const bySession = store.listBySession(SESSION_1);
    expect(bySession).toHaveLength(2);
    expect(bySession[0].id).toBe(second!.id); // newest first
    expect(bySession.find((r) => r.id === first!.id)!.status).toBe('denied');
  });
});

describe('resolveRequest (P2 path, implemented)', () => {
  it('stamps status/resolvedAt/resolvedBy/decision + emits approval.resolved', () => {
    const req = store.createRequest(baseInput());
    events.length = 0;
    const resolved = store.resolveRequest(req!.id, { decision: 'approved', by: 'operator-1' });
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe('approved');
    expect(resolved!.decision).toBe('approved');
    expect(resolved!.resolvedBy).toBe('operator-1');
    expect(resolved!.resolvedAt).toBeGreaterThan(0);

    const emitted = events.filter((e) => e.kind === 'approval.resolved');
    expect(emitted).toHaveLength(1);
    expect((emitted[0].payload as Record<string, unknown>).decision).toBe('approved');

    const journalKinds = store.listEvents(req!.id).map((e) => e.kind);
    expect(journalKinds).toEqual(['requested', 'resolved']);
  });

  it('maps answered_in_console decision to that status', () => {
    const req = store.createRequest(baseInput());
    const resolved = store.resolveRequest(req!.id, { decision: 'answered_in_console', by: null });
    expect(resolved!.status).toBe('answered_in_console');
  });

  it('is idempotent: a second resolve leaves the first decision intact', () => {
    const req = store.createRequest(baseInput());
    store.resolveRequest(req!.id, { decision: 'approved', by: 'a' });
    const again = store.resolveRequest(req!.id, { decision: 'denied', by: 'b' });
    expect(again!.status).toBe('approved');
    expect(again!.resolvedBy).toBe('a');
  });

  it('returns null for an unknown id', () => {
    expect(store.resolveRequest('nope', { decision: 'approved', by: null })).toBeNull();
  });
});

describe('expireOlderThan (P2 janitor stub, implemented)', () => {
  it('flags only pending requests older than the cutoff as expired', () => {
    const old = store.createRequest(baseInput());
    // Backdate the row so it is older than the max age.
    db.db
      .prepare('UPDATE approval_requests SET created_at = ? WHERE id = ?')
      .run(Date.now() - 60_000, old!.id);
    const fresh = store.createRequest(baseInput());

    const n = store.expireOlderThan(30_000);
    expect(n).toBe(1);
    expect(store.getRequest(old!.id)!.status).toBe('expired');
    expect(store.getRequest(fresh!.id)!.status).toBe('pending');

    const journalKinds = store.listEvents(old!.id).map((e) => e.kind);
    expect(journalKinds).toContain('expired');
  });

  it('does not touch already-resolved requests', () => {
    const req = store.createRequest(baseInput());
    store.resolveRequest(req!.id, { decision: 'approved', by: 'web' });
    db.db
      .prepare('UPDATE approval_requests SET created_at = ? WHERE id = ?')
      .run(Date.now() - 60_000, req!.id);
    expect(store.expireOlderThan(1_000)).toBe(0);
    expect(store.getRequest(req!.id)!.status).toBe('approved');
  });
});

describe('persistence', () => {
  it('survives a store re-open on the same DB (persisted queue)', () => {
    const req = store.createRequest(baseInput());
    const reopened = new ApprovalStore(db, { eventBus: bus });
    const fetched = reopened.getRequest(req!.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.status).toBe('pending');
    expect(reopened.listPending(ORCH_A)).toHaveLength(1);
  });
});

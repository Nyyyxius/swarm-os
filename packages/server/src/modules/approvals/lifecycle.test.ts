import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../db/index.js';
import { SwarmEventBus, type SwarmEvent } from '../../events.js';
import { ApprovalStore, type CreateApprovalInput } from './store.js';
import { startApprovalJanitor } from './lifecycle.js';

let dir: string;
let db: SwarmDb;
let bus: SwarmEventBus;
let events: SwarmEvent[];
let store: ApprovalStore;

const ORCH_A = 'orch-a';
const SESSION_1 = 'sess-1';

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

/** Backdate a request's created_at so a TTL cutoff catches it. */
function backdate(id: string, ageMs: number): void {
  db.db
    .prepare('UPDATE approval_requests SET created_at = ? WHERE id = ?')
    .run(Date.now() - ageMs, id);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-janitor-'));
  db = new SwarmDb(dir);
  bus = new SwarmEventBus();
  events = [];
  bus.onEvent((e) => events.push(e));
  insertOrch(ORCH_A);
  store = new ApprovalStore(db, { eventBus: bus });
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('startApprovalJanitor', () => {
  it('flags a pending approval older than the TTL as expired on the immediate sweep', () => {
    const a = store.createRequest(baseInput());
    expect(a).not.toBeNull();
    backdate(a!.id, 10 * 24 * 60 * 60 * 1000); // 10 days old

    const handle = startApprovalJanitor(store, {
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      intervalMs: 60_000,
    });

    const after = store.getRequest(a!.id);
    expect(after?.status).toBe('expired');
    handle.stop();
  });

  it('is a cleanup flag, NEVER an auto-deny (no deny decision, no denied status)', () => {
    const a = store.createRequest(baseInput());
    backdate(a!.id, 10 * 24 * 60 * 60 * 1000);

    const handle = startApprovalJanitor(store, {
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      intervalMs: 60_000,
    });
    handle.stop();

    const after = store.getRequest(a!.id);
    expect(after?.status).toBe('expired');
    // The product decision: expiry is not a denial. Decision must not be 'deny'.
    expect(after?.decision).not.toBe('deny');
    expect(after?.decision).not.toBe('approve');
    expect(after?.status).not.toBe('denied');
    // No approval.resolved event should carry a deny decision from the janitor.
    const denies = events.filter(
      (e) => e.kind === 'approval.resolved' && (e.payload as { decision?: string })?.decision === 'deny',
    );
    expect(denies).toHaveLength(0);
  });

  it('leaves fresh (within-TTL) pending approvals untouched', () => {
    const a = store.createRequest(baseInput());
    // No backdate — created just now, well within a 7-day TTL.

    const handle = startApprovalJanitor(store, {
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      intervalMs: 60_000,
    });
    handle.stop();

    const after = store.getRequest(a!.id);
    expect(after?.status).toBe('pending');
  });

  it('sweeps again on the interval tick', () => {
    vi.useFakeTimers();
    try {
      const handle = startApprovalJanitor(store, {
        ttlMs: 7 * 24 * 60 * 60 * 1000,
        intervalMs: 60_000,
      });
      // Created AFTER the immediate sweep; backdated so the next tick catches it.
      const a = store.createRequest(baseInput());
      backdate(a!.id, 10 * 24 * 60 * 60 * 1000);
      expect(store.getRequest(a!.id)?.status).toBe('pending');

      vi.advanceTimersByTime(60_000);
      expect(store.getRequest(a!.id)?.status).toBe('expired');
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is disabled (no-op stop) when ttlMs <= 0', () => {
    const a = store.createRequest(baseInput());
    backdate(a!.id, 10 * 24 * 60 * 60 * 1000);

    const handle = startApprovalJanitor(store, { ttlMs: 0, intervalMs: 60_000 });
    handle.stop();

    // Disabled → nothing swept.
    expect(store.getRequest(a!.id)?.status).toBe('pending');
  });
});

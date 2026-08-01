/**
 * `/api/approvals/*` — the P2 resolution channel end to end over HTTP.
 *
 * Real `ApprovalStore` on a temp SwarmDb (so getRequest/resolveRequest/list are
 * exercised for real) + a fake Spawner whose session records the keystrokes the
 * route sends. That combination is what lets us assert the two effects of a
 * resolve — the PTY keystroke AND the persisted decision — without a live PTY.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { SwarmDb } from '../../modules/db/index.js';
import { SwarmEventBus } from '../../events.js';
import { ApprovalStore } from '../../modules/approvals/store.js';
import type { Spawner } from '../../modules/spawner/index.js';
import { createApprovalsRouter } from './approvals.js';

const ORCH = 'orch-1';
const SESSION = 'sess-1';

let dir: string;
let db: SwarmDb;
let store: ApprovalStore;
let listening: Server | null = null;

/** Records what the route typed into the "PTY". */
interface FakeSession {
  writes: string[];
  submits: string[];
}

function insertOrch(id: string): void {
  db.db
    .prepare(
      `INSERT INTO orchestrators (id, name, role, status, default_model, default_effort, default_permission_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, `Team ${id}`, 'lead', 'running', 'claude-x', 'high', 'default', new Date().toISOString());
}

/**
 * Fake spawner: `findSession` returns a session (with the given provider) for
 * the ids present in `sessions`, else null (the "session gone" branch).
 */
function fakeSpawner(opts: { provider?: string; present?: boolean } = {}): {
  spawner: Spawner;
  session: FakeSession;
} {
  const present = opts.present ?? true;
  const provider = opts.provider ?? 'claude';
  const session: FakeSession = { writes: [], submits: [] };
  const sessionObj = {
    toView: () => ({ provider }),
    writeInput: (d: string) => session.writes.push(d),
    submitInput: (d: string) => session.submits.push(d),
  };
  const spawner = {
    findSession: (id: string) =>
      present && id === SESSION ? { session: sessionObj, orchestrator: { id: ORCH } } : null,
  } as unknown as Spawner;
  return { spawner, session };
}

async function serve(spawner: Spawner): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(createApprovalsRouter(spawner, store));
  const server = createServer(app);
  listening = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

function seedPending(over: { sessionId?: string; provider?: string } = {}) {
  return store.createRequest({
    orchestratorId: ORCH,
    sessionId: over.sessionId ?? SESSION,
    category: 'permission',
    requestedSummary: 'use Bash',
    rawMessage: 'Claude needs your permission to use Bash',
    permissionMode: 'default',
    provider: over.provider ?? 'claude',
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-route-'));
  db = new SwarmDb(dir);
  store = new ApprovalStore(db, { eventBus: new SwarmEventBus() });
  insertOrch(ORCH);
});

afterEach(async () => {
  if (listening) {
    await new Promise<void>((resolve) => listening!.close(() => resolve()));
    listening = null;
  }
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function post(base: string, id: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api/approvals/${id}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe('GET /api/approvals', () => {
  it('requires orch', async () => {
    const base = await serve(fakeSpawner().spawner);
    const res = await fetch(`${base}/api/approvals`);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('ORCH_REQUIRED');
  });

  it('lists a team approvals and filters by status', async () => {
    const a = seedPending();
    const b = seedPending();
    store.resolveRequest(b!.id, { decision: 'approved', by: 'web' });
    const base = await serve(fakeSpawner().spawner);

    const all = await (await fetch(`${base}/api/approvals?orch=${ORCH}`)).json();
    expect(all.approvals).toHaveLength(2);

    const pending = await (await fetch(`${base}/api/approvals?orch=${ORCH}&status=pending`)).json();
    expect(pending.approvals).toHaveLength(1);
    expect(pending.approvals[0].id).toBe(a!.id);
  });

  it('rejects an invalid status', async () => {
    const base = await serve(fakeSpawner().spawner);
    const res = await fetch(`${base}/api/approvals?orch=${ORCH}&status=bogus`);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_STATUS');
  });
});

describe('GET /api/approvals/:id', () => {
  it('404s for an unknown id', async () => {
    const base = await serve(fakeSpawner().spawner);
    const res = await fetch(`${base}/api/approvals/nope`);
    expect(res.status).toBe(404);
  });

  it('returns the request with its journal', async () => {
    const a = seedPending();
    const base = await serve(fakeSpawner().spawner);
    const res = await fetch(`${base}/api/approvals/${a!.id}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe(a!.id);
    expect(Array.isArray(json.events)).toBe(true);
    expect(json.events[0].kind).toBe('requested');
  });
});

describe('POST /api/approvals/:id/resolve', () => {
  it('approve → sends keystroke "1" and records approved', async () => {
    const a = seedPending();
    const { spawner, session } = fakeSpawner();
    const base = await serve(spawner);
    const { status, json } = await post(base, a!.id, { decision: 'approve', by: 'op-1' });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.delivered).toBe(true);
    expect(json.decision).toBe('approved');
    expect(session.writes).toEqual(['1']);
    expect(store.getRequest(a!.id)!.status).toBe('approved');
    expect(store.getRequest(a!.id)!.resolvedBy).toBe('op-1');
  });

  it('deny → sends keystroke "3" and records denied', async () => {
    const a = seedPending();
    const { spawner, session } = fakeSpawner();
    const base = await serve(spawner);
    const { json } = await post(base, a!.id, { decision: 'deny' });
    expect(json.decision).toBe('denied');
    expect(session.writes).toEqual(['3']);
    expect(store.getRequest(a!.id)!.status).toBe('denied');
  });

  it('approve + dontAskAgain → sends "2" and records it in the audit', async () => {
    const a = seedPending();
    const { spawner, session } = fakeSpawner();
    const base = await serve(spawner);
    const { json } = await post(base, a!.id, { decision: 'approve', dontAskAgain: true });
    expect(json.dontAskAgain).toBe(true);
    expect(session.writes).toEqual(['2']);
    const resolvedEvent = store.listEvents(a!.id).find((e) => e.kind === 'resolved');
    expect(resolvedEvent!.data!.dontAskAgain).toBe(true);
  });

  it('is idempotent: a second resolve → 409 ALREADY_RESOLVED, no extra keystroke', async () => {
    const a = seedPending();
    const { spawner, session } = fakeSpawner();
    const base = await serve(spawner);
    await post(base, a!.id, { decision: 'approve' });
    const second = await post(base, a!.id, { decision: 'deny' });
    expect(second.status).toBe(409);
    expect(second.json.code).toBe('ALREADY_RESOLVED');
    expect(second.json.status).toBe('approved');
    // Only the first resolve typed anything.
    expect(session.writes).toEqual(['1']);
  });

  it('404s for an unknown approval', async () => {
    const base = await serve(fakeSpawner().spawner);
    const { status, json } = await post(base, 'nope', { decision: 'approve' });
    expect(status).toBe(404);
    expect(json.code).toBe('NOT_FOUND');
  });

  it('400s on an invalid decision', async () => {
    const a = seedPending();
    const base = await serve(fakeSpawner().spawner);
    const { status, json } = await post(base, a!.id, { decision: 'maybe' });
    expect(status).toBe(400);
    expect(json.code).toBe('INVALID_DECISION');
  });

  it('session gone → records answered_in_console, nothing typed', async () => {
    const a = seedPending();
    const { spawner, session } = fakeSpawner({ present: false });
    const base = await serve(spawner);
    const { status, json } = await post(base, a!.id, { decision: 'approve' });
    expect(status).toBe(200);
    expect(json.delivered).toBe(false);
    expect(json.reason).toBe('session_gone');
    expect(json.status).toBe('answered_in_console');
    expect(session.writes).toEqual([]);
    expect(store.getRequest(a!.id)!.status).toBe('answered_in_console');
  });

  it('provider with no keystroke mapping → records decision, delivered:false', async () => {
    const a = seedPending({ provider: 'gemini' });
    const { spawner, session } = fakeSpawner({ provider: 'gemini' });
    const base = await serve(spawner);
    const { json } = await post(base, a!.id, { decision: 'approve' });
    expect(json.delivered).toBe(false);
    expect(json.reason).toBe('no_keystroke_mapping');
    expect(json.decision).toBe('approved');
    expect(session.writes).toEqual([]);
    expect(store.getRequest(a!.id)!.status).toBe('approved');
  });
});

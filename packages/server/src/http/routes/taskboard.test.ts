import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../../modules/db/index.js';
import { TaskboardStore, type TaskboardCard } from '../../modules/taskboard/store.js';
import { createTaskboardRouter } from './taskboard.js';

let dir: string;
let db: SwarmDb;
let store: TaskboardStore;
let listening: Server | null = null;
let base: string;

const ORCH_A = 'orch-a';
const ORCH_B = 'orch-b';
const WORKER = 'sess-worker';

function insertOrch(id: string): void {
  db.db
    .prepare(
      `INSERT INTO orchestrators (id, name, role, status, default_model, default_effort, default_permission_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, `Team ${id}`, 'lead', 'running', 'claude-x', 'high', 'default', new Date().toISOString());
}

async function start(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(createTaskboardRouter(store));
  const server = createServer(app);
  listening = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-http-'));
  db = new SwarmDb(dir);
  insertOrch(ORCH_A);
  insertOrch(ORCH_B);
  store = new TaskboardStore(db);
  await start();
});

afterEach(async () => {
  if (listening) await new Promise<void>((resolve) => listening!.close(() => resolve()));
  listening = null;
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('taskboard REST router', () => {
  it('GET /api/board lists a team\'s cards, filtered by status and assignee', async () => {
    const a = store.createCard({ orchestratorId: ORCH_A, title: 'A todo', createdBy: 'lead' });
    store.moveCard({ id: a.id, status: 'doing', actorSessionId: 'lead' });
    store.createCard({ orchestratorId: ORCH_A, title: 'A assigned', assignee: WORKER, createdBy: 'lead' });
    // A card on another team must not leak into ORCH_A's board.
    store.createCard({ orchestratorId: ORCH_B, title: 'B card', createdBy: 'lead' });

    const all = await fetch(`${base}/api/board?orch=${ORCH_A}`);
    expect(all.status).toBe(200);
    const body = (await all.json()) as { cards: TaskboardCard[] };
    expect(body.cards).toHaveLength(2);
    expect(body.cards.every((c) => c.orchestratorId === ORCH_A)).toBe(true);

    const doing = await fetch(`${base}/api/board?orch=${ORCH_A}&status=doing`);
    const doingBody = (await doing.json()) as { cards: TaskboardCard[] };
    expect(doingBody.cards.map((c) => c.title)).toEqual(['A todo']);

    const mine = await fetch(`${base}/api/board?orch=${ORCH_A}&assignee=${WORKER}`);
    const mineBody = (await mine.json()) as { cards: TaskboardCard[] };
    expect(mineBody.cards.map((c) => c.title)).toEqual(['A assigned']);
  });

  it('GET /api/board without orch is 400', async () => {
    const res = await fetch(`${base}/api/board`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('ORCH_REQUIRED');
  });

  it('GET /api/board with an invalid status is 400', async () => {
    const res = await fetch(`${base}/api/board?orch=${ORCH_A}&status=nope`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_STATUS');
  });

  it('GET /api/board/card/:id returns the card + deps + journal, 404 when absent', async () => {
    const dep = store.createCard({ orchestratorId: ORCH_A, title: 'dep', createdBy: 'lead' });
    const card = store.createCard({
      orchestratorId: ORCH_A,
      title: 'main',
      createdBy: 'lead',
      dependsOn: [dep.id],
    });
    store.comment({ id: card.id, text: 'a note', actorSessionId: 'lead' });

    const res = await fetch(`${base}/api/board/card/${card.id}`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as {
      id: string;
      dependsOn: string[];
      events: { kind: string }[];
    };
    expect(detail.id).toBe(card.id);
    expect(detail.dependsOn).toEqual([dep.id]);
    expect(detail.events.some((e) => e.kind === 'created')).toBe(true);
    expect(detail.events.some((e) => e.kind === 'comment')).toBe(true);

    const missing = await fetch(`${base}/api/board/card/does-not-exist`);
    expect(missing.status).toBe(404);
  });

  it('GET /api/board/teams lists orchestrators with card counts', async () => {
    const closed = store.createCard({ orchestratorId: ORCH_A, title: 'to close', createdBy: 'lead' });
    store.createCard({ orchestratorId: ORCH_A, title: 'open', createdBy: 'lead' });
    store.closeCard({ id: closed.id, actorSessionId: 'lead' });
    store.createCard({ orchestratorId: ORCH_B, title: 'b', createdBy: 'lead' });

    const res = await fetch(`${base}/api/board/teams`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { teams: { orchestratorId: string; total: number; open: number }[] };
    const a = body.teams.find((t) => t.orchestratorId === ORCH_A);
    const b = body.teams.find((t) => t.orchestratorId === ORCH_B);
    expect(a).toEqual({ orchestratorId: ORCH_A, total: 2, open: 1 });
    expect(b).toEqual({ orchestratorId: ORCH_B, total: 1, open: 1 });
  });

  it('DELETE /api/board/card/:id soft-deletes (idempotent) and hides the card', async () => {
    const card = store.createCard({ orchestratorId: ORCH_A, title: 'kill me', createdBy: 'lead' });

    const del = await fetch(`${base}/api/board/card/${card.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await del.json()) as { ok: boolean; deleted: boolean }).toEqual({ ok: true, deleted: true });

    // Gone from the listing…
    const list = await fetch(`${base}/api/board?orch=${ORCH_A}`);
    expect(((await list.json()) as { cards: TaskboardCard[] }).cards).toHaveLength(0);

    // …and a second DELETE is a no-op (deleted:false), not an error.
    const again = await fetch(`${base}/api/board/card/${card.id}`, { method: 'DELETE' });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { deleted: boolean }).deleted).toBe(false);
  });

  it('DELETE of an unknown card is 404', async () => {
    const res = await fetch(`${base}/api/board/card/nope`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_FOUND');
  });
});

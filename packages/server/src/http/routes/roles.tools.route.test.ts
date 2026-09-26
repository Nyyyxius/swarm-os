/**
 * docs/outils-par-role.md (v0.10.2) — the four tool allow-lists of a role, end
 * to end through a REAL `SwarmDb` (the columns are additive: a field missing
 * from the UPDATE would be written once and never changed again, silently).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRolesRouter } from './roles.js';
import { SwarmDb } from '../../modules/db/index.js';
import { RoleStore } from '../../modules/roles/index.js';
import type { Config } from '../../config.js';

let listening: Server | null = null;
let tmpRoot: string;
let db: SwarmDb;
let store: RoleStore;
let base: string;

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-tools-'));
  db = new SwarmDb(path.join(tmpRoot, 'data'));
  store = new RoleStore(db);
  const app = express();
  app.use(express.json());
  app.use(createRolesRouter(store, { maxWorkersPerOrch: 8 } as unknown as Config));
  const server = createServer(app);
  listening = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${addr && typeof addr === 'object' ? addr.port : 0}`;
});

afterEach(async () => {
  if (listening) {
    await new Promise<void>((resolve) => listening!.close(() => resolve()));
    listening = null;
  }
  try {
    db.close?.();
  } catch {
    /* best-effort */
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function send(method: string, url: string, body: unknown): Promise<Response> {
  return fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createRole(over: Record<string, unknown> = {}): Promise<string> {
  const res = await send('POST', '/roles', { label: 'TOOLS', ...over });
  expect(res.status).toBe(201);
  return (await res.json()).role.id as string;
}

describe('role tool allow-lists', () => {
  it('defaults every list to null (= every tool)', async () => {
    const id = await createRole();
    const r = store.get(id)!;
    expect([r.leadTools, r.workerTools, r.leadMcpTools, r.workerMcpTools]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it('stores lists on create, trimmed and de-duplicated in order', async () => {
    const id = await createRole({
      leadTools: [' Bash ', 'Read', 'Bash'],
      workerMcpTools: ['memory.search'],
    });
    expect(store.get(id)!.leadTools).toEqual(['Bash', 'Read']);
    expect(store.get(id)!.workerMcpTools).toEqual(['memory.search']);
    expect(store.get(id)!.workerTools).toBeNull();
  });

  it('updates, keeps absent fields unchanged, and clears with null', async () => {
    const id = await createRole({ leadTools: ['Bash'], workerTools: ['Read'] });
    let res = await send('PATCH', `/roles/${id}`, { workerTools: ['Read', 'Edit'] });
    expect(res.status).toBe(200);
    expect(store.get(id)!.leadTools).toEqual(['Bash']);
    expect(store.get(id)!.workerTools).toEqual(['Read', 'Edit']);
    res = await send('PATCH', `/roles/${id}`, { leadTools: null, leadMcpTools: ['board.list'] });
    expect(res.status).toBe(200);
    expect(store.get(id)!.leadTools).toBeNull();
    expect(store.get(id)!.leadMcpTools).toEqual(['board.list']);
    expect(store.get(id)!.workerTools).toEqual(['Read', 'Edit']);
    const body = (await res.json()).role;
    expect(body.leadMcpTools).toEqual(['board.list']);
  });

  it.each([
    [[]],
    ['Bash'],
    [[1]],
    [['']],
    [['Bash,Read']],
    [['Bash Read']],
  ])('refuses %j with a 400 and writes nothing', async (bad) => {
    const id = await createRole({ leadTools: ['Bash'] });
    const res = await send('PATCH', `/roles/${id}`, { leadTools: bad });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/leadTools/);
    expect(store.get(id)!.leadTools).toEqual(['Bash']);
  });

  it('reads a corrupt column back as null rather than as "no tools"', async () => {
    const id = await createRole({ workerTools: ['Bash'] });
    const raw = (db as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db;
    raw.prepare('UPDATE roles SET worker_tools_json = ? WHERE id = ?').run('not json', id);
    expect(store.get(id)!.workerTools).toBeNull();
  });
});

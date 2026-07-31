import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../../modules/db/index.js';
import { MemoryStore } from '../../modules/memory/store.js';
import { createMemoryRouter } from './memory.js';

let dir: string;
let db: SwarmDb;
let store: MemoryStore;
let listening: Server | null = null;
let base: string;

async function start(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(createMemoryRouter(store));
  const server = createServer(app);
  listening = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-http-'));
  db = new SwarmDb(dir);
  store = new MemoryStore(db, { dataDir: dir });
  await start();
});

afterEach(async () => {
  if (listening) await new Promise<void>((resolve) => listening!.close(() => resolve()));
  listening = null;
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('memory REST router', () => {
  it('PUT creates a note and GET returns the full MemoryNote', async () => {
    const put = await fetch(`${base}/api/memory/alpha-note`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'alpha', type: 'project', body: 'links to [[beta]]' }),
    });
    expect(put.status).toBe(200);
    const created = (await put.json()) as { name: string; version: number; outLinks: string[] };
    expect(created.name).toBe('alpha-note');
    expect(created.version).toBe(1);
    expect(created.outLinks).toEqual(['beta']);

    const get = await fetch(`${base}/api/memory/alpha-note`);
    expect(get.status).toBe(200);
    const note = (await get.json()) as { description: string; body: string };
    expect(note.description).toBe('alpha');
    expect(note.body).toContain('[[beta]]');
  });

  it('GET a missing note is 404', async () => {
    const res = await fetch(`${base}/api/memory/nope`);
    expect(res.status).toBe(404);
  });

  it('PUT with a stale expectedVersion is 409', async () => {
    await fetch(`${base}/api/memory/n`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'v1', type: 'project', body: 'x' }),
    });
    await fetch(`${base}/api/memory/n`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'v2', type: 'project', body: 'y', expectedVersion: 1 }),
    });
    const stale = await fetch(`${base}/api/memory/n`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'v3', type: 'project', body: 'z', expectedVersion: 1 }),
    });
    expect(stale.status).toBe(409);
    const err = (await stale.json()) as { code: string; currentVersion: number };
    expect(err.code).toBe('VERSION_CONFLICT');
    expect(err.currentVersion).toBe(2);
  });

  it('PUT with an invalid type is 400', async () => {
    const res = await fetch(`${base}/api/memory/x`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: '', type: 'bogus', body: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /api/memory lists metas and /graph returns nodes+edges', async () => {
    await fetch(`${base}/api/memory/a`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'aa', type: 'project', body: '[[b]]' }),
    });
    const list = (await (await fetch(`${base}/api/memory`)).json()) as { notes: Array<{ name: string }> };
    expect(list.notes.map((n) => n.name)).toContain('a');

    const graph = (await (await fetch(`${base}/api/memory/graph`)).json()) as {
      nodes: Array<{ name: string }>;
      edges: Array<{ from: string; to: string }>;
    };
    expect(graph.nodes.map((n) => n.name)).toContain('a');
    expect(graph.edges).toContainEqual({ from: 'a', to: 'b' });
  });

  it('GET /api/memory/search returns ranked hits; DELETE removes the note', async () => {
    await fetch(`${base}/api/memory/searchable`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'about the parser', type: 'project', body: 'refactor' }),
    });
    const hits = (await (await fetch(`${base}/api/memory/search?q=parser`)).json()) as {
      results: Array<{ name: string }>;
    };
    expect(hits.results.map((r) => r.name)).toContain('searchable');

    const del = await fetch(`${base}/api/memory/searchable`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await del.json()) as { ok: boolean }).toEqual({ ok: true });
    expect((await fetch(`${base}/api/memory/searchable`)).status).toBe(404);
  });
});

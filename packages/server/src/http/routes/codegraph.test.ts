import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../../modules/db/index.js';
import { GraphStore } from '../../modules/codegraph/store.js';
import { createCodegraphRouter } from './codegraph.js';

let dir: string;
let db: SwarmDb;
let store: GraphStore;
let listening: Server | null = null;
let base: string;

const NODES = [
  { id: 'a_hello', label: 'hello()', source_file: 'a.py', source_location: 'L1', file_type: 'code', community_name: 'a.py', norm_label: 'hello' },
  { id: 'a_greet', label: 'greet()', source_file: 'a.py', source_location: 'L3', file_type: 'code', community_name: 'a.py', norm_label: 'greet' },
];

function seedScope(id: string): void {
  store.upsertScope({ id, kind: 'project', path: `/ws/${id}`, enabled: true });
  store.recordIndexResult(id, { nodeCount: NODES.length, edgeCount: 1, sourceHash: 'h' });
  const outDir = path.join(store.indexDirFor(id), 'graphify-out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'graph.json'), JSON.stringify({ directed: false, nodes: NODES, links: [{ source: 'a_hello', target: 'a_greet' }] }));
}

async function start(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(createCodegraphRouter(store));
  const server = createServer(app);
  listening = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-http-'));
  db = new SwarmDb(dir);
  store = new GraphStore(db, { dataDir: dir });
  await start();
});

afterEach(async () => {
  if (listening) await new Promise<void>((resolve) => listening!.close(() => resolve()));
  listening = null;
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('codegraph REST router', () => {
  it('GET /api/codegraph lists scopes', async () => {
    seedScope('project__app');
    const res = await fetch(`${base}/api/codegraph`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scopes: Array<{ id: string; nodeCount: number }> };
    expect(body.scopes.map((s) => s.id)).toContain('project__app');
    expect(body.scopes.find((s) => s.id === 'project__app')?.nodeCount).toBe(2);
  });

  it('GET /:scopeId/graph serves the graph.json', async () => {
    seedScope('project__app');
    const res = await fetch(`${base}/api/codegraph/project__app/graph`);
    expect(res.status).toBe(200);
    const g = (await res.json()) as { nodes: unknown[]; links: unknown[] };
    expect(g.nodes.length).toBe(2);
    expect(g.links.length).toBe(1);
  });

  it('GET /:scopeId/graph 404s for an unknown scope', async () => {
    const res = await fetch(`${base}/api/codegraph/project__nope/graph`);
    expect(res.status).toBe(404);
  });

  it('GET /:scopeId/graph 404s for a known-but-unindexed scope', async () => {
    store.upsertScope({ id: 'project__pending', kind: 'project', path: '/ws/p', enabled: true });
    const res = await fetch(`${base}/api/codegraph/project__pending/graph`);
    expect(res.status).toBe(404);
  });

  it('GET /:scopeId/graph.html serves the graph.html when present', async () => {
    seedScope('project__app');
    const outDir = path.join(store.indexDirFor('project__app'), 'graphify-out');
    fs.writeFileSync(path.join(outDir, 'graph.html'), '<!doctype html><title>g</title><body>hi</body>');
    const res = await fetch(`${base}/api/codegraph/project__app/graph.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const text = await res.text();
    expect(text).toContain('<body>hi</body>');
  });

  it('GET /:scopeId/graph.html 404s when the html was never emitted', async () => {
    // seedScope writes graph.json but NOT graph.html.
    seedScope('project__app');
    const res = await fetch(`${base}/api/codegraph/project__app/graph.html`);
    expect(res.status).toBe(404);
  });

  it('GET /:scopeId/graph.html 404s for an unknown scope', async () => {
    const res = await fetch(`${base}/api/codegraph/project__nope/graph.html`);
    expect(res.status).toBe(404);
  });

  it('GET /:scopeId/search returns ranked hits with file:line', async () => {
    seedScope('project__app');
    const res = await fetch(`${base}/api/codegraph/project__app/search?q=greet`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; results: Array<{ id: string; line: number }> };
    expect(body.ok).toBe(true);
    expect(body.results[0].id).toBe('a_greet');
    expect(body.results[0].line).toBe(3);
  });

  it('GET /:scopeId/search 400s without q', async () => {
    seedScope('project__app');
    const res = await fetch(`${base}/api/codegraph/project__app/search`);
    expect(res.status).toBe(400);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock the CLI layer (explain/path shell out); search/list are pure fs/sqlite.
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawnSync: vi.fn(),
}));

import { execFile } from 'node:child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SwarmDb } from '../db/index.js';
import { GraphStore } from '../codegraph/store.js';
import type { ToolContext } from './tools.js';
import { registerGraphTools } from './codegraph-tools.js';

const execFileMock = execFile as unknown as Mock;

type Handler = (args: unknown) => unknown | Promise<unknown>;

let dir: string;
let db: SwarmDb;
let store: GraphStore;
let handlers: Map<string, Handler>;

/** Recorder stub: capture (name → handler) as codegraph-tools registers them. */
function recorderServer(): { server: McpServer; handlers: Map<string, Handler> } {
  const h = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _schema: unknown, handler: Handler) => {
      h.set(name, handler);
    },
  } as unknown as McpServer;
  return { server, handlers: h };
}

function ctxWith(graph: GraphStore | undefined): ToolContext {
  return {
    orchestrator: { id: 'orch-a', leadSessionId: 'lead' },
    session: { id: 'sess-1' },
    config: { codegraphBin: 'graphify' },
    ...(graph ? { graph } : {}),
  } as unknown as ToolContext;
}

/** Register a scope in the store and drop a graph.json at its index dir. */
function seedScope(id: string, nodes: object[], links: object[] = []): void {
  store.upsertScope({ id, kind: 'project', path: `/ws/${id}`, enabled: true });
  store.recordIndexResult(id, { nodeCount: nodes.length, edgeCount: links.length, sourceHash: 'h' });
  const outDir = path.join(store.indexDirFor(id), 'graphify-out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'graph.json'), JSON.stringify({ directed: false, nodes, links }));
}

const NODES = [
  { id: 'a_hello', label: 'hello()', source_file: 'a.py', source_location: 'L1', file_type: 'code', community_name: 'a.py', norm_label: 'hello' },
  { id: 'a_greet', label: 'greet()', source_file: 'a.py', source_location: 'L3', file_type: 'code', community_name: 'a.py', norm_label: 'greet' },
];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tools-'));
  db = new SwarmDb(dir);
  store = new GraphStore(db, { dataDir: dir });
  const r = recorderServer();
  handlers = r.handlers;
  registerGraphTools(r.server, () => ctxWith(store));
  execFileMock.mockReset();
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function sc(res: unknown): Record<string, unknown> {
  return (res as { structuredContent: Record<string, unknown> }).structuredContent;
}

describe('registerGraphTools', () => {
  it('registers exactly the four codegraph tools', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'codegraph.explain',
      'codegraph.list',
      'codegraph.path',
      'codegraph.search',
    ]);
  });
});

describe('codegraph.list', () => {
  it('lists enabled scopes with counts', () => {
    seedScope('project__app', NODES);
    const out = sc(handlers.get('codegraph.list')!({}));
    expect(out.ok).toBe(true);
    const scopes = out.scopes as Array<{ id: string; nodeCount: number }>;
    expect(scopes.map((s) => s.id)).toContain('project__app');
    expect(scopes.find((s) => s.id === 'project__app')?.nodeCount).toBe(2);
  });

  it('returns ok:false when the graph store is absent', () => {
    const r = recorderServer();
    registerGraphTools(r.server, () => ctxWith(undefined));
    const out = sc(r.handlers.get('codegraph.list')!({}));
    expect(out.ok).toBe(false);
    expect(String(out.reason)).toMatch(/CODEGRAPH_UNAVAILABLE/);
  });
});

describe('codegraph.search', () => {
  it('uses the sole indexed scope implicitly and returns file:line hits', () => {
    seedScope('project__app', NODES);
    const out = sc(handlers.get('codegraph.search')!({ query: 'greet' }));
    expect(out.ok).toBe(true);
    expect(out.scope).toBe('project__app');
    const results = out.results as Array<{ id: string; file: string; line: number }>;
    expect(results[0].id).toBe('a_greet');
    expect(results[0].file).toBe('a.py');
    expect(results[0].line).toBe(3);
  });

  it('requires a scope when several are indexed', () => {
    seedScope('project__app', NODES);
    seedScope('project__lib', NODES);
    const out = sc(handlers.get('codegraph.search')!({ query: 'greet' }));
    expect(out.ok).toBe(false);
    expect(String(out.reason)).toMatch(/pass one of/);
  });

  it('rejects an unknown scope, listing the indexed ones', () => {
    seedScope('project__app', NODES);
    const out = sc(handlers.get('codegraph.search')!({ query: 'greet', scope: 'project__nope' }));
    expect(out.ok).toBe(false);
    expect(String(out.reason)).toMatch(/unknown scope/);
  });

  it('reports a scope that exists but is not indexed yet', () => {
    store.upsertScope({ id: 'project__pending', kind: 'project', path: '/ws/p', enabled: true });
    const out = sc(handlers.get('codegraph.search')!({ query: 'x', scope: 'project__pending' }));
    expect(out.ok).toBe(false);
    expect(String(out.reason)).toMatch(/not indexed yet/);
  });
});

describe('codegraph.explain', () => {
  it('wraps graphify explain and returns its text', async () => {
    seedScope('project__app', NODES);
    let capturedArgs: string[] | undefined;
    execFileMock.mockImplementation((_bin: string, args: string[], _opts: unknown, cb: Function) => {
      capturedArgs = args;
      cb(null, 'Node: greet()\n  Source: a.py L3', '');
    });
    const out = sc(await handlers.get('codegraph.explain')!({ node: 'greet', scope: 'project__app' }));
    expect(out.ok).toBe(true);
    expect(String(out.explanation)).toMatch(/greet\(\)/);
    // explain shells out against the scope's own graph.json.
    expect(capturedArgs?.[0]).toBe('explain');
    expect(capturedArgs?.[1]).toBe('greet');
    expect(String(capturedArgs?.[3])).toMatch(/project__app\/graphify-out\/graph\.json$/);
  });

  it('returns ok:false (never throws) when the CLI errors', async () => {
    seedScope('project__app', NODES);
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(Object.assign(new Error('boom'), {}), '', 'node not found');
    });
    const out = sc(await handlers.get('codegraph.explain')!({ node: 'ghost', scope: 'project__app' }));
    expect(out.ok).toBe(false);
    expect(String(out.reason)).toMatch(/not found/);
  });
});

describe('codegraph.path', () => {
  it('wraps graphify path with from/to and the scope graph', async () => {
    seedScope('project__app', NODES);
    let capturedArgs: string[] | undefined;
    execFileMock.mockImplementation((_bin: string, args: string[], _opts: unknown, cb: Function) => {
      capturedArgs = args;
      cb(null, 'hello() -> greet()', '');
    });
    const out = sc(await handlers.get('codegraph.path')!({ from: 'hello', to: 'greet', scope: 'project__app' }));
    expect(out.ok).toBe(true);
    expect(String(out.path)).toMatch(/->/);
    expect(capturedArgs?.slice(0, 3)).toEqual(['path', 'hello', 'greet']);
  });
});

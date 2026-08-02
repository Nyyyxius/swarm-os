import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock the CLI runner: change-detection is what we test, not graphify itself.
vi.mock('./graphify.js', () => ({
  runUpdate: vi.fn(async () => ({ ok: true, nodeCount: 5, edgeCount: 4 })),
  probeGraphify: vi.fn(() => ({ available: true, version: 'mock' })),
}));

import { SwarmDb } from '../db/index.js';
import { GraphStore } from './store.js';
import { startCodegraphJanitor, type CodegraphJanitorHandle } from './lifecycle.js';
import { runUpdate } from './graphify.js';
import { projectScopeId } from './discovery.js';

const runUpdateMock = runUpdate as unknown as Mock;

let root: string;
let workspaceRoot: string;
let dataDir: string;
let db: SwarmDb;
let store: GraphStore;
const handles: CodegraphJanitorHandle[] = [];

function write(p: string, content = 'x'): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function start(): CodegraphJanitorHandle {
  const h = startCodegraphJanitor(
    {
      store,
      workspaceRoot,
      dataDir,
      pluginStore: null,
      graphifyBin: 'graphify',
      engine: 'ast',
      runTimeoutMs: 1000,
      watch: false, // deterministic: janitor sweeps only, no fs.watch races
    },
    { intervalMs: 60_000 },
  );
  handles.push(h);
  return h;
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * How many runUpdate calls targeted a given source dir. The workspace ROOT scope
 * also has code (it recurses into subdirs), so total call counts mix root + the
 * subdir — assert per-source-dir instead.
 */
function callsForSource(sourceDir: string): number {
  return runUpdateMock.mock.calls.filter((c) => c[0]?.sourceDir === sourceDir).length;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-lifecycle-'));
  workspaceRoot = path.join(root, 'workspace');
  dataDir = path.join(root, 'data');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  db = new SwarmDb(dataDir);
  store = new GraphStore(db, { dataDir });
  runUpdateMock.mockClear();
  runUpdateMock.mockImplementation(async () => ({ ok: true, nodeCount: 5, edgeCount: 4 }));
});

afterEach(() => {
  for (const h of handles.splice(0)) h.stop();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('codegraph janitor change-detection', () => {
  it('indexes a changed scope, then SKIPS it while unchanged, then re-indexes on change', async () => {
    const app = path.join(workspaceRoot, 'app');
    write(path.join(app, 'index.ts'), 'export const a = 1;');
    const id = projectScopeId('app');

    start();
    // Initial sweep runs graphify once for the app scope and records the result.
    await waitFor(() => store.getScope(id)?.status === 'indexed');
    expect(callsForSource(app)).toBe(1);
    const s = store.getScope(id);
    expect(s?.nodeCount).toBe(5);
    expect(s?.edgeCount).toBe(4);
    expect(s?.lastSourceHash).toBeTruthy();

    // A sweep with NO source change must NOT invoke graphify again (any scope).
    runUpdateMock.mockClear();
    await handles[0].sweepNow();
    expect(runUpdateMock).not.toHaveBeenCalled();

    // Adding a code file changes the fingerprint → exactly one more run for app.
    write(path.join(app, 'b.ts'), 'export const b = 2;');
    await handles[0].sweepNow();
    expect(callsForSource(app)).toBe(1);
  });

  it('never indexes a docs-only scope (C3 gate) and marks it disabled', async () => {
    write(path.join(workspaceRoot, 'stories', 'ch1.md'), '# chapter');
    const id = projectScopeId('stories');

    start();
    await waitFor(() => store.getScope(id) !== null);
    // Give the (no-op) index loop a beat.
    await handles[0].sweepNow();
    expect(runUpdateMock).not.toHaveBeenCalled();
    expect(store.getScope(id)?.enabled).toBe(false);
    expect(store.getScope(id)?.status).toBe('disabled');
  });

  it('records last_error and does not stamp a hash when a run fails', async () => {
    const app = path.join(workspaceRoot, 'app');
    write(path.join(app, 'index.ts'), 'export const a = 1;');
    const id = projectScopeId('app');
    runUpdateMock.mockImplementation(async () => ({ ok: false, error: 'graphify blew up' }));

    start();
    await waitFor(() => store.getScope(id)?.status === 'error');
    const s = store.getScope(id);
    expect(s?.lastError).toMatch(/blew up/);
    expect(s?.lastSourceHash).toBeNull();

    // Still failing but unchanged → the janitor retries app (hash never stored).
    runUpdateMock.mockClear();
    await handles[0].sweepNow();
    expect(callsForSource(app)).toBe(1);
  });

  it('prunes a scope whose source dir disappeared', async () => {
    const app = path.join(workspaceRoot, 'app');
    write(path.join(app, 'index.ts'), 'export const a = 1;');
    const id = projectScopeId('app');

    start();
    await waitFor(() => store.getScope(id)?.status === 'indexed');

    fs.rmSync(app, { recursive: true, force: true });
    await handles[0].sweepNow();
    expect(store.getScope(id)).toBeNull();
  });

  it('intervalMs <= 0 disables the janitor entirely', async () => {
    const h = startCodegraphJanitor(
      { store, workspaceRoot, dataDir, pluginStore: null, graphifyBin: 'graphify', engine: 'ast', runTimeoutMs: 1000, watch: false },
      { intervalMs: 0 },
    );
    handles.push(h);
    write(path.join(workspaceRoot, 'app', 'index.ts'), 'export const a = 1;');
    await h.sweepNow();
    expect(runUpdateMock).not.toHaveBeenCalled();
  });
});

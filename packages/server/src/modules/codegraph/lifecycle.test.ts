import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock the CLI runner: change-detection is what we test, not graphify itself.
vi.mock('./graphify.js', () => ({
  runUpdate: vi.fn(async () => ({ ok: true, nodeCount: 5, edgeCount: 4 })),
  probeGraphify: vi.fn(() => ({ available: true, version: 'mock' })),
}));

/**
 * A stand-in for `fs.FSWatcher`, recorded in a registry.
 *
 * The watch tests below assert on WHICH directories get a watcher and on the
 * fact that every one of them is eventually closed — neither is observable
 * through the real `fs.watch` handle. Faking it also means the suite never
 * consumes real inotify descriptors, which matters here more than usual: the
 * bug under test is a process that drained the host's watch budget.
 */
interface FakeWatcher {
  dir: string;
  /** The options object `fs.watch` was called with — `{ recursive: false }` is the fix. */
  opts: unknown;
  closed: boolean;
  listener?: (...args: unknown[]) => void;
  error?: (err: unknown) => void;
}

const watchReg = vi.hoisted(() => ({
  created: [] as FakeWatcher[],
  /** Every dir `fs.watch` was CALLED for, including the calls we make throw. */
  attempted: [] as string[],
  /** Test hook: return an Error to make `fs.watch(dir)` throw it (ENOSPC…). */
  failWith: null as ((dir: string) => Error | null) | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const watch = (dir: string, opts?: unknown, listener?: (...args: unknown[]) => void): unknown => {
    watchReg.attempted.push(dir);
    const failure = watchReg.failWith?.(dir);
    if (failure) throw failure;
    const w: FakeWatcher = { dir, opts, closed: false, listener };
    const handle = {
      on(event: string, cb: (err: unknown) => void) {
        if (event === 'error') w.error = cb;
        return handle;
      },
      unref() {
        return handle;
      },
      close() {
        w.closed = true;
      },
    };
    watchReg.created.push(w);
    return handle;
  };
  // Everything except `watch` stays real: the tests build genuine temp trees,
  // and the janitor's own walk/fingerprint must read them for real.
  return { ...actual, watch, default: { ...actual, watch } };
});

import { SwarmDb } from '../db/index.js';
import { GraphStore } from './store.js';
import {
  startCodegraphJanitor,
  type CodegraphJanitorDeps,
  type CodegraphJanitorHandle,
} from './lifecycle.js';
import { runUpdate } from './graphify.js';
import { projectScopeId, WORKSPACE_ROOT_SCOPE_ID } from './discovery.js';

const runUpdateMock = runUpdate as unknown as Mock;

/** Directories currently holding an OPEN watcher, sorted. Duplicates kept. */
function openWatchDirs(): string[] {
  return watchReg.created
    .filter((w) => !w.closed)
    .map((w) => w.dir)
    .sort();
}

/** The single live watcher of `dir`. Throws (fails the test) if there is none. */
function liveWatcher(dir: string): FakeWatcher {
  const found = watchReg.created.filter((w) => w.dir === dir && !w.closed);
  if (found.length !== 1) throw new Error(`expected 1 live watcher for ${dir}, got ${found.length}`);
  return found[0] as FakeWatcher;
}

/**
 * Capture pino lines while `fn` runs. The root logger defaults to `info` in
 * unit tests and writes JSON to `process.stdout`, which `test/setup.ts`
 * swallows — monkey-patching `write` is the documented way to assert on logs.
 */
function withCapturedLogs(fn: () => void): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  const prev = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (text.startsWith('{"level":')) {
      for (const raw of text.split('\n')) {
        if (!raw) continue;
        try {
          lines.push(JSON.parse(raw) as Record<string, unknown>);
        } catch {
          /* not a log line */
        }
      }
    }
    if (typeof rest[0] === 'function') (rest[0] as () => void)();
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = prev;
  }
  return lines;
}

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

function start(overrides: Partial<CodegraphJanitorDeps> = {}): CodegraphJanitorHandle {
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
      ...overrides,
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
  watchReg.created.length = 0;
  watchReg.attempted.length = 0;
  watchReg.failWith = null;
  runUpdateMock.mockClear();
  runUpdateMock.mockImplementation(async () => ({ ok: true, nodeCount: 5, edgeCount: 4 }));
});

afterEach(() => {
  vi.useRealTimers();
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

/**
 * The watch accelerator. What is under test is the WATCH BOOK-KEEPING, not the
 * OS notifications: which directories get a watcher, that none is opened twice,
 * and that every one is closed. The regression this guards against is a server
 * that held 165 502 inotify watches (89 % of the host budget, ~3 % of them
 * useful) and starved a sibling process out of file watchers.
 */
describe('codegraph janitor watch accelerator', () => {
  /**
   * A workspace with root-level code (so the ROOT scope is enabled too) and one
   * project holding real source plus the three classic non-source trees.
   */
  function makeWatchTree(): { app: string; src: string } {
    const app = path.join(workspaceRoot, 'app');
    write(path.join(workspaceRoot, 'root.ts'), 'export const r = 0;');
    write(path.join(app, 'src', 'index.ts'), 'export const a = 1;');
    write(path.join(app, 'node_modules', 'pkg', 'lib', 'x.js'), 'module.exports = 1;');
    write(path.join(app, '.git', 'objects', 'ab', 'cdef'), 'blob');
    write(path.join(app, 'dist', 'index.js'), 'compiled');
    return { app, src: path.join(app, 'src') };
  }

  const appIndexed = (): boolean => store.getScope(projectScopeId('app'))?.status === 'indexed';

  it('watches code dirs only — never node_modules/.git/dist, and never the same dir twice', async () => {
    const { app, src } = makeWatchTree();
    start({ watch: true });
    await waitFor(appIndexed);

    // The workspace root scope watches ONLY the root dir: `app` is one of its
    // extraExcludes (it is its own scope), so the two scopes cannot double up.
    expect(store.getScope(WORKSPACE_ROOT_SCOPE_ID)?.enabled).toBe(true);
    expect(openWatchDirs()).toEqual([app, src, workspaceRoot].sort());
    // Exactly three handles ever created ⇒ no directory watched twice, and the
    // ~19 400-dir-equivalent trees (node_modules/.git/dist) contributed zero.
    expect(watchReg.created).toHaveLength(3);
  });

  it('repeat sweeps never re-arm a watched dir, and release the ones whose dir went away', async () => {
    const { app, src } = makeWatchTree();
    const h = start({ watch: true });
    await waitFor(appIndexed);
    expect(watchReg.created).toHaveLength(3);

    // Two more reconciliations must be pure no-ops: this is THE leak guard — a
    // scope re-watched every sweep would pile up handles here.
    await h.sweepNow();
    await h.sweepNow();
    expect(watchReg.created).toHaveLength(3);
    expect(openWatchDirs()).toEqual([app, src, workspaceRoot].sort());

    // A new directory is armed exactly once, at the next sweep (the one its own
    // creation event would have scheduled in production).
    const lib = path.join(app, 'lib');
    write(path.join(lib, 'b.ts'), 'export const b = 2;');
    await h.sweepNow();
    expect(watchReg.created).toHaveLength(4);
    expect(openWatchDirs()).toEqual([app, lib, src, workspaceRoot].sort());

    // A vanished directory has its watcher CLOSED, not merely forgotten.
    fs.rmSync(src, { recursive: true, force: true });
    await h.sweepNow();
    expect(openWatchDirs()).toEqual([app, lib, workspaceRoot].sort());
    expect(watchReg.created.filter((w) => w.dir === src).every((w) => w.closed)).toBe(true);
  });

  it('stops adding at the per-scope ceiling and warns that coverage is truncated', async () => {
    write(path.join(workspaceRoot, 'root.ts'), 'export const r = 0;');
    const app = path.join(workspaceRoot, 'app');
    const src = path.join(app, 'src');
    write(path.join(src, 'deep', 'index.ts'), 'export const a = 1;');

    // The ceiling is lowered through the test seam; production uses 2 000.
    // Breadth-first: `app` then `app/src` fill the budget, `app/src/deep` is
    // left out — the shallow dirs are the ones we keep.
    const lines = withCapturedLogs(() => {
      start({ watch: true, watchCaps: { perScope: 2 } });
    });
    await waitFor(appIndexed);

    expect(openWatchDirs()).toEqual([app, src, workspaceRoot].sort());
    expect(openWatchDirs()).not.toContain(path.join(src, 'deep'));

    // The abandonment is LOUD: a truncated watcher presenting itself as complete
    // is exactly the trap this guard exists to avoid.
    const capped = lines.filter((l) => l.event === 'codegraph.watch_capped');
    expect(capped).toHaveLength(1);
    expect(capped[0]).toMatchObject({
      scopeId: projectScopeId('app'),
      path: app,
      limit: 2,
      watched: 2,
      // …and it names the CAUSE: this tree hit its own ceiling. An operator
      // reading `limit: 2` alone cannot tell that from "a sibling scope ate the
      // shared budget", and the two have different fixes.
      reason: 'per-scope',
    });
    expect(String(capped[0]?.note)).toMatch(/periodic janitor sweep/);
  });

  it('shares the GLOBAL budget with a floor — a big scope can never starve a sibling', async () => {
    // Three scopes: the workspace root, a big `app` and a small `zapp`. Sorted
    // by id, `app` comes first and — under a plain greedy hand-out — swallowed
    // the whole global budget, leaving `zapp` with `limit = 0`. That is not
    // "watch less": `collectWatchDirs` returns an EMPTY set, so reconciliation
    // then CLOSED the watchers zapp already held. Stable sweep after sweep: a
    // scope silently demoted from ~3 s latency to the 3-minute interval.
    write(path.join(workspaceRoot, 'root.ts'), 'export const r = 0;');
    const app = path.join(workspaceRoot, 'app');
    const zapp = path.join(workspaceRoot, 'zapp');
    for (let i = 0; i < 15; i++) write(path.join(app, `d${i}`, 'index.ts'), 'export const a = 1;');
    for (let i = 0; i < 5; i++) write(path.join(zapp, `e${i}`, 'index.ts'), 'export const b = 2;');

    // total 12 over 3 scopes ⇒ floor = 4 each; `app` alone wants 16 dirs.
    const lines = withCapturedLogs(() => {
      start({ watch: true, watchCaps: { total: 12 } });
    });
    await waitFor(() => store.getScope(projectScopeId('zapp'))?.status === 'indexed');

    const open = openWatchDirs();
    const under = (base: string): string[] =>
      open.filter((d) => d === base || d.startsWith(base + path.sep));

    // THE regression: no scope is at zero, and every scope keeps at least its
    // own root directory (the one that reports new top-level sub-trees).
    expect(open).toContain(zapp);
    expect(open).toContain(app);
    expect(open).toContain(workspaceRoot);
    expect(under(zapp).length).toBeGreaterThanOrEqual(4); // its guaranteed floor
    // The leftover went to the scope that wanted it, in stable id order.
    expect(under(app).length).toBeGreaterThan(under(zapp).length);
    // …and the hard ceiling still holds: the floor is carved OUT of the budget,
    // never added on top of it.
    expect(open).toHaveLength(12);

    // The squeezed scope says WHY it is squeezed: not its own tree, its siblings.
    const capped = lines.filter((l) => l.event === 'codegraph.watch_capped');
    const zappCap = capped.find((l) => l.scopeId === projectScopeId('zapp'));
    expect(zappCap).toMatchObject({ reason: 'global-budget', maxTotal: 12, remaining: 0 });
    expect(String(zappCap?.note)).toMatch(/sibling/);
  });

  it('arms every watch NON-RECURSIVELY, with a real callback', async () => {
    // This is literally the fix: one `fs.watch` per directory, none of them
    // recursive. A `{ recursive: true }` here would re-create the 165 502-watch
    // incident — with the added cost of the explicit walk on top.
    makeWatchTree();
    start({ watch: true });
    await waitFor(appIndexed);

    expect(watchReg.created.length).toBeGreaterThan(0);
    for (const w of watchReg.created) {
      expect(w.opts, w.dir).toEqual({ recursive: false });
      // A watch armed without a listener is an inotify descriptor that reports
      // nothing: all of the cost, none of the acceleration.
      expect(typeof w.listener, w.dir).toBe('function');
    }
  });

  it('a watch event schedules ONE debounced sweep, not one sweep per event', async () => {
    const { app, src } = makeWatchTree();
    start({ watch: true });
    await waitFor(appIndexed);
    runUpdateMock.mockClear();

    // A real change on disk, so the sweep the watcher triggers has work to do —
    // otherwise the fingerprint guard would make a successful sweep invisible.
    write(path.join(src, 'c.ts'), 'export const c = 3;');

    vi.useFakeTimers();
    try {
      const w = liveWatcher(src);
      // Editors emit several events per save; a burst must collapse into one.
      w.listener?.('change', 'c.ts');
      w.listener?.('rename', 'c.ts');
      w.listener?.('change', 'c.ts');
      expect(runUpdateMock).not.toHaveBeenCalled(); // debounced, not immediate
      await vi.advanceTimersByTimeAsync(10_000); // well past WATCH_DEBOUNCE_MS
    } finally {
      vi.useRealTimers();
    }

    await waitFor(() => callsForSource(app) === 1);
    expect(callsForSource(app)).toBe(1); // one sweep, not three
  });

  it("re-arms an errored watcher, and its late error cannot evict the replacement", async () => {
    const { src } = makeWatchTree();
    const h = start({ watch: true });
    await waitFor(appIndexed);
    const first = liveWatcher(src);

    // A watcher that emits 'error' is dead. It must be closed AND dropped from
    // the registry, or the next sweep would consider `src` still covered and the
    // scope would stay blind on that directory until a redeploy.
    first.error?.(new Error('inotify watch removed'));
    expect(first.closed).toBe(true);

    await h.sweepNow();
    const forSrc = watchReg.created.filter((w) => w.dir === src);
    expect(forSrc).toHaveLength(2);
    const second = forSrc[1] as FakeWatcher;
    expect(second.closed).toBe(false);

    // THE identity check. Node can deliver a dead watcher's error after we have
    // already installed a replacement; dropping the map entry unconditionally
    // there would forget a LIVE watcher — which then leaks (never closed) and
    // gets doubled at the next sweep.
    first.error?.(new Error('late, from the corpse'));
    expect(second.closed).toBe(false);
    await h.sweepNow();
    expect(watchReg.created.filter((w) => w.dir === src)).toHaveLength(2);
    expect(openWatchDirs()).toContain(src);
  });

  it('stops arming as soon as the host is out of watch descriptors (ENOSPC)', async () => {
    // The exact errno of the incident, seen from the victim's side: a sibling
    // process had eaten the inotify budget and this instance could not arm.
    const { app, src } = makeWatchTree();
    const enospc = Object.assign(
      new Error('ENOSPC: System limit for number of file watchers reached'),
      { code: 'ENOSPC' },
    );
    watchReg.failWith = (dir) => (dir === app ? enospc : null);

    const h = start({ watch: true });
    await waitFor(appIndexed); // indexing is unaffected: watching is best-effort

    // Retrying once per remaining directory would burn a syscall per dir for
    // nothing, so the scope gives up at the first ENOSPC.
    expect(watchReg.attempted).toContain(app);
    expect(watchReg.attempted).not.toContain(src);
    // …but only THAT scope: the sibling scope still gets its watchers, and the
    // sweep completed normally (a throw here would have aborted ensureWatchers).
    expect(openWatchDirs()).toEqual([workspaceRoot]);

    // Not sticky: descriptors come back (possibly because we freed them), and
    // the next sweep arms the whole scope.
    watchReg.failWith = null;
    await h.sweepNow();
    expect(openWatchDirs()).toEqual([app, src, workspaceRoot].sort());
  });

  it('stop() closes every watcher and nothing can re-arm afterwards', async () => {
    makeWatchTree();
    const h = start({ watch: true });
    await waitFor(appIndexed);
    expect(openWatchDirs()).toHaveLength(3);

    h.stop();
    expect(openWatchDirs()).toEqual([]);
    expect(watchReg.created.every((w) => w.closed)).toBe(true);

    // A sweep racing with stop() must not resurrect the watcher set.
    await h.sweepNow();
    expect(openWatchDirs()).toEqual([]);
  });

  it('watch:false arms no watcher at all', async () => {
    makeWatchTree();
    start();
    await waitFor(appIndexed);
    expect(watchReg.created).toHaveLength(0);
  });
});

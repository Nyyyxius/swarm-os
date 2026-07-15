import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { SwarmDb } from '../db/index.js';
import { SwarmEventBus, type SwarmEvent } from '../../events.js';
import { PluginStore, type PluginRow } from './store.js';
import { PluginHost, PluginActivationError } from './host.js';
import { DisposableStore, PluginDisabledError, type SwarmPlugin } from './api-types.js';

let tmp: string;
let pluginsDir: string;
let db: SwarmDb;
let store: PluginStore;
let bus: SwarmEventBus;
let host: PluginHost;
let clock: number;
let events: SwarmEvent[];
/** name → fake module, or an Error to simulate a corrupt import. */
let fakes: Map<string, SwarmPlugin | Error>;

const nextTick = () => new Promise((r) => setImmediate(r));

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Write a plugin.json so loadManifest/scan see the plugin on disk. */
function mkPlugin(name: string, manifestOver: Record<string, unknown> = {}): void {
  const dir = path.join(pluginsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({
      name,
      version: '0.1.0',
      main: 'index.js',
      apiVersion: 1,
      capabilities: ['events', 'events-emit', 'db-kv', 'schedule'],
      ...manifestOver,
    }),
  );
}

function rowFor(name: string, over: Partial<PluginRow> = {}): PluginRow {
  const now = new Date(clock).toISOString();
  return {
    name,
    version: '0.1.0',
    source_kind: 'dir',
    source_ref: path.join(pluginsDir, name),
    enabled: 0,
    config_json: null,
    granted_capabilities_json: null,
    api_version: 1,
    fail_count: 0,
    quarantined_until: null,
    installed_at: now,
    updated_at: now,
    last_error: null,
    ...over,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-host-'));
  pluginsDir = path.join(tmp, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  db = new SwarmDb(tmp);
  store = new PluginStore(db);
  bus = new SwarmEventBus();
  bus.setMaxListeners(1000);
  events = [];
  bus.onEvent((e) => events.push(e));
  clock = Date.now();
  fakes = new Map();
  host = new PluginHost({
    store,
    eventBus: bus,
    pluginsDir,
    zod: z,
    timeouts: { activateMs: 100, deactivateMs: 100 },
    now: () => clock,
    loadModule: async (dir) => {
      const n = path.basename(dir);
      const f = fakes.get(n);
      if (f instanceof Error) throw f;
      if (!f) throw new Error(`no fake registered for ${n}`);
      return f;
    },
  });
});

afterEach(async () => {
  await host.deactivateAll();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('DisposableStore', () => {
  it('disposes in reverse order and isolates a throwing disposable', () => {
    const order: number[] = [];
    const s = new DisposableStore();
    s.add({ dispose: () => order.push(1) });
    s.add({
      dispose: () => {
        throw new Error('boom');
      },
    });
    s.add({ dispose: () => order.push(3) });
    s.disposeAll();
    // 3 then 1 — reverse; the throwing (2) did not strand the rest.
    expect(order).toEqual([3, 1]);
  });

  it('disposes a late add immediately after teardown', () => {
    const s = new DisposableStore();
    s.disposeAll();
    let disposed = false;
    s.add({ dispose: () => (disposed = true) });
    expect(disposed).toBe(true);
  });
});

describe('PluginHost lifecycle', () => {
  it('scan registers a dropped plugin and enable activates it + emits an event', async () => {
    mkPlugin('p1');
    fakes.set('p1', { activate() {} });
    const scanned = await host.scan();
    expect(scanned.map((p) => p.name)).toContain('p1');
    expect(host.viewOf('p1').status).toBe('disabled');

    const view = await host.enable('p1');
    expect(view.status).toBe('enabled');
    expect(view.enabled).toBe(true);
    expect(host.isActive('p1')).toBe(true);
    expect(events.some((e) => e.kind === 'plugin.host.changed')).toBe(true);
  });

  it('scan marks a vanished folder as error + disabled without deleting the row', async () => {
    mkPlugin('gone');
    fakes.set('gone', { activate() {} });
    await host.scan();
    fs.rmSync(path.join(pluginsDir, 'gone'), { recursive: true, force: true });
    await host.scan();
    const v = host.viewOf('gone');
    expect(v.status).toBe('error');
    expect(v.enabled).toBe(false);
    expect(store.get('gone')).not.toBeNull();
  });

  it('disable removes event listeners (no more dispatch)', async () => {
    let hits = 0;
    mkPlugin('lst');
    fakes.set('lst', {
      activate(api) {
        api.events.on('mailbox.message', () => {
          hits += 1;
        });
      },
    });
    await host.scan();
    await host.enable('lst', ['events']);

    bus.emitEvent({ kind: 'mailbox.message', payload: {} });
    await nextTick();
    expect(hits).toBe(1);

    await host.disable('lst');
    bus.emitEvent({ kind: 'mailbox.message', payload: {} });
    await nextTick();
    expect(hits).toBe(1); // listener gone
    expect(host.isActive('lst')).toBe(false);
  });

  it('dispatches event handlers asynchronously (never blocks emitEvent)', async () => {
    let ran = false;
    mkPlugin('async-h');
    fakes.set('async-h', {
      activate(api) {
        api.events.on('*', () => {
          ran = true;
        });
      },
    });
    await host.scan();
    await host.enable('async-h', ['events']);

    bus.emitEvent({ kind: 'mailbox.message', payload: {} });
    // Handler is deferred via setImmediate — not run on the synchronous path.
    expect(ran).toBe(false);
    await nextTick();
    expect(ran).toBe(true);
  });

  it('rejects with PluginActivationError when activate() exceeds the timeout', async () => {
    mkPlugin('slow');
    fakes.set('slow', {
      activate() {
        return new Promise<void>(() => {
          /* never resolves */
        });
      },
    });
    await host.scan();
    await expect(host.enable('slow')).rejects.toBeInstanceOf(PluginActivationError);
    expect(host.isActive('slow')).toBe(false);
    const v = host.viewOf('slow');
    expect(v.status).toBe('error');
    expect(v.lastError).toMatch(/timed out/);
    expect(v.failCount).toBe(1);
  });
});

describe('PluginHost crash isolation & quarantine', () => {
  async function enablePlain(name: string): Promise<void> {
    mkPlugin(name);
    fakes.set(name, { activate() {} });
    await host.scan();
    await host.enable(name, []);
  }

  it('auto-disables + quarantines after 5 SYNC throws in 60s', async () => {
    await enablePlain('crashy');
    const g = host.guard('crashy', 'timer', () => {
      throw new Error('sync boom');
    });
    for (let i = 0; i < 5; i++) g();
    await waitFor(() => !host.isActive('crashy'));
    const v = host.viewOf('crashy');
    expect(v.status).toBe('crashed');
    expect(v.failCount).toBeGreaterThanOrEqual(1);
    expect(v.quarantinedUntil).toBeTruthy();
  });

  it('auto-disables after 5 ASYNC rejections (not lost to unhandledRejection)', async () => {
    await enablePlain('crashy-async');
    const g = host.guard('crashy-async', 'timer', () => Promise.reject(new Error('async boom')));
    for (let i = 0; i < 5; i++) void g();
    await waitFor(() => !host.isActive('crashy-async'));
    expect(host.viewOf('crashy-async').status).toBe('crashed');
    expect(host.viewOf('crashy-async').quarantinedUntil).toBeTruthy();
  });

  it('does NOT count PluginDisabledError against the crash budget', async () => {
    await enablePlain('benign');
    const g = host.guard('benign', 'timer', () => {
      throw new PluginDisabledError('benign');
    });
    // Well over the 5-crash threshold — must NOT auto-disable.
    for (let i = 0; i < 12; i++) g();
    await nextTick();
    expect(host.isActive('benign')).toBe(true);
    expect(host.viewOf('benign').status).toBe('enabled');
  });

  it('a stale-epoch tick after disable is a benign no-op (not counted)', async () => {
    await enablePlain('stale');
    const g = host.guard('stale', 'timer', () => {
      throw new Error('should never run');
    });
    await host.disable('stale');
    // Epoch has moved on — invoking the old closure must not throw or crash.
    expect(() => {
      for (let i = 0; i < 10; i++) g();
    }).not.toThrow();
    expect(host.viewOf('stale').status).toBe('disabled');
  });

  it('guard never rethrows even when crash accounting itself fails (red-team #1)', async () => {
    await enablePlain('acct');
    // Simulate SQLITE_FULL / closed handle during crash bookkeeping.
    const origPatch = store.patch.bind(store);
    (store as { patch: typeof store.patch }).patch = () => {
      throw new Error('db down');
    };
    try {
      const g = host.guard('acct', 'timer', () => {
        throw new Error('plugin boom');
      });
      // A throw here would escape into the caller (= a timer in production →
      // fatal uncaughtException). It must be swallowed.
      expect(() => g()).not.toThrow();
      // Async flavour: the returned promise must not reject either.
      const ga = host.guard('acct', 'timer', () => Promise.reject(new Error('async boom')));
      await expect(Promise.resolve(ga())).resolves.toBeUndefined();
    } finally {
      (store as { patch: typeof store.patch }).patch = origPatch;
    }
  });

  it('a successful re-enable resets the crash window (red-team #2)', async () => {
    await enablePlain('fixed');
    const g = host.guard('fixed', 'timer', () => {
      throw new Error('pre-fix boom');
    });
    // 4 crashes — under the limit, still active.
    for (let i = 0; i < 4; i++) g();
    expect(host.isActive('fixed')).toBe(true);

    // Operator "fixes" the plugin: reload (fresh activation, fresh guard).
    await host.reload('fixed');
    const g2 = host.guard('fixed', 'timer', () => {
      throw new Error('post-fix boom');
    });
    // ONE crash on the new activation must NOT trip auto-disable (4+1 stale).
    g2();
    await nextTick();
    await nextTick();
    expect(host.isActive('fixed')).toBe(true);
    expect(host.viewOf('fixed').status).toBe('enabled');
  });

  it('a failed retry of a quarantined plugin surfaces as error, not quarantined (red-team #4)', async () => {
    await enablePlain('retry');
    const g = host.guard('retry', 'timer', () => {
      throw new Error('loop boom');
    });
    for (let i = 0; i < 5; i++) g();
    await waitFor(() => !host.isActive('retry'));
    expect(host.viewOf('retry').status).toBe('crashed');
    expect(host.viewOf('retry').quarantinedUntil).toBeTruthy();

    // Retry, but now the module is broken at activate.
    fakes.set('retry', {
      activate() {
        throw new Error('broken manifest of sorts');
      },
    });
    await expect(host.enable('retry')).rejects.toBeInstanceOf(PluginActivationError);
    const v = host.viewOf('retry');
    expect(v.status).toBe('error'); // NOT 'quarantined' — fresh error visible
    expect(v.lastError).toMatch(/broken manifest/);
  });
});

describe('PluginHost boot (activateEnabled)', () => {
  it('never rejects even if a plugin import is corrupt, and activates the healthy ones', async () => {
    mkPlugin('good');
    fakes.set('good', { activate() {} });
    store.upsert(rowFor('good', { enabled: 1 }));

    mkPlugin('bad');
    fakes.set('bad', new SyntaxError('unexpected token'));
    store.upsert(rowFor('bad', { enabled: 1 }));

    await expect(host.activateEnabled()).resolves.toBeUndefined();
    expect(host.isActive('good')).toBe(true);
    expect(host.isActive('bad')).toBe(false);
    expect(host.viewOf('bad').status).toBe('error');
  });

  it('skips a plugin whose quarantine window is still open', async () => {
    mkPlugin('quar');
    fakes.set('quar', { activate() {} });
    store.upsert(
      rowFor('quar', {
        enabled: 1,
        fail_count: 3,
        quarantined_until: new Date(clock + 10_000).toISOString(),
      }),
    );
    await host.activateEnabled();
    expect(host.isActive('quar')).toBe(false);
    expect(host.viewOf('quar').status).toBe('quarantined');
  });

  it('activates a plugin whose quarantine window has expired', async () => {
    mkPlugin('expired');
    fakes.set('expired', { activate() {} });
    store.upsert(
      rowFor('expired', {
        enabled: 1,
        fail_count: 2,
        quarantined_until: new Date(clock - 1000).toISOString(),
      }),
    );
    await host.activateEnabled();
    expect(host.isActive('expired')).toBe(true);
    expect(host.viewOf('expired').status).toBe('enabled');
  });
});

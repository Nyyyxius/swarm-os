import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../db/index.js';
import { SwarmEventBus, type SwarmEvent } from '../../events.js';
import {
  FeatureRegistry,
  FEATURE_NAMES,
  type FeatureDescriptor,
  type FeatureName,
} from './registry.js';

let dir: string;
let db: SwarmDb;
let bus: SwarmEventBus;

/** A descriptor that records every lifecycle call into `calls`. */
function recordingDesc(
  name: FeatureName,
  calls: string[],
  opts: { stopDelayMs?: number } = {},
): FeatureDescriptor {
  return {
    name,
    displayName: name.toUpperCase(),
    description: `${name} feature`,
    start: () => {
      calls.push(`${name}:start`);
    },
    stop: () => {
      calls.push(`${name}:stop-begin`);
      if (opts.stopDelayMs) {
        return new Promise<void>((resolve) =>
          setTimeout(() => {
            calls.push(`${name}:stop-end`);
            resolve();
          }, opts.stopDelayMs),
        );
      }
      calls.push(`${name}:stop-end`);
    },
    purge: () => {
      calls.push(`${name}:purge`);
    },
  };
}

const enabledConfig = { codegraphEnabled: true, ideEnabled: true };

function makeRegistry(
  config: { codegraphEnabled: boolean; ideEnabled: boolean } = enabledConfig,
): FeatureRegistry {
  return new FeatureRegistry({ db, eventBus: bus, config });
}

/** Register the six no-op descriptors so `list()`/verbs have something to call. */
function registerAll(reg: FeatureRegistry, calls: string[] = []): void {
  for (const name of FEATURE_NAMES) reg.register(recordingDesc(name, calls));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-registry-'));
  db = new SwarmDb(dir);
  bus = new SwarmEventBus();
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('FeatureRegistry — seed & reads', () => {
  it('seeds all six features enabled on first boot', () => {
    const reg = makeRegistry();
    registerAll(reg);
    expect(reg.snapshot()).toEqual({
      ide: true,
      codegraph: true,
      board: true,
      memory: true,
      monitoring: true,
      approvals: true,
    });
    for (const name of FEATURE_NAMES) {
      expect(reg.isEnabled(name)).toBe(true);
      expect(reg.stateOf(name)).toBe('enabled');
    }
    const views = reg.list();
    expect(views.map((v) => v.name).sort()).toEqual([...FEATURE_NAMES].sort());
    expect(views.every((v) => v.state === 'enabled')).toBe(true);
    expect(views.every((v) => v.updatedAt.length > 0)).toBe(true);
  });

  it('seeds codegraph/ide disabled when their env default is false', () => {
    const reg = makeRegistry({ codegraphEnabled: false, ideEnabled: false });
    expect(reg.isEnabled('codegraph')).toBe(false);
    expect(reg.isEnabled('ide')).toBe(false);
    expect(reg.isEnabled('board')).toBe(true);
    expect(reg.isEnabled('memory')).toBe(true);
  });
});

describe('FeatureRegistry — state machine', () => {
  it('enable on a fresh feature calls start (not purge)', async () => {
    const calls: string[] = [];
    const reg = makeRegistry();
    reg.register(recordingDesc('board', calls));
    await reg.enable('board');
    expect(calls).toEqual(['board:start']);
    expect(reg.stateOf('board')).toBe('enabled');
  });

  it('disable calls stop and persists disabled', async () => {
    const calls: string[] = [];
    const reg = makeRegistry();
    reg.register(recordingDesc('memory', calls));
    await reg.disable('memory');
    expect(calls).toEqual(['memory:stop-begin', 'memory:stop-end']);
    expect(reg.isEnabled('memory')).toBe(false);
    expect(reg.stateOf('memory')).toBe('disabled');
  });

  it('uninstall calls stop then purge and persists uninstalled', async () => {
    const calls: string[] = [];
    const reg = makeRegistry();
    reg.register(recordingDesc('board', calls));
    await reg.uninstall('board');
    expect(calls).toEqual(['board:stop-begin', 'board:stop-end', 'board:purge']);
    expect(reg.stateOf('board')).toBe('uninstalled');
    expect(reg.isEnabled('board')).toBe(false);
  });

  it('enable on uninstalled is install+enable: purge (defensive) then start, idempotent', async () => {
    const calls: string[] = [];
    const reg = makeRegistry();
    reg.register(recordingDesc('board', calls));
    await reg.uninstall('board');
    calls.length = 0;
    await reg.enable('board');
    expect(calls).toEqual(['board:purge', 'board:start']);
    expect(reg.stateOf('board')).toBe('enabled');
    expect(reg.isEnabled('board')).toBe(true);
  });
});

describe('FeatureRegistry — persistence across instantiations', () => {
  it('a disabled feature stays disabled on a fresh registry over the same DB', async () => {
    const regA = makeRegistry();
    registerAll(regA);
    await regA.disable('memory');
    await regA.uninstall('board');

    const regB = makeRegistry();
    registerAll(regB);
    expect(regB.stateOf('memory')).toBe('disabled');
    expect(regB.stateOf('board')).toBe('uninstalled');
    expect(regB.isEnabled('ide')).toBe(true);
  });
});

describe('FeatureRegistry — env seed deprecation', () => {
  it('ignores the env default once the DB has a state, and logs feature.seed_ignored', () => {
    // First boot with env false → seeds codegraph disabled.
    const regA = makeRegistry({ codegraphEnabled: false, ideEnabled: true });
    expect(regA.stateOf('codegraph')).toBe('disabled');

    // Second boot with env now TRUE, contradicting the persisted 'disabled'.
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const regB = makeRegistry({ codegraphEnabled: true, ideEnabled: true });
    // DB governs — env is ignored.
    expect(regB.stateOf('codegraph')).toBe('disabled');
    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(logged).toContain('feature.seed_ignored');
    expect(logged).toContain('codegraph');
  });
});

describe('FeatureRegistry — events', () => {
  it('emits feature.changed on each verb', async () => {
    const reg = makeRegistry();
    reg.register(recordingDesc('memory', []));
    const events: SwarmEvent[] = [];
    bus.onEvent((ev) => events.push(ev));

    await reg.disable('memory');
    await reg.enable('memory');
    await reg.uninstall('memory');

    const changes = events.filter((e) => e.kind === 'feature.changed');
    expect(changes.map((e) => (e.payload as { state: string }).state)).toEqual([
      'disabled',
      'enabled',
      'uninstalled',
    ]);
    expect((changes[0].payload as { name: string }).name).toBe('memory');
  });

  it('fires the broadcast-to-leads callback on a toggle', async () => {
    const broadcasts: Array<{ from: string; content: string }> = [];
    const reg = new FeatureRegistry({
      db,
      eventBus: bus,
      config: enabledConfig,
      broadcastToLeads: (from, content) => broadcasts.push({ from, content }),
    });
    reg.register(recordingDesc('board', []));
    await reg.disable('board');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].content).toContain('board');
  });
});

describe('FeatureRegistry — verb serialisation', () => {
  it('serialises verbs per name (a slow stop finishes before the next start)', async () => {
    const calls: string[] = [];
    const reg = makeRegistry();
    reg.register(recordingDesc('memory', calls, { stopDelayMs: 15 }));

    // Fire disable (slow stop) then enable WITHOUT awaiting the first.
    const p1 = reg.disable('memory');
    const p2 = reg.enable('memory');
    await Promise.all([p1, p2]);

    // The slow stop must fully complete before enable's start runs.
    expect(calls).toEqual(['memory:stop-begin', 'memory:stop-end', 'memory:start']);
    expect(reg.stateOf('memory')).toBe('enabled');
  });
});

describe('FeatureRegistry — startEnabled / stopAll', () => {
  it('startEnabled arms only enabled features; stopAll stops in reverse order', async () => {
    const calls: string[] = [];
    const reg = makeRegistry();
    // Seed board disabled BEFORE registering, so startEnabled skips it.
    const early = makeRegistry();
    early.register(recordingDesc('board', []));
    await early.disable('board');

    // Fresh registry over the same DB (board persists disabled).
    const reg2 = makeRegistry();
    reg2.register(recordingDesc('ide', calls));
    reg2.register(recordingDesc('board', calls));
    reg2.register(recordingDesc('memory', calls));
    reg2.startEnabled();
    expect(calls).toEqual(['ide:start', 'memory:start']); // board skipped (disabled)

    calls.length = 0;
    await reg2.stopAll();
    // Reverse registration order: memory, board, ide.
    expect(calls).toEqual([
      'memory:stop-begin',
      'memory:stop-end',
      'board:stop-begin',
      'board:stop-end',
      'ide:stop-begin',
      'ide:stop-end',
    ]);
    void reg;
  });
});

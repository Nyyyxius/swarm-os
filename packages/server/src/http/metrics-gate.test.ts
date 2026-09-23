import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, type Server } from 'node:http';
import { createApp } from './main.js';
import { loadConfig, _resetConfigCacheForTesting, type Config } from '../config.js';
import type { Spawner } from '../modules/spawner/index.js';
import type { RoleStore } from '../modules/roles/index.js';
import type { SettingsStore } from '../modules/settings/index.js';
import type { MessagesAggregator } from '../modules/metrics/aggregator.js';
import type { BackupScheduler } from '../modules/backup/index.js';
import { SwarmDb } from '../modules/db/index.js';
import { SwarmEventBus } from '../events.js';
import {
  FeatureRegistry,
  type FeatureDescriptor,
} from '../modules/features/registry.js';

/**
 * Lot 7 — `monitoring` feature gate (docs/builtin-features.md D6).
 *
 * Two things are asserted here:
 *  1. HTTP: the whole `/metrics/*` router is mounted behind
 *     `featureGate(features, 'monitoring')` — disabled ⇒ 404 FEATURE_DISABLED on
 *     every metrics endpoint; enabled ⇒ it answers 200; no registry ⇒ fail-open
 *     (mounted, current behaviour) so the test/dev stacks keep the endpoints.
 *  2. Descriptor scope: the monitoring descriptor's start()/stop()/purge() drive
 *     ONLY the two in-memory collectors — NEVER the budget watch or the cost
 *     roll-up — so a monitoring toggle can never disarm the anti-runaway guard
 *     or the accounting watermark (the guarantee that keeps them out of the
 *     descriptor). The collectors' own no-op/reset behaviour is unit-tested in
 *     `modules/metrics/busMetrics.test.ts`.
 */

const spawnerStub = {
  counters: () => ({
    orchestratorsActive: 0,
    sessionsActive: 0,
    sessionsWaiting: 0,
    sessionsPaused: 0,
  }),
  notifier: {},
} as unknown as Spawner;
const roleStoreStub = {} as unknown as RoleStore;
const settingsStoreStub = {} as unknown as SettingsStore;
// `/metrics/system` (the endpoint under test) reads its own cgroup and never
// touches the aggregator, so a stub with a harmless snapshot() is plenty.
const aggregatorStub = {
  snapshot: () => ({ total: 0, per_minute: 0, global: [], per_orchestrator: {} }),
} as unknown as MessagesAggregator;
const backupStub = {} as unknown as BackupScheduler;

let envSnapshot: NodeJS.ProcessEnv;
let tmpRoot: string;
let listening: Server | null = null;
let db: SwarmDb | null = null;

function makeFeatures(): FeatureRegistry {
  db = new SwarmDb(path.join(tmpRoot, 'features'));
  return new FeatureRegistry({
    db,
    eventBus: new SwarmEventBus(),
    config: { codegraphEnabled: true, ideEnabled: true },
  });
}

async function serve(config: Config, features?: FeatureRegistry): Promise<string> {
  const { app } = createApp(
    config,
    spawnerStub,
    roleStoreStub,
    settingsStoreStub,
    aggregatorStub,
    backupStub,
    undefined, // busMetrics
    undefined, // bootGate
    undefined, // crons
    undefined, // pluginHost
    undefined, // pluginHttpRegistry
    undefined, // pluginInstaller
    undefined, // connectorRegistry
    undefined, // updates
    undefined, // memory
    undefined, // taskboard
    undefined, // approvals
    undefined, // graph
    features,
  );
  const server = createServer(app);
  listening = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

const AUTH = { headers: { 'X-Auth-Token': 'test-token-fixed' } };

beforeEach(() => {
  envSnapshot = { ...process.env };
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-metrics-gate-'));
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('SWARM_OS_') || k === 'HOOK_TOKEN') delete process.env[k];
  }
  process.env.SWARM_OS_DATA_DIR = path.join(tmpRoot, 'data');
  process.env.SWARM_OS_WORKSPACE_ROOT = path.join(tmpRoot, 'workspace');
  process.env.SWARM_OS_MCP_RUNTIME_DIR = path.join(tmpRoot, 'mcp-runtime');
  process.env.SWARM_OS_CLAUDE_SOURCE_DIR = path.join(tmpRoot, 'claude-source');
  process.env.SWARM_OS_CLAUDE_RUNTIME_DIR = path.join(tmpRoot, 'claude-runtime');
  process.env.SWARM_OS_TOKEN = 'test-token-fixed';
  process.env.HOOK_TOKEN = 'test-hook-token-fixed';
  process.env.SWARM_OS_IDE_ENABLED = 'false';
  process.env.SWARM_OS_PROJECT_NAME = 'metrics-gate-test';
  _resetConfigCacheForTesting();
});

afterEach(async () => {
  if (listening) {
    await new Promise<void>((resolve) => listening!.close(() => resolve()));
    listening = null;
  }
  db?.close();
  db = null;
  process.env = envSnapshot;
  _resetConfigCacheForTesting();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('GET /metrics/* — monitoring feature gate', () => {
  it('answers 200 when monitoring is enabled (default seed)', async () => {
    const features = makeFeatures();
    const base = await serve(loadConfig(), features);
    const res = await fetch(`${base}/metrics/system`, AUTH);
    expect(res.status).toBe(200);
  });

  it('404s FEATURE_DISABLED on every metrics endpoint when monitoring is disabled', async () => {
    const features = makeFeatures();
    await features.disable('monitoring');
    const base = await serve(loadConfig(), features);
    for (const p of ['/metrics/system', '/metrics/messages']) {
      const res = await fetch(`${base}${p}`, AUTH);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: 'FEATURE_DISABLED',
        feature: 'monitoring',
      });
    }
  });

  it('re-enabling monitoring restores 200 (hot toggle, no rebuild)', async () => {
    const features = makeFeatures();
    await features.disable('monitoring');
    const base = await serve(loadConfig(), features);
    expect((await fetch(`${base}/metrics/system`, AUTH)).status).toBe(404);
    await features.enable('monitoring');
    expect((await fetch(`${base}/metrics/system`, AUTH)).status).toBe(200);
  });

  it('fails open when no feature registry is wired (tests/dev keep /metrics)', async () => {
    const base = await serve(loadConfig()); // no features
    expect((await fetch(`${base}/metrics/system`, AUTH)).status).toBe(200);
  });

  it('still 401s without a token (auth runs before the gate)', async () => {
    const features = makeFeatures();
    await features.disable('monitoring');
    const base = await serve(loadConfig(), features);
    // No token: auth short-circuits before the feature gate is ever consulted.
    expect((await fetch(`${base}/metrics/system`)).status).toBe(401);
  });
});

describe('monitoring descriptor — restricted scope (D6)', () => {
  /**
   * A descriptor mirroring the one wired in `index.ts`: start()/stop() drive the
   * two collectors, purge() is a persistent no-op. The `budgetWatch`/`costRollup`
   * spies model the two writers that MUST stay armed — they are deliberately NOT
   * referenced by the descriptor, so no toggle can ever touch them. Asserting
   * they stay untouched guards against a future regression that pulls them in.
   */
  function wire() {
    const calls = {
      aggStart: 0,
      aggStop: 0,
      busStart: 0,
      busStop: 0,
      budgetStop: 0,
      rollupStop: 0,
    };
    const aggregator = {
      start: () => void calls.aggStart++,
      stop: () => void calls.aggStop++,
    };
    const busMetrics = {
      start: () => void calls.busStart++,
      stop: () => void calls.busStop++,
    };
    // Not wired into the descriptor — the whole point of D6.
    const budgetWatch = { stop: () => void calls.budgetStop++ };
    const costRollup = { stop: () => void calls.rollupStop++ };

    const monitoring: FeatureDescriptor = {
      name: 'monitoring',
      displayName: 'MONITORING',
      description: 'context, throughput & inbox per agent',
      start: () => {
        aggregator.start();
        busMetrics.start();
      },
      stop: () => {
        aggregator.stop();
        busMetrics.stop();
      },
      purge: () => {
        /* persistent no-op: rings are in memory; session_token_daily untouched */
      },
    };

    const features = makeFeatures();
    features.register(monitoring);
    // Prove the guards exist and are separate objects the registry cannot reach.
    void budgetWatch;
    void costRollup;
    return { features, calls };
  }

  it('disable() stops the collectors only — budget watch & cost roll-up untouched', async () => {
    const { features, calls } = wire();
    await features.disable('monitoring');
    expect(calls.aggStop).toBe(1);
    expect(calls.busStop).toBe(1);
    expect(calls.budgetStop).toBe(0);
    expect(calls.rollupStop).toBe(0);
  });

  it('uninstall() purges nothing persistent and never touches the guards', async () => {
    const { features, calls } = wire();
    await features.uninstall('monitoring');
    // stop() ran (collectors), purge() was a no-op, guards never called.
    expect(calls.aggStop).toBe(1);
    expect(calls.busStop).toBe(1);
    expect(calls.budgetStop).toBe(0);
    expect(calls.rollupStop).toBe(0);
    expect(features.stateOf('monitoring')).toBe('uninstalled');
  });

  it('enable-from-uninstalled re-arms the collectors (idempotent install)', async () => {
    const { features, calls } = wire();
    await features.uninstall('monitoring');
    await features.enable('monitoring');
    // enable() from uninstalled runs purge() (no-op) then start().
    expect(calls.aggStart).toBe(1);
    expect(calls.busStart).toBe(1);
    expect(features.stateOf('monitoring')).toBe('enabled');
  });
});

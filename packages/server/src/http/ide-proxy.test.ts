import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './main.js';
import { loadConfig, _resetConfigCacheForTesting, type Config } from '../config.js';
import { SwarmDb } from '../modules/db/index.js';
import { SwarmEventBus } from '../events.js';
import {
  FeatureRegistry,
  type FeatureDescriptor,
  type FeatureName,
} from '../modules/features/registry.js';
import type { Spawner } from '../modules/spawner/index.js';
import type { RoleStore } from '../modules/roles/index.js';
import type { SettingsStore } from '../modules/settings/index.js';
import type { MessagesAggregator } from '../modules/metrics/aggregator.js';
import type { BackupScheduler } from '../modules/backup/index.js';

/**
 * Lot 3 — the IDE reverse-proxy is mounted UNCONDITIONALLY and gated at
 * CALL-TIME via the feature registry (like `pluginHttpRegistry`), so a hot
 * enable/disable flips the behaviour of the SAME running app with no rebuild.
 * A tiny loopback upstream stands in for `code serve-web`: a proxied request
 * returns its 200; a gated-off request falls through the pipeline to the
 * generic 404 (an authenticated client — an iframe nav can't send the header).
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
const aggregatorStub = {} as unknown as MessagesAggregator;
const backupStub = {} as unknown as BackupScheduler;

function noopDesc(name: FeatureName): FeatureDescriptor {
  return {
    name,
    displayName: name.toUpperCase(),
    description: `${name} feature`,
    start: () => {},
    stop: () => {},
    purge: () => {},
  };
}

let envSnapshot: NodeJS.ProcessEnv;
let tmpRoot: string;
let db: SwarmDb;
let features: FeatureRegistry;
let upstream: Server;
let appServer: Server;
let appBase: string;

async function listenEphemeral(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

beforeEach(async () => {
  envSnapshot = { ...process.env };
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-proxy-'));
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('SWARM_OS_') || k === 'HOOK_TOKEN') delete process.env[k];
  }

  // Stand-in serve-web on loopback — answers 200 to any path/method.
  upstream = createServer((_req, res) => {
    res.statusCode = 200;
    res.end('IDE-OK');
  });
  const upstreamPort = await listenEphemeral(upstream);

  process.env.SWARM_OS_DATA_DIR = path.join(tmpRoot, 'data');
  process.env.SWARM_OS_WORKSPACE_ROOT = path.join(tmpRoot, 'workspace');
  process.env.SWARM_OS_MCP_RUNTIME_DIR = path.join(tmpRoot, 'mcp-runtime');
  process.env.SWARM_OS_CLAUDE_SOURCE_DIR = path.join(tmpRoot, 'claude-source');
  process.env.SWARM_OS_CLAUDE_RUNTIME_DIR = path.join(tmpRoot, 'claude-runtime');
  process.env.SWARM_OS_TOKEN = 'test-token-fixed';
  process.env.HOOK_TOKEN = 'test-hook-token-fixed';
  process.env.SWARM_OS_IDE_ENABLED = 'true';
  process.env.SWARM_OS_IDE_PORT = String(upstreamPort);
  process.env.SWARM_OS_PROJECT_NAME = 'ide-proxy-test';
  _resetConfigCacheForTesting();
  const config: Config = loadConfig();

  db = new SwarmDb(path.join(tmpRoot, 'data'));
  features = new FeatureRegistry({
    db,
    eventBus: new SwarmEventBus(),
    config: { codegraphEnabled: true, ideEnabled: true },
  });
  features.register(noopDesc('ide'));

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
  appServer = createServer(app);
  const port = await listenEphemeral(appServer);
  appBase = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.env = envSnapshot;
});

/** GET `<ideBasePath>/` with a valid token so a gated-off request reaches the
 * generic 404 rather than the auth 401 (the token is irrelevant when proxied). */
async function getIde(): Promise<Response> {
  return fetch(`${appBase}/ide/`, { headers: { 'X-Auth-Token': 'test-token-fixed' } });
}

describe('IDE reverse-proxy — call-time gating', () => {
  it('proxies to serve-web when the feature is enabled', async () => {
    const res = await getIde();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('IDE-OK');
  });

  it('stops proxying (falls through to 404) after a hot disable — same app', async () => {
    expect((await getIde()).status).toBe(200);

    await features.disable('ide');
    const off = await getIde();
    expect(off.status).toBe(404);
    expect(await off.text()).not.toContain('IDE-OK');

    // …and comes back on a hot re-enable, no rebuild.
    await features.enable('ide');
    expect((await getIde()).status).toBe(200);
  });
});

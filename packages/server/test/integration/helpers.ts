/**
 * Phase 7 — integration test helpers.
 *
 * Boots a fully-wired server stack against a fresh tmp dir + ephemeral ports.
 * Mirrors what `index.ts` does at boot, minus the signal handlers and the
 * Discord notifier (we wire `NoOpNotifier` plus a recording test double when
 * the test wants to assert on Notifier calls).
 *
 * Returns a teardown function that closes the HTTP server, the MCP server,
 * the SQLite handle, and removes the tmp dir. Tests MUST always call it in
 * `afterEach` (we don't try to leak-detect — vitest is fine with leftover
 * state, the flakiness comes from the file system races on log writes).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import { Spawner } from '../../src/modules/spawner/index.js';
import { McpServer } from '../../src/modules/mcp/server.js';
import { SwarmDb } from '../../src/modules/db/index.js';
import { DbPersistence } from '../../src/modules/orchestrator/persistence.js';
import { RoleStore } from '../../src/modules/roles/index.js';
import { SettingsStore } from '../../src/modules/settings/index.js';
import { MessagesAggregator } from '../../src/modules/metrics/aggregator.js';
import { BusMetricsCollector } from '../../src/modules/metrics/busMetrics.js';
import { BackupScheduler } from '../../src/modules/backup/index.js';
import { PluginStore } from '../../src/modules/plugins/store.js';
import { PluginHost } from '../../src/modules/plugins/host.js';
import { PluginToolRegistry } from '../../src/modules/plugins/mcp-registry.js';
import { PluginHttpRegistry } from '../../src/modules/plugins/http-registry.js';
import { PluginInstaller } from '../../src/modules/plugins/installer.js';
import { ConnectorRegistry } from '../../src/modules/plugins/connector-registry.js';
import type { ProviderRegistry } from '../../src/modules/providers/registry.js';
import { broadcastToLeadsFromExternal } from '../../src/modules/orchestrator/messaging.js';
import { eventBus } from '../../src/events.js';
import { z } from 'zod';
import { createApp, startServer, type BootGate } from '../../src/http/main.js';
import { loadConfig, _resetConfigCacheForTesting } from '../../src/config.js';
import type { Config } from '../../src/config.js';
import type {
  Notifier,
  NotificationInput,
  CustomNotificationInput,
} from '../../src/modules/notify/index.js';
import { NoOpNotifier } from '../../src/modules/notify/null.js';

export interface TestStackOptions {
  /** Override the notifier (defaults to NoOpNotifier). */
  notifier?: Notifier;
  /** Skip starting the MCP listener (for tests that don't need it). */
  skipMcp?: boolean;
  /** Skip starting the main HTTP listener (for tests that just need the express app via supertest-style fetch). */
  skipMainHttp?: boolean;
  /** Override the idle threshold (default 50 ms — keeps tests fast). */
  idleThresholdMs?: number;
  /**
   * Inject a bootGate so a test can hold business + plugin routes at 503 while
   * `value` is false (J2 — verifies plugin routes are gated during boot).
   */
  bootGate?: BootGate;
  /**
   * Multi-provider — substitute the agent-provider registry. Tests that assert
   * on `GET /providers` or on the provider gates MUST pass one: the built-in
   * registry probes the real CLIs on PATH, so its verdicts differ between a dev
   * box and CI.
   */
  providerRegistry?: ProviderRegistry;
}

export interface TestStack {
  config: Config;
  spawner: Spawner;
  mcp: McpServer | null;
  /** Real http.Server when not skipMainHttp; otherwise just an unbound app. */
  http: HttpServer | null;
  /** Resolved port the main HTTP listener bound to (when started). */
  mainPort: number | null;
  db: SwarmDb;
  persistence: DbPersistence;
  /** Exposed so settings tests can read the singleton row without re-instantiating. */
  settingsStore: SettingsStore;
  /** Plugins — host + plugins dir exposed so integration tests can drive scan/enable. */
  pluginHost: PluginHost;
  pluginsDir: string;
  /** J2 — registries exposed so tests can assert registered tools/routers. */
  pluginToolRegistry: PluginToolRegistry;
  pluginHttpRegistry: PluginHttpRegistry;
  /** J3 — installer exposed so tests can drive install/upgrade directly. */
  pluginInstaller: PluginInstaller;
  /** J4 — connector registry exposed so tests can register fake providers. */
  connectorRegistry: ConnectorRegistry;
  /** S9 — exposed so integration tests can call `tick()` synchronously. */
  aggregator: MessagesAggregator;
  /** S8 — exposed so integration tests can call `tick()` / `snapshot()`. */
  busMetrics: BusMetricsCollector;
  workspaceRoot: string;
  dataDir: string;
  /** Tear everything down. Must be called from afterEach. */
  teardown: () => Promise<void>;
}

/** Recording notifier double — captures every call for assertions. */
export class RecordingNotifier implements Notifier {
  readonly events: NotificationInput[] = [];
  readonly customEvents: CustomNotificationInput[] = [];
  async notify(input: NotificationInput): Promise<void> {
    this.events.push(input);
  }
  async notifyCustom(input: CustomNotificationInput): Promise<void> {
    this.customEvents.push(input);
  }
}

/** Pick an unused port — let the kernel choose. */
function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export async function bootTestStack(opts: TestStackOptions = {}): Promise<TestStack> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-int-'));
  const dataDir = path.join(tmpRoot, 'data');
  const workspaceRoot = path.join(tmpRoot, 'workspace');
  const mcpRuntimeDir = path.join(tmpRoot, 'mcp-runtime');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(mcpRuntimeDir, { recursive: true });

  const mcpPort = await ephemeralPort();
  const mainPort = await ephemeralPort();

  // Set env vars for loadConfig — wipe SWARM_OS_* so we get a fresh build.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('SWARM_OS_') || k === 'HOOK_TOKEN') delete process.env[k];
  }
  process.env.SWARM_OS_TOKEN = 'test-token';
  process.env.HOOK_TOKEN = 'test-hook';
  process.env.SWARM_OS_DATA_DIR = dataDir;
  process.env.SWARM_OS_WORKSPACE_ROOT = workspaceRoot;
  process.env.SWARM_OS_MCP_RUNTIME_DIR = mcpRuntimeDir;
  process.env.SWARM_OS_MCP_PORT = String(mcpPort);
  process.env.SWARM_OS_PORT = String(mainPort);
  process.env.SWARM_OS_IDLE_THRESHOLD_MS = String(opts.idleThresholdMs ?? 50);
  process.env.SWARM_OS_LOG_LEVEL = 'fatal';
  process.env.SWARM_OS_LOG_PRETTY = '0';
  process.env.SWARM_OS_HOST = '127.0.0.1';
  process.env.SWARM_OS_CLAUDE_SOURCE_DIR = path.join(tmpRoot, 'claude-source-missing');
  process.env.SWARM_OS_CLAUDE_RUNTIME_DIR = path.join(dataDir, '.claude-runtime');
  _resetConfigCacheForTesting();

  const config = loadConfig();
  const db = new SwarmDb(dataDir);
  const persistence = new DbPersistence(db);
  const roleStore = new RoleStore(db);
  const settingsStore = new SettingsStore(db);
  // Default to no-op so a notifier wasn't passed
  const notifier = opts.notifier ?? new NoOpNotifier();
  // J4 — connector registry. Discord is intentionally NOT registered here (no
  // real Gateway in tests); a test that needs a connector registers a fake one.
  const connectorRegistry = new ConnectorRegistry();
  const spawner = new Spawner(config, {
    notifier,
    persistence,
    roleStore,
    connectorRegistry,
    ...(opts.providerRegistry ? { providerRegistry: opts.providerRegistry } : {}),
  });
  // Plugins — own tables on the raw Db handle + host over `<dataDir>/plugins`.
  // J2 wires the full façade deps (spawner/roles/settings/config) + the MCP and
  // HTTP registries so the integration tests exercise the real dynamic surface.
  const pluginsDir = path.join(dataDir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const pluginStore = new PluginStore(db);
  const pluginToolRegistry = new PluginToolRegistry();
  const pluginHttpRegistry = new PluginHttpRegistry();
  const pluginHost = new PluginHost({
    store: pluginStore,
    eventBus,
    pluginsDir,
    zod: z,
    timeouts: { activateMs: 2000, deactivateMs: 1000 },
    spawner,
    roleStore,
    settingsStore,
    config,
    toolRegistry: pluginToolRegistry,
    httpRegistry: pluginHttpRegistry,
    connectorRegistry,
    onRolesChanged: () => undefined,
    broadcastToLeads: (from, content) => {
      try {
        broadcastToLeadsFromExternal(spawner, from, content, {
          maxMessageSizeBytes: config.maxMessageSizeBytes,
          idleThresholdMs: config.idleThresholdMs,
        });
      } catch {
        /* best-effort */
      }
    },
  });
  // J3 — installer over the same pluginsDir, sharing the host's per-name lock.
  const pluginInstaller = new PluginInstaller({
    pluginsDir,
    store: pluginStore,
    host: pluginHost,
  });
  pluginInstaller.purgeStaging();
  // S9 — aggregator. We DON'T call `start()` in tests: the integration tests
  // drive `tick()` synchronously to avoid 60 s waits, and starting the
  // interval would risk spurious ticks during the test.
  const aggregator = new MessagesAggregator(spawner);
  // S8 — bus collector. Same policy as the aggregator above — tests drive
  // `tick()` manually. The collector is still instantiated so MCP requests
  // can record latency/error counts even without an interval running.
  const busMetrics = new BusMetricsCollector(spawner);
  // Backup scheduler — instantiated so the /backup routes resolve, but NOT
  // started (tests force snapshots via the HTTP route, not the interval).
  const backup = new BackupScheduler({
    db: db.db,
    dataDir,
    intervalMs: config.backupIntervalMs,
    keep: config.backupKeep,
  });

  let mcp: McpServer | null = null;
  if (!opts.skipMcp) {
    mcp = new McpServer(spawner, config.mcpPort, config, busMetrics, pluginToolRegistry);
    await mcp.start();
  }

  let http: HttpServer | null = null;
  if (!opts.skipMainHttp) {
    const handle = startServer(
      config,
      spawner,
      roleStore,
      settingsStore,
      aggregator,
      backup,
      busMetrics,
      opts.bootGate,
      undefined,
      pluginHost,
      pluginHttpRegistry,
      pluginInstaller,
      connectorRegistry,
    );
    http = handle.http;
    // Wait until the listener is actually accepting connections.
    await new Promise<void>((resolve) => {
      if (http?.listening) {
        resolve();
        return;
      }
      http?.once('listening', () => resolve());
    });
    return {
      config,
      spawner,
      mcp,
      http,
      mainPort: config.port,
      db,
      persistence,
      settingsStore,
      pluginHost,
      pluginsDir,
      pluginToolRegistry,
      pluginHttpRegistry,
      pluginInstaller,
      connectorRegistry,
      aggregator,
      busMetrics,
      workspaceRoot,
      dataDir,
      teardown: async () => {
        aggregator.stop();
        busMetrics.stop();
        await pluginHost.deactivateAll();
        spawner.shutdownAll('test-shutdown');
        await new Promise((r) => setTimeout(r, 50));
        if (mcp) await mcp.stop();
        await handle.close();
        db.close();
        try {
          fs.rmSync(tmpRoot, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      },
    };
  }
  // skipMainHttp path — no real listener, return a stack without the http handle.
  return {
    config,
    spawner,
    mcp,
    http: null,
    mainPort: null,
    db,
    persistence,
    settingsStore,
    pluginHost,
    pluginsDir,
    pluginToolRegistry,
    pluginHttpRegistry,
    pluginInstaller,
    connectorRegistry,
    aggregator,
    busMetrics,
    workspaceRoot,
    dataDir,
    teardown: async () => {
      aggregator.stop();
      busMetrics.stop();
      await pluginHost.deactivateAll();
      spawner.shutdownAll('test-shutdown');
      await new Promise((r) => setTimeout(r, 50));
      if (mcp) await mcp.stop();
      db.close();
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

/** Convenience — spin up a standalone express app + http server (no MCP). */
export async function bootHttpOnly(opts: TestStackOptions = {}): Promise<TestStack> {
  return bootTestStack({ ...opts, skipMcp: true });
}

/** Build authenticated REST URL helpers. */
export function authHeaders(token: string): Record<string, string> {
  return { 'X-Auth-Token': token, 'Content-Type': 'application/json' };
}

/** Re-export so test files don't all need the same import dance. */
export { createApp };

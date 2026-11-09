import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, type Server } from 'node:http';
import { createApp, type BootGate } from './main.js';
import { loadConfig, _resetConfigCacheForTesting, type Config } from '../config.js';
import type { Spawner } from '../modules/spawner/index.js';
import type { RoleStore } from '../modules/roles/index.js';
import type { SettingsStore } from '../modules/settings/index.js';
import type { MessagesAggregator } from '../modules/metrics/aggregator.js';
import type { BackupScheduler } from '../modules/backup/index.js';
import { GithubReleasesClient, UpdateService } from '../modules/updates/index.js';

/**
 * `/health` + `/info` — the two public, unauthenticated endpoints.
 *
 * Both are mounted BEFORE the bootGate middleware, so they are the only thing
 * an operator (or the Docker HEALTHCHECK, or a future update verifier) can see
 * while auto-resume is still rebuilding teams. That makes their exact payload
 * load-bearing, hence a test at this altitude rather than through the full
 * integration stack.
 *
 * Light doubles are deliberate: every `create*Router` in this file is pure at
 * construction time (each just news up a `Router()` and registers handlers),
 * and neither route touches anything but `config`, `spawner.counters()` and
 * the gate. Booting a real Spawner + SQLite to assert on a boolean would only
 * add flakiness.
 */

let envSnapshot: NodeJS.ProcessEnv;
let tmpRoot: string;
let listening: Server | null = null;

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

/**
 * A real `UpdateService` over a canned GitHub answer — the projection into
 * `/info` and the mount of `/updates` are the things under test, so faking the
 * service itself would test the fake. Only the network is doubled; the
 * settings store is the one dependency `buildSystemState` touches.
 */
async function warmUpdates(tag: string): Promise<UpdateService> {
  const settings = {
    get: () => ({ dismissedUpdateVersion: null }),
    update: () => undefined,
  } as unknown as SettingsStore;
  const svc = new UpdateService({
    config: { version: '1.2.3', image: 'ghcr.io/o/r:1.2.3', agentTransport: 'ssh' },
    settings,
    github: new GithubReleasesClient({
      token: 'pat',
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          json: async () => [
            {
              tag_name: tag,
              draft: false,
              html_url: 'https://example.com/releases/tag',
              body: 'SECRET RELEASE NOTES',
              published_at: '2026-01-01T00:00:00Z',
            },
          ],
        }) as unknown as Response,
    }),
  });
  await svc.refreshNow();
  return svc;
}

/** Boot the express app on an ephemeral loopback port; returns its base URL. */
async function serve(
  config: Config,
  bootGate?: BootGate,
  updates?: UpdateService,
): Promise<string> {
  const { app } = createApp(
    config,
    spawnerStub,
    roleStoreStub,
    settingsStoreStub,
    aggregatorStub,
    backupStub,
    undefined,
    bootGate,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    updates,
  );
  const server = createServer(app);
  listening = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

beforeEach(() => {
  envSnapshot = { ...process.env };
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-http-'));
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
  // Keep the VS Code reverse-proxy out of the app — nothing here needs it.
  process.env.SWARM_OS_IDE_ENABLED = 'false';
  process.env.SWARM_OS_PROJECT_NAME = 'http-test';
  _resetConfigCacheForTesting();
});

afterEach(async () => {
  if (listening) {
    await new Promise<void>((resolve) => listening!.close(() => resolve()));
    listening = null;
  }
  process.env = envSnapshot;
  _resetConfigCacheForTesting();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('GET /health', () => {
  it('reports boot_complete=false while the gate is closed, and STILL returns 200', async () => {
    const gate: BootGate = { value: false };
    const base = await serve(loadConfig(), gate);
    const res = await fetch(`${base}/health`);
    // The status code is the contract with the Docker HEALTHCHECK: a non-2xx
    // here would restart-loop a container whose auto-resume is merely slow.
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.boot_complete).toBe(false);
  });

  it('flips to boot_complete=true once the gate opens, status unchanged', async () => {
    const gate: BootGate = { value: false };
    const base = await serve(loadConfig(), gate);
    gate.value = true;
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).boot_complete).toBe(true);
  });

  it('reports boot_complete=true when no gate is injected', async () => {
    const base = await serve(loadConfig());
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).boot_complete).toBe(true);
  });
});

describe('GET /info', () => {
  it('exposes version, commit and image', async () => {
    process.env.SWARM_OS_VERSION = '1.2.3';
    process.env.SWARM_OS_COMMIT = 'abc1234';
    process.env.SWARM_OS_IMAGE = 'ghcr.io/nyyyxius/swarm-os:1.2.3';
    _resetConfigCacheForTesting();
    const base = await serve(loadConfig());
    const body = (await (await fetch(`${base}/info`)).json()) as Record<string, unknown>;
    expect(body.project_name).toBe('http-test');
    expect(body.version).toBe('1.2.3');
    expect(body.commit).toBe('abc1234');
    expect(body.image).toBe('ghcr.io/nyyyxius/swarm-os:1.2.3');
    expect(typeof body.started_at).toBe('string');
  });

  it('reports commit/image as null when nothing baked them in', async () => {
    const base = await serve(loadConfig());
    const body = (await (await fetch(`${base}/info`)).json()) as Record<string, unknown>;
    expect(body.commit).toBeNull();
    expect(body.image).toBeNull();
  });

  it('omits `update` entirely when detection is not wired', async () => {
    // Absent, NOT `{available:false}`: a reader must be able to tell "nobody
    // checked" from "nothing new". Dev runs and every test that doesn't pass a
    // service land here.
    const base = await serve(loadConfig());
    const body = (await (await fetch(`${base}/info`)).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('update');
  });

  it('carries the update verdict, and ONLY the boolean and the tag', async () => {
    const base = await serve(loadConfig(), undefined, await warmUpdates('v9.9.9'));
    const body = (await (await fetch(`${base}/info`)).json()) as Record<string, unknown>;
    expect(body.update).toEqual({ available: true, latest: '9.9.9' });
    // The load-bearing assertion of this whole route: `/info` is public, so
    // release notes / notes URL / check status / eligibility must NOT ride
    // along. A shape check, not a spot check — a new field would slip past
    // `toEqual` on a subset otherwise.
    expect(Object.keys(body.update as object).sort()).toEqual(['available', 'latest']);
    expect(JSON.stringify(body)).not.toContain('SECRET RELEASE NOTES');
  });

  it('reports available=false when the published release is not newer', async () => {
    const base = await serve(loadConfig(), undefined, await warmUpdates('v0.1.0'));
    const body = (await (await fetch(`${base}/info`)).json()) as Record<string, unknown>;
    expect(body.update).toEqual({ available: false, latest: '0.1.0' });
  });
});

/**
 * `/updates` — the authenticated half. What matters here is the MOUNT: it has
 * to sit after `app.use(auth)` so the eligibility reason (which names the
 * deployment's transport and image) and the release notes never answer an
 * anonymous caller.
 */
describe('GET /updates', () => {
  it('401s without a token', async () => {
    const base = await serve(loadConfig(), undefined, await warmUpdates('v9.9.9'));
    expect((await fetch(`${base}/updates`)).status).toBe(401);
  });

  it('serves the full state with a token', async () => {
    const base = await serve(loadConfig(), undefined, await warmUpdates('v9.9.9'));
    const res = await fetch(`${base}/updates`, {
      headers: { 'X-Auth-Token': 'test-token-fixed' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const system = body.system as Record<string, unknown>;
    expect(system.latest).toBe('9.9.9');
    expect(system.notesBody).toBe('SECRET RELEASE NOTES');
    expect(body).toHaveProperty('plugins');
    expect(body).toHaveProperty('canSelfUpdate');
  });

  it('404s (not 500s) when detection never came up', async () => {
    const base = await serve(loadConfig());
    const res = await fetch(`${base}/updates`, {
      headers: { 'X-Auth-Token': 'test-token-fixed' },
    });
    expect(res.status).toBe(404);
  });
});

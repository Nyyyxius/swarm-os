import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { createPluginsRouter } from './plugins.js';
import type { PluginHost } from '../../modules/plugins/host.js';
import { PluginNotFoundError } from '../../modules/plugins/host.js';
import type { PluginView } from '../../modules/plugins/api-types.js';
import type { UpdateService, PluginUpdateCheck } from '../../modules/updates/index.js';

/**
 * The plugin listing's update projection.
 *
 * The rule under test is a semantic one, not a plumbing one: an ABSENT
 * `updateStatus` must never be readable as "up to date", and a plugin with no
 * recorded commit must come back `unknown` and never `available`. Every branch
 * below exists because getting it wrong sends an operator to re-install a
 * plugin that is already current — which for a git plugin means a fetch, a
 * swap, and a re-approval of its capabilities.
 *
 * Light doubles: `PluginHost` and `UpdateService` are both consulted through a
 * single method here, and the detector's own semantics are covered by
 * `modules/updates/plugins-check.test.ts`. Standing up SQLite + a network
 * double would test those modules a second time, not this router.
 */

let listening: Server | null = null;

afterEach(async () => {
  if (listening) {
    await new Promise<void>((resolve) => listening!.close(() => resolve()));
    listening = null;
  }
});

function view(over: Partial<PluginView> = {}): PluginView {
  return {
    name: 'echo',
    version: '1.0.0',
    status: 'enabled',
    enabled: true,
    sourceKind: 'git',
    sourceCommit: 'a'.repeat(40),
    apiVersion: 1,
    capabilities: [],
    grantedCapabilities: [],
    failCount: 0,
    quarantinedUntil: null,
    lastError: null,
    installedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    uiPanels: [],
    ...over,
  };
}

function check(over: Partial<PluginUpdateCheck> = {}): PluginUpdateCheck {
  return {
    name: 'echo',
    status: 'available',
    latestVersion: null,
    latestCommit: 'b'.repeat(40),
    reason: null,
    checkedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function hostWith(views: PluginView[]): PluginHost {
  return {
    list: () => views,
    viewOf: (name: string) => {
      const v = views.find((x) => x.name === name);
      if (!v) throw new PluginNotFoundError(name);
      return v;
    },
    getRawConfig: () => ({}),
  } as unknown as PluginHost;
}

/**
 * The double exposes the NARROW accessor only, and makes the wide one explode:
 * `getFullState()` rebuilds `currentRun()` + `listRuns(10)` — an `update_runs`
 * read plus an `events.ndjson` read per non-terminal run — and the plugins
 * listing has no business paying for that. `checksByName` swallows throws, so a
 * route that reached for the full state would silently lose every verdict and
 * the assertions below would go absent.
 */
function updatesWith(plugins: PluginUpdateCheck[]): UpdateService {
  return {
    getPluginChecks: () => plugins,
    getFullState: () => {
      throw new Error('routes/plugins must not build the full update state');
    },
  } as unknown as UpdateService;
}

async function serve(host: PluginHost, updates?: UpdateService): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(createPluginsRouter(host, '/nonexistent/plugins', undefined, updates));
  const server = createServer(app);
  listening = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

async function listPlugins(base: string): Promise<PluginView[]> {
  const body = (await (await fetch(`${base}/plugins`)).json()) as { plugins: PluginView[] };
  return body.plugins;
}

describe('GET /plugins — update projection', () => {
  it('marks a git plugin whose remote moved as available', async () => {
    const base = await serve(hostWith([view()]), updatesWith([check()]));
    const [p] = await listPlugins(base);
    expect(p.updateStatus).toBe('available');
    // A sha is not a version, and `PluginView` has nowhere honest to put one.
    expect(p.latestVersion).toBeNull();
  });

  it('carries the npm version through', async () => {
    const base = await serve(
      hostWith([view({ sourceKind: 'npm', sourceCommit: null })]),
      updatesWith([check({ status: 'available', latestVersion: '2.0.0', latestCommit: null })]),
    );
    const [p] = await listPlugins(base);
    expect(p.updateStatus).toBe('available');
    expect(p.latestVersion).toBe('2.0.0');
  });

  it('reports up_to_date only when the detector actually said so', async () => {
    const base = await serve(hostWith([view()]), updatesWith([check({ status: 'up_to_date' })]));
    expect((await listPlugins(base))[0].updateStatus).toBe('up_to_date');
  });

  it('a plugin with no recorded commit is unknown, never available', async () => {
    const base = await serve(
      hostWith([view({ sourceCommit: null })]),
      updatesWith([check({ status: 'unknown', reason: 'no_recorded_commit', latestCommit: null })]),
    );
    expect((await listPlugins(base))[0].updateStatus).toBe('unknown');
  });

  it('a local source is unknown too — sourceKind is what tells the two apart', async () => {
    const base = await serve(
      hostWith([view({ sourceKind: 'dir', sourceCommit: null })]),
      updatesWith([check({ status: 'local', reason: 'local_source', latestCommit: null })]),
    );
    const [p] = await listPlugins(base);
    expect(p.updateStatus).toBe('unknown');
    expect(p.sourceKind).toBe('dir');
  });

  it('leaves updateStatus ABSENT when detection is not wired', async () => {
    const base = await serve(hostWith([view()]));
    const [p] = await listPlugins(base);
    // Absent, not `up_to_date`: nobody checked, and the badge must stay off
    // rather than assert a freshness we never verified.
    expect(p).not.toHaveProperty('updateStatus');
    expect(p).not.toHaveProperty('latestVersion');
  });

  it('leaves a plugin the sweep has never seen absent as well', async () => {
    const base = await serve(
      hostWith([view({ name: 'echo' }), view({ name: 'fresh' })]),
      updatesWith([check({ name: 'echo' })]),
    );
    const plugins = await listPlugins(base);
    expect(plugins.find((p) => p.name === 'echo')?.updateStatus).toBe('available');
    expect(plugins.find((p) => p.name === 'fresh')).not.toHaveProperty('updateStatus');
  });

  it('survives a throwing update service — the plugins page is not optional', async () => {
    const boom = {
      getPluginChecks: () => {
        throw new Error('detector exploded');
      },
    } as unknown as UpdateService;
    const base = await serve(hostWith([view()]), boom);
    const plugins = await listPlugins(base);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).not.toHaveProperty('updateStatus');
  });
});

describe('GET /plugins/:name — update projection', () => {
  it('shows the same verdict as the listing', async () => {
    const base = await serve(hostWith([view()]), updatesWith([check()]));
    const body = (await (await fetch(`${base}/plugins/echo`)).json()) as { plugin: PluginView };
    expect(body.plugin.updateStatus).toBe('available');
  });

  it('still 404s on an unknown plugin', async () => {
    const base = await serve(hostWith([view()]), updatesWith([check()]));
    expect((await fetch(`${base}/plugins/nope`)).status).toBe(404);
  });
});

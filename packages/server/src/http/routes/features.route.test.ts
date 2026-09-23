import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../../modules/db/index.js';
import { SwarmEventBus } from '../../events.js';
import {
  FeatureRegistry,
  FEATURE_NAMES,
  type FeatureDescriptor,
  type FeatureName,
} from '../../modules/features/registry.js';
import { createFeaturesRouter, type FeaturesRouterDeps } from './features.js';

let dir: string;
let db: SwarmDb;
let features: FeatureRegistry;
let listening: Server | null = null;
let base: string;

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

async function start(deps: FeaturesRouterDeps = {}): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(createFeaturesRouter(features, deps));
  const server = createServer(app);
  listening = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'features-http-'));
  db = new SwarmDb(dir);
  features = new FeatureRegistry({
    db,
    eventBus: new SwarmEventBus(),
    config: { codegraphEnabled: true, ideEnabled: true },
  });
  for (const name of FEATURE_NAMES) features.register(noopDesc(name));
  await start();
});

afterEach(async () => {
  if (listening) await new Promise<void>((resolve) => listening!.close(() => resolve()));
  listening = null;
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('features REST router', () => {
  it('GET /features lists all six, seeded enabled', async () => {
    const res = await fetch(`${base}/features`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { features: Array<{ name: string; state: string }> };
    expect(body.features).toHaveLength(6);
    expect(body.features.every((f) => f.state === 'enabled')).toBe(true);
    expect(body.features.map((f) => f.name).sort()).toEqual([...FEATURE_NAMES].sort());
  });

  it('POST /features/:name/disable turns a feature off', async () => {
    const res = await fetch(`${base}/features/memory/disable`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { feature: { name: string; state: string } };
    expect(body.feature).toMatchObject({ name: 'memory', state: 'disabled' });
    expect(features.isEnabled('memory')).toBe(false);
  });

  it('POST /features/:name/enable turns a feature back on', async () => {
    await fetch(`${base}/features/board/disable`, { method: 'POST' });
    const res = await fetch(`${base}/features/board/enable`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { feature: { state: string } };
    expect(body.feature.state).toBe('enabled');
    expect(features.isEnabled('board')).toBe(true);
  });

  it('DELETE /features/:name uninstalls (purges)', async () => {
    const res = await fetch(`${base}/features/board`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { feature: { state: string } };
    expect(body.feature.state).toBe('uninstalled');
    expect(features.stateOf('board')).toBe('uninstalled');
  });

  it('enable on an uninstalled feature reinstalls it (200, enabled)', async () => {
    await fetch(`${base}/features/board`, { method: 'DELETE' });
    const res = await fetch(`${base}/features/board/enable`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(features.stateOf('board')).toBe('enabled');
  });

  it('an unknown feature name is 404 on every verb', async () => {
    const get = await fetch(`${base}/features/nope/enable`, { method: 'POST' });
    expect(get.status).toBe(404);
    const del = await fetch(`${base}/features/nope`, { method: 'DELETE' });
    expect(del.status).toBe(404);
    const dis = await fetch(`${base}/features/nope/disable`, { method: 'POST' });
    expect(dis.status).toBe(404);
  });
});

describe('features REST router — approvals 409 guard (D9)', () => {
  /** Re-mount the router with a specific blocking-teams checker for this test. */
  async function remount(deps: FeaturesRouterDeps): Promise<void> {
    if (listening) await new Promise<void>((resolve) => listening!.close(() => resolve()));
    listening = null;
    await start(deps);
  }

  it('refuses disable with 409 + names the live teams while any is blocking', async () => {
    await remount({ listBlockingApprovalTeams: () => ['alpha', 'bravo'] });
    const res = await fetch(`${base}/features/approvals/disable`, { method: 'POST' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; teams: string[]; message: string };
    expect(body.error).toBe('APPROVALS_IN_USE');
    expect(body.teams).toEqual(['alpha', 'bravo']);
    // The names appear in the human-facing message so the operator knows who to switch.
    expect(body.message).toContain('alpha');
    expect(body.message).toContain('bravo');
    // …and the feature is UNTOUCHED (still enabled).
    expect(features.isEnabled('approvals')).toBe(true);
  });

  it('refuses uninstall with 409 too (same guard, no purge slips through)', async () => {
    await remount({ listBlockingApprovalTeams: () => ['alpha'] });
    const res = await fetch(`${base}/features/approvals`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; teams: string[] };
    expect(body.error).toBe('APPROVALS_IN_USE');
    expect(body.teams).toEqual(['alpha']);
    expect(features.stateOf('approvals')).toBe('enabled');
  });

  it('lets disable through (200) when NO team is blocking (bypass-only fleet)', async () => {
    await remount({ listBlockingApprovalTeams: () => [] });
    const res = await fetch(`${base}/features/approvals/disable`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(features.isEnabled('approvals')).toBe(false);
  });

  it('never blocks a DIFFERENT feature, even while approvals-blocking teams exist', async () => {
    await remount({ listBlockingApprovalTeams: () => ['alpha'] });
    const res = await fetch(`${base}/features/memory/disable`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(features.isEnabled('memory')).toBe(false);
    // approvals itself is still guarded and untouched.
    expect(features.isEnabled('approvals')).toBe(true);
  });

  it('with no checker wired the guard is inert (approvals disable passes)', async () => {
    await remount({});
    const res = await fetch(`${base}/features/approvals/disable`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(features.isEnabled('approvals')).toBe(false);
  });
});

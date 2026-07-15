/**
 * J3 plugin installer — sources (npm / git / upload / dir), validation,
 * upgrade, uninstall-with-purge, and the shared per-name lock.
 *
 * Fixtures are hermetic: `npm pack`/`npm install` only ever see `file:` specs
 * and local git `file://` repos — no registry, no network. Each npm-invoking
 * test carries a generous timeout (npm cold-start dominates the wall clock).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bootTestStack, authHeaders, type TestStack } from './helpers.js';
import {
  InstallValidationError,
  UploadRequiresNewUploadError,
} from '../../src/modules/plugins/installer.js';
import { PluginHost } from '../../src/modules/plugins/host.js';
import { PluginStore } from '../../src/modules/plugins/store.js';
import { eventBus } from '../../src/events.js';
import { z } from 'zod';

const NPM_TIMEOUT = 90_000;

let stack: TestStack;
let fixtures: string;

const NPM_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: process.env.HOME || '/home/node',
  npm_config_cache: path.join(os.tmpdir(), 'swarm-inst-npmcache'),
  npm_config_update_notifier: 'false',
};

beforeEach(async () => {
  stack = await bootTestStack({ skipMcp: true });
  fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-fix-'));
});

afterEach(async () => {
  await stack.teardown();
  fs.rmSync(fixtures, { recursive: true, force: true });
});

function base(): string {
  return `http://127.0.0.1:${stack.mainPort}`;
}

// --- fixture builders ------------------------------------------------------

interface PluginOpts {
  name: string;
  version?: string;
  main?: string;
  apiVersion?: number;
  capabilities?: string[];
  /** Body of index.js (defaults to a trivial no-op plugin). */
  activate?: string;
  /** package.json contents (npm/upload sources REQUIRE one for npm pack). */
  pkg?: Record<string, unknown>;
  /** Extra files to drop (relative path → contents). */
  extra?: Record<string, string>;
}

function writePlugin(dir: string, o: PluginOpts): void {
  fs.mkdirSync(dir, { recursive: true });
  const main = o.main ?? 'index.js';
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({
      name: o.name,
      version: o.version ?? '1.0.0',
      main,
      apiVersion: o.apiVersion ?? 1,
      capabilities: o.capabilities ?? [],
    }),
  );
  const body =
    o.activate ??
    `export default { activate(api){ api.log.info({event:'${o.name}.up'}); }, deactivate(){} };`;
  fs.mkdirSync(path.dirname(path.join(dir, main)), { recursive: true });
  fs.writeFileSync(path.join(dir, main), body);
  if (o.pkg) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(o.pkg));
  for (const [rel, contents] of Object.entries(o.extra ?? {})) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), contents);
  }
}

/** `npm pack <srcDir>` → absolute path of the produced .tgz. */
function npmPack(srcDir: string, destDir: string): string {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync('npm', ['pack', srcDir, '--pack-destination', destDir, '--silent'], {
    env: NPM_ENV,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const tgz = fs.readdirSync(destDir).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error(`npm pack produced no tarball for ${srcDir}`);
  return path.join(destDir, tgz);
}

function gitInit(repoDir: string): void {
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['-C', repoDir, 'init', '-q', '-b', 'main'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repoDir, 'add', '-A'], { stdio: 'ignore' });
  execFileSync(
    'git',
    ['-C', repoDir, '-c', 'user.email=t@e.io', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'],
    { stdio: 'ignore' },
  );
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

describe('J3 installer — sources', () => {
  it('installs from a directory source, then enables it', async () => {
    const dir = path.join(fixtures, 'src-dir');
    writePlugin(dir, { name: 'fromdir' });
    const r = await stack.pluginInstaller.install({ kind: 'dir', dir });
    expect(r.view.name).toBe('fromdir');
    expect(r.view.sourceKind).toBe('dir');
    expect(r.view.enabled).toBe(false);
    // The folder is now under the plugins dir.
    expect(fs.existsSync(path.join(stack.pluginsDir, 'fromdir', 'plugin.json'))).toBe(true);
    const view = await stack.pluginHost.enable('fromdir');
    expect(view.status).toBe('enabled');
  });

  it('installs from an uploaded .tgz via POST /plugins/upload', async () => {
    const dir = path.join(fixtures, 'src-upload');
    writePlugin(dir, { name: 'fromupload', pkg: { name: 'fromupload', version: '1.0.0' } });
    const tgz = npmPack(dir, path.join(fixtures, 'pack-upload'));
    const bytes = fs.readFileSync(tgz);
    const res = await fetch(`${base()}/plugins/upload?name=fromupload`, {
      method: 'POST',
      headers: { 'X-Auth-Token': stack.config.token, 'Content-Type': 'application/gzip' },
      body: bytes,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plugin: { name: string; sourceKind: string } };
    expect(body.plugin.name).toBe('fromupload');
    expect(body.plugin.sourceKind).toBe('upload');
    expect(fs.existsSync(path.join(stack.pluginsDir, 'fromupload', 'index.js'))).toBe(true);
  }, NPM_TIMEOUT);

  it('installs from a local git file:// repo', async () => {
    const repo = path.join(fixtures, 'repo');
    writePlugin(repo, { name: 'fromgit', version: '2.0.0' });
    gitInit(repo);
    const r = await stack.pluginInstaller.install({ kind: 'git', url: `file://${repo}` });
    expect(r.view.name).toBe('fromgit');
    expect(r.view.sourceKind).toBe('git');
    expect(r.view.version).toBe('2.0.0');
    // The .git dir must be stripped.
    expect(fs.existsSync(path.join(stack.pluginsDir, 'fromgit', '.git'))).toBe(false);
  }, NPM_TIMEOUT);

  it('installs from an npm `file:` spec (same code path as the registry)', async () => {
    const dir = path.join(fixtures, 'src-npm');
    writePlugin(dir, {
      name: 'fromnpm',
      version: '1.2.3',
      pkg: { name: 'fromnpm', version: '1.2.3' },
    });
    const r = await stack.pluginInstaller.install({ kind: 'npm', spec: `file:${dir}` });
    expect(r.view.name).toBe('fromnpm');
    expect(r.view.sourceKind).toBe('npm');
    expect(r.view.version).toBe('1.2.3');
  }, NPM_TIMEOUT);

  it('B-2: an npm-source plugin with a runtime dep resolves it after install', async () => {
    // A tiny CJS dep, packed to a tarball → npm install copies it (move-safe).
    const depDir = path.join(fixtures, 'dep');
    fs.mkdirSync(depDir, { recursive: true });
    fs.writeFileSync(
      path.join(depDir, 'package.json'),
      JSON.stringify({ name: 'swarm-testdep', version: '1.0.0', main: 'index.js' }),
    );
    fs.writeFileSync(path.join(depDir, 'index.js'), `module.exports = { tag: 'dep-ok' };`);
    const depTgz = npmPack(depDir, path.join(fixtures, 'pack-dep'));

    // The plugin imports the dep in activate() — a failed resolution throws and
    // the enable would 422, so a clean enable proves the dep was resolved.
    const plugDir = path.join(fixtures, 'withdep');
    writePlugin(plugDir, {
      name: 'withdep',
      capabilities: ['db-kv'],
      pkg: {
        name: 'withdep',
        version: '1.0.0',
        type: 'module',
        dependencies: { 'swarm-testdep': `file:${depTgz}` },
      },
      activate: `
        import dep from 'swarm-testdep';
        export default {
          activate(api){
            if (dep.tag !== 'dep-ok') throw new Error('dep did not resolve');
            api.storage.kv.set('deptag', dep.tag);
          },
          deactivate(){}
        };`,
    });

    const r = await stack.pluginInstaller.install({ kind: 'npm', spec: `file:${plugDir}` });
    expect(r.view.name).toBe('withdep');
    // Deps landed INSIDE the plugin folder (not hoisted to a staging sibling).
    expect(
      fs.existsSync(path.join(stack.pluginsDir, 'withdep', 'node_modules', 'swarm-testdep')),
    ).toBe(true);
    const view = await stack.pluginHost.enable('withdep');
    expect(view.status).toBe('enabled');
    expect(stack.pluginHost.isActive('withdep')).toBe(true);
  }, NPM_TIMEOUT);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('J3 installer — validation', () => {
  it('refuses a `main` that escapes the package (path traversal)', async () => {
    const dir = path.join(fixtures, 'traverse');
    writePlugin(dir, { name: 'traverse', main: 'index.js' });
    // Overwrite the manifest with a traversal main (writePlugin would sanitise).
    fs.writeFileSync(
      path.join(dir, 'plugin.json'),
      JSON.stringify({ name: 'traverse', version: '1.0.0', main: '../../x.js', apiVersion: 1 }),
    );
    await expect(stack.pluginInstaller.install({ kind: 'dir', dir })).rejects.toBeInstanceOf(
      InstallValidationError,
    );
  });

  it('refuses an out-of-regex name', async () => {
    const dir = path.join(fixtures, 'badname');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'plugin.json'),
      JSON.stringify({ name: 'Bad_Name', version: '1.0.0', main: 'index.js', apiVersion: 1 }),
    );
    fs.writeFileSync(path.join(dir, 'index.js'), 'export default { activate(){} };');
    await expect(stack.pluginInstaller.install({ kind: 'dir', dir })).rejects.toBeInstanceOf(
      InstallValidationError,
    );
  });

  it('refuses apiVersion > HOST_API_VERSION', async () => {
    const dir = path.join(fixtures, 'newer');
    writePlugin(dir, { name: 'newer', apiVersion: 99 });
    await expect(stack.pluginInstaller.install({ kind: 'dir', dir })).rejects.toThrow(
      /apiVersion 99 exceeds host/,
    );
  });
});

// ---------------------------------------------------------------------------
// Upload route guards
// ---------------------------------------------------------------------------

describe('J3 upload route', () => {
  it('rejects a >50MB body with 413', async () => {
    const big = Buffer.alloc(51 * 1024 * 1024);
    const res = await fetch(`${base()}/plugins/upload`, {
      method: 'POST',
      headers: { 'X-Auth-Token': stack.config.token, 'Content-Type': 'application/gzip' },
      body: big,
    });
    expect(res.status).toBe(413);
  });

  it('rejects a JSON content-type with 415', async () => {
    const res = await fetch(`${base()}/plugins/upload`, {
      method: 'POST',
      headers: authHeaders(stack.config.token),
      body: JSON.stringify({ not: 'a tarball' }),
    });
    expect(res.status).toBe(415);
  });
});

// ---------------------------------------------------------------------------
// Upgrade
// ---------------------------------------------------------------------------

describe('J3 upgrade', () => {
  it('upgrade of an active plugin: disable → swap → re-enable, keeps enabled + new version', async () => {
    const dir = path.join(fixtures, 'upg');
    writePlugin(dir, { name: 'upg', version: '1.0.0', capabilities: ['db-kv'] });
    await stack.pluginInstaller.install({ kind: 'dir', dir });
    const enabled = await stack.pluginHost.enable('upg');
    expect(enabled.enabled).toBe(true);
    expect(enabled.version).toBe('1.0.0');

    // Bump the source dir to v2, then upgrade (dir source re-scans the folder).
    writePlugin(dir, { name: 'upg', version: '2.0.0', capabilities: ['db-kv'] });
    const r = await stack.pluginInstaller.upgrade('upg');
    expect(r.isUpgrade).toBe(true);
    expect(r.view.version).toBe('2.0.0');
    expect(r.view.enabled).toBe(true);
    expect(r.view.status).toBe('enabled');
    expect(stack.pluginHost.isActive('upg')).toBe(true);
  });

  it('re-presents NEW capabilities on upgrade instead of granting them silently', async () => {
    const dir = path.join(fixtures, 'caps');
    writePlugin(dir, { name: 'caps', version: '1.0.0', capabilities: ['db-kv'] });
    await stack.pluginInstaller.install({ kind: 'dir', dir });
    await stack.pluginHost.enable('caps', ['db-kv']);

    writePlugin(dir, { name: 'caps', version: '2.0.0', capabilities: ['db-kv', 'notify'] });
    const r = await stack.pluginInstaller.upgrade('caps');
    // The new 'notify' is surfaced for approval, NOT auto-granted.
    expect(r.newCapabilities).toContain('notify');
    expect(r.view.grantedCapabilities).toEqual(['db-kv']);
  });

  it('upgrade of an upload-source plugin → 409', async () => {
    const dir = path.join(fixtures, 'up409');
    writePlugin(dir, { name: 'up409', pkg: { name: 'up409', version: '1.0.0' } });
    const tgz = npmPack(dir, path.join(fixtures, 'pack-409'));
    const res = await fetch(`${base()}/plugins/upload`, {
      method: 'POST',
      headers: { 'X-Auth-Token': stack.config.token, 'Content-Type': 'application/gzip' },
      body: fs.readFileSync(tgz),
    });
    expect(res.status).toBe(200);
    await expect(stack.pluginInstaller.upgrade('up409')).rejects.toBeInstanceOf(
      UploadRequiresNewUploadError,
    );
    const httpRes = await fetch(`${base()}/plugins/up409/upgrade`, {
      method: 'POST',
      headers: authHeaders(stack.config.token),
    });
    expect(httpRes.status).toBe(409);
  }, NPM_TIMEOUT);

  it('interrupted upgrade: a fresh host re-enables the intact old code at boot', async () => {
    // Enable v1 (this is the state a crash BETWEEN disable and rename leaves:
    // old code still on disk, row still enabled at v1).
    const dir = path.join(fixtures, 'recover');
    writePlugin(dir, { name: 'recover', version: '1.0.0' });
    await stack.pluginInstaller.install({ kind: 'dir', dir });
    await stack.pluginHost.enable('recover');
    expect(stack.pluginHost.isActive('recover')).toBe(true);

    // Simulate a reboot: a brand-new host + store over the SAME db + folder.
    const freshHost = new PluginHost({
      store: new PluginStore(stack.db),
      eventBus,
      pluginsDir: stack.pluginsDir,
      zod: z,
    });
    await freshHost.activateEnabled();
    expect(freshHost.isActive('recover')).toBe(true);
    expect(freshHost.viewOf('recover').version).toBe('1.0.0');
    await freshHost.deactivateAll();
  });
});

// ---------------------------------------------------------------------------
// Uninstall + purge
// ---------------------------------------------------------------------------

describe('J3 uninstall', () => {
  it('uninstall of an active plugin disables first; purge drops plugin_<name\'>_* tables', async () => {
    const dir = path.join(fixtures, 'slack-bridge');
    writePlugin(dir, { name: 'slack-bridge', capabilities: ['db-kv'] });
    await stack.pluginInstaller.install({ kind: 'dir', dir });
    await stack.pluginHost.enable('slack-bridge');
    expect(stack.pluginHost.isActive('slack-bridge')).toBe(true);

    // Create a private table the way `defineTable` would name it: name' has
    // '-'→'_', so `slack-bridge` → `plugin_slack_bridge_*`.
    stack.db.db.exec('CREATE TABLE plugin_slack_bridge_state (k TEXT PRIMARY KEY, v TEXT)');
    stack.db.db.exec('CREATE INDEX plugin_slack_bridge_state_idx ON plugin_slack_bridge_state(v)');
    stack.db.db.prepare("INSERT INTO plugin_slack_bridge_state VALUES ('a','b')").run();

    await stack.pluginHost.uninstall('slack-bridge', true);
    // Disabled first (folder + row gone), and the private table is dropped.
    expect(stack.pluginHost.isActive('slack-bridge')).toBe(false);
    expect(fs.existsSync(path.join(stack.pluginsDir, 'slack-bridge'))).toBe(false);
    const remaining = stack.db.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name LIKE 'plugin_slack_bridge_%'",
      )
      .all();
    expect(remaining).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Shared lock (red-team I-8)
// ---------------------------------------------------------------------------

describe('J3 lock', () => {
  it('concurrent upgrade + reload on the same name are serialised (no half-swapped tree)', async () => {
    const dir = path.join(fixtures, 'race');
    writePlugin(dir, { name: 'race', version: '1.0.0' });
    await stack.pluginInstaller.install({ kind: 'dir', dir });
    await stack.pluginHost.enable('race');

    // Bump the source to v2, then fire an upgrade + a reload concurrently. Both
    // take the SAME per-name lock, so neither observes a half-swapped folder.
    writePlugin(dir, { name: 'race', version: '2.0.0' });
    const results = await Promise.allSettled([
      stack.pluginInstaller.upgrade('race'),
      stack.pluginHost.reload('race'),
    ]);
    for (const r of results) expect(r.status).toBe('fulfilled');

    // The plugin ended up active over a COMPLETE, coherent folder.
    expect(stack.pluginHost.isActive('race')).toBe(true);
    expect(fs.existsSync(path.join(stack.pluginsDir, 'race', 'plugin.json'))).toBe(true);
    expect(fs.existsSync(path.join(stack.pluginsDir, 'race', 'index.js'))).toBe(true);
    expect(stack.pluginHost.viewOf('race').version).toBe('2.0.0');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { SwarmDb } from '../db/index.js';
import { SwarmEventBus } from '../../events.js';
import { PluginStore } from './store.js';
import { PluginHost } from './host.js';
import {
  PluginInstaller,
  InstallValidationError,
  isSafeSubdir,
  encodeGitRef,
  decodeGitRef,
} from './installer.js';

// ---------------------------------------------------------------------------
// isSafeSubdir + git ref codec (unit)
// ---------------------------------------------------------------------------

describe('isSafeSubdir', () => {
  it('accepts a plain relative subpath', () => {
    expect(isSafeSubdir('plugin/trader')).toBe(true);
    expect(isSafeSubdir('a')).toBe(true);
  });
  it('rejects empty, absolute, and traversal paths', () => {
    expect(isSafeSubdir('')).toBe(false);
    expect(isSafeSubdir('/etc')).toBe(false);
    expect(isSafeSubdir('..')).toBe(false);
    expect(isSafeSubdir('../x')).toBe(false);
    expect(isSafeSubdir('a/../../b')).toBe(false); // escapes the repo root
  });
  it('accepts an inner path that normalises to stay inside (like isSafeMain)', () => {
    expect(isSafeSubdir('a/../b')).toBe(true); // normalises to 'b' — no escape
  });
});

describe('encodeGitRef / decodeGitRef', () => {
  it('round-trips the legacy url and url#ref forms', () => {
    expect(encodeGitRef('file:///r')).toBe('file:///r');
    expect(decodeGitRef('file:///r')).toEqual({ url: 'file:///r', ref: undefined, subdir: undefined });
    expect(encodeGitRef('file:///r', 'main')).toBe('file:///r#main');
    expect(decodeGitRef('file:///r#main')).toEqual({ url: 'file:///r', ref: 'main', subdir: undefined });
  });
  it('encodes/decodes a subdir (with or without a ref)', () => {
    expect(encodeGitRef('file:///r', 'main', 'plugin/trader')).toBe('file:///r#main#plugin/trader');
    expect(decodeGitRef('file:///r#main#plugin/trader')).toEqual({
      url: 'file:///r',
      ref: 'main',
      subdir: 'plugin/trader',
    });
    // subdir but no ref → empty middle field.
    expect(encodeGitRef('file:///r', undefined, 'sub')).toBe('file:///r##sub');
    expect(decodeGitRef('file:///r##sub')).toEqual({ url: 'file:///r', ref: undefined, subdir: 'sub' });
  });
});

// ---------------------------------------------------------------------------
// install / upgrade from a real git file:// repo with a plugin in a subdir
// ---------------------------------------------------------------------------

describe('git subdir install (real clone via file://)', () => {
  let tmp: string;
  let pluginsDir: string;
  let repo: string;
  let db: SwarmDb;
  let store: PluginStore;
  let host: PluginHost;
  let installer: PluginInstaller;

  function git(cwd: string, ...args: string[]): void {
    execFileSync('git', args, {
      cwd,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
  }

  /** Write a plugin.json + entry into `<repo>/<rel>`. */
  function writePlugin(rel: string, name: string, version = '0.1.0'): void {
    const dir = path.join(repo, rel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'plugin.json'),
      JSON.stringify({ name, version, main: 'index.js', apiVersion: 1, capabilities: [] }),
    );
    fs.writeFileSync(path.join(dir, 'index.js'), 'export default { activate() {} };\n');
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-'));
    pluginsDir = path.join(tmp, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    db = new SwarmDb(tmp);
    store = new PluginStore(db);
    host = new PluginHost({ store, eventBus: new SwarmEventBus(), pluginsDir, zod: z });
    installer = new PluginInstaller({ pluginsDir, store, host });
    installer.purgeStaging();

    // A repo whose plugin lives under plugin/trader/, plus noise at the root.
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    writePlugin('plugin/trader', 'trader', '1.0.0');
    fs.writeFileSync(path.join(repo, 'README.md'), '# root noise\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const fileUrl = (): string => `file://${repo}`;

  /** HEAD of a repo, read the same way the installer does. */
  function headOf(cwd: string): string {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  }

  it('installs the plugin from a subdir (root noise excluded) and records the subdir ref', async () => {
    const res = await installer.install({ kind: 'git', url: fileUrl(), ref: 'main', subdir: 'plugin/trader' });
    expect(res.view.name).toBe('trader');
    expect(res.view.version).toBe('1.0.0');

    // The plugin ROOT on disk is the relocated subdir — its manifest at the top,
    // and the repo-root README must NOT have come along.
    const onDisk = path.join(pluginsDir, 'trader');
    expect(fs.existsSync(path.join(onDisk, 'plugin.json'))).toBe(true);
    expect(fs.existsSync(path.join(onDisk, 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(onDisk, 'README.md'))).toBe(false);
    expect(fs.existsSync(path.join(onDisk, '.git'))).toBe(false);

    // source_ref must encode the subdir so upgrade re-fetches the same folder.
    const row = store.get('trader');
    expect(row?.source_kind).toBe('git');
    expect(decodeGitRef(row?.source_ref ?? '')).toEqual({
      url: fileUrl(),
      ref: 'main',
      subdir: 'plugin/trader',
    });
  });

  it('records the cloned HEAD as source_commit for a subdir install', async () => {
    // The clone's `.git` is deleted during staging — the SHA must be captured
    // before that, and it is the ORIGIN of the whole repo, not of the subdir.
    const res = await installer.install({ kind: 'git', url: fileUrl(), ref: 'main', subdir: 'plugin/trader' });
    expect(res.view.sourceCommit).toBe(headOf(repo));
    expect(store.get('trader')?.source_commit).toBe(headOf(repo));
    expect(headOf(repo)).toMatch(/^[0-9a-f]{40}$/);
  });

  it('upgrade re-clones and re-copies the SAME subdir', async () => {
    await installer.install({ kind: 'git', url: fileUrl(), ref: 'main', subdir: 'plugin/trader' });
    const first = store.get('trader')?.source_commit;
    // Bump the plugin version in the repo and commit.
    writePlugin('plugin/trader', 'trader', '2.0.0');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'bump');

    const res = await installer.upgrade('trader');
    expect(res.isUpgrade).toBe(true);
    expect(res.view.version).toBe('2.0.0');
    expect(fs.existsSync(path.join(pluginsDir, 'trader', 'README.md'))).toBe(false);
    // The commit is RE-recorded, not sticky — this is what makes a later
    // "remote has moved" comparison meaningful.
    expect(res.view.sourceCommit).toBe(headOf(repo));
    expect(res.view.sourceCommit).not.toBe(first);
  });

  it('records no commit for a non-git source', async () => {
    const src = path.join(tmp, 'localplugin');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(
      path.join(src, 'plugin.json'),
      JSON.stringify({ name: 'local', version: '0.1.0', main: 'index.js', apiVersion: 1, capabilities: [] }),
    );
    fs.writeFileSync(path.join(src, 'index.js'), 'export default { activate() {} };\n');

    const res = await installer.install({ kind: 'dir', dir: src });
    expect(res.view.sourceCommit).toBeNull();
    expect(store.get('local')?.source_commit).toBeNull();
  });

  it('rejects a traversal subdir before any clone', async () => {
    await expect(
      installer.install({ kind: 'git', url: fileUrl(), ref: 'main', subdir: '../../etc' }),
    ).rejects.toBeInstanceOf(InstallValidationError);
  });

  it('errors clearly when the subdir has no plugin.json', async () => {
    await expect(
      installer.install({ kind: 'git', url: fileUrl(), ref: 'main', subdir: 'nope' }),
    ).rejects.toThrow(/subdir 'nope' not found/);
  });

  it('still supports a whole-repo git install when a plugin.json sits at the root', async () => {
    // A second repo with the manifest at the top (no subdir).
    const repo2 = path.join(tmp, 'repo2');
    fs.mkdirSync(repo2, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo2, stdio: 'ignore' });
    fs.writeFileSync(
      path.join(repo2, 'plugin.json'),
      JSON.stringify({ name: 'rooted', version: '0.1.0', main: 'index.js', apiVersion: 1, capabilities: [] }),
    );
    fs.writeFileSync(path.join(repo2, 'index.js'), 'export default { activate() {} };\n');
    git(repo2, 'add', '-A');
    git(repo2, 'config', 'user.email', 't@t');
    git(repo2, 'config', 'user.name', 't');
    git(repo2, 'commit', '-q', '-m', 'init');

    const res = await installer.install({ kind: 'git', url: `file://${repo2}`, ref: 'main' });
    expect(res.view.name).toBe('rooted');
    expect(decodeGitRef(store.get('rooted')?.source_ref ?? '')).toEqual({
      url: `file://${repo2}`,
      ref: 'main',
      subdir: undefined,
    });
    // Plain-clone path: HEAD is read from the staging dir itself, before its
    // `.git` is removed (which the existing assertions confirm it is).
    expect(res.view.sourceCommit).toBe(headOf(repo2));
    expect(res.view.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(fs.existsSync(path.join(pluginsDir, 'rooted', '.git'))).toBe(false);
  });
});

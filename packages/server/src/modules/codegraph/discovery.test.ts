import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  discoverScopes,
  slugifyScopeName,
  projectScopeId,
  pluginScopeId,
  WORKSPACE_ROOT_SCOPE_ID,
} from './discovery.js';
import { hasCodeFiles, sourceFingerprint } from './scan.js';

let root: string;
let workspaceRoot: string;
let dataDir: string;

function write(p: string, content = 'x'): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-discovery-'));
  workspaceRoot = path.join(root, 'workspace');
  dataDir = path.join(root, 'data');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('slugify + scope ids', () => {
  it('slugifies unsafe names to filesystem-safe segments', () => {
    expect(slugifyScopeName('my project/v2')).toBe('my-project-v2');
    expect(slugifyScopeName('  .weird.  ')).toBe('weird');
    expect(slugifyScopeName('')).toBe('unnamed');
  });
  it('namespaces project vs plugin ids', () => {
    expect(projectScopeId('foo')).toBe('project__foo');
    expect(pluginScopeId('bar')).toBe('plugin__bar');
  });
});

describe('scan (C3 gate + fingerprint)', () => {
  it('detects a dir with code, rejects a docs-only dir', () => {
    write(path.join(workspaceRoot, 'app', 'index.ts'), 'export const a = 1;');
    write(path.join(workspaceRoot, 'notes', 'README.md'), '# hi');
    expect(hasCodeFiles(path.join(workspaceRoot, 'app'))).toBe(true);
    expect(hasCodeFiles(path.join(workspaceRoot, 'notes'))).toBe(false);
  });

  it('excludes node_modules from the code gate', () => {
    // Only code lives under node_modules → must NOT count as first-party code.
    write(path.join(workspaceRoot, 'deponly', 'node_modules', 'dep', 'lib.js'), 'module.exports=1');
    expect(hasCodeFiles(path.join(workspaceRoot, 'deponly'))).toBe(false);
  });

  it('fingerprint changes when a code file changes, ignores docs', () => {
    const proj = path.join(workspaceRoot, 'app');
    write(path.join(proj, 'a.ts'), 'const a = 1;');
    const fp1 = sourceFingerprint(proj);
    expect(fp1.fileCount).toBe(1);

    // Adding a doc does not change the code fingerprint.
    write(path.join(proj, 'DOC.md'), 'docs');
    expect(sourceFingerprint(proj).hash).toBe(fp1.hash);

    // Adding a code file changes it.
    write(path.join(proj, 'b.ts'), 'const b = 2;');
    const fp3 = sourceFingerprint(proj);
    expect(fp3.fileCount).toBe(2);
    expect(fp3.hash).not.toBe(fp1.hash);
  });

  it('fingerprint ignores files under excluded dirs', () => {
    const proj = path.join(workspaceRoot, 'app');
    write(path.join(proj, 'a.ts'), 'const a = 1;');
    const fp1 = sourceFingerprint(proj);
    write(path.join(proj, 'node_modules', 'dep', 'huge.js'), 'x'.repeat(100));
    expect(sourceFingerprint(proj).hash).toBe(fp1.hash);
  });
});

describe('discoverScopes', () => {
  it('discovers the workspace root + code subdirs, gates docs-only', () => {
    write(path.join(workspaceRoot, 'app', 'index.ts'), 'export const a = 1;');
    write(path.join(workspaceRoot, 'storyforge', 'main.py'), 'def x(): pass');
    write(path.join(workspaceRoot, 'stories', 'ch1.md'), '# chapter');
    // root itself has no top-level code file → root scope hasCode=false here.

    const scopes = discoverScopes({ workspaceRoot, dataDir, pluginStore: null });
    const byId = new Map(scopes.map((s) => [s.id, s]));

    expect(byId.has(WORKSPACE_ROOT_SCOPE_ID)).toBe(true);
    expect(byId.get(projectScopeId('app'))?.hasCode).toBe(true);
    expect(byId.get(projectScopeId('storyforge'))?.hasCode).toBe(true);
    expect(byId.get(projectScopeId('stories'))?.hasCode).toBe(false);
  });

  it('root scope hasCode=true when the workspace has root-level code', () => {
    write(path.join(workspaceRoot, 'root.ts'), 'export const r = 1;');
    const scopes = discoverScopes({ workspaceRoot, dataDir, pluginStore: null });
    const rootScope = scopes.find((s) => s.id === WORKSPACE_ROOT_SCOPE_ID);
    expect(rootScope?.hasCode).toBe(true);
  });

  it('does not emit a scope for a node_modules dir at the workspace root', () => {
    write(path.join(workspaceRoot, 'node_modules', 'dep', 'lib.js'), 'x');
    write(path.join(workspaceRoot, 'app', 'index.ts'), 'export const a = 1;');
    const scopes = discoverScopes({ workspaceRoot, dataDir, pluginStore: null });
    expect(scopes.find((s) => s.id === projectScopeId('node_modules'))).toBeUndefined();
  });

  it('discovers installed plugins with code, excluding their node_modules', () => {
    const pluginDir = path.join(dataDir, 'plugins', 'discord-agent');
    write(path.join(pluginDir, 'index.js'), 'exports.run = () => 1;');
    write(path.join(pluginDir, 'node_modules', 'dep', 'lib.js'), 'x');
    const pluginStore = { list: () => [{ name: 'discord-agent' }, { name: 'ghost-not-on-disk' }] };

    const scopes = discoverScopes({ workspaceRoot, dataDir, pluginStore });
    const plugin = scopes.find((s) => s.id === pluginScopeId('discord-agent'));
    expect(plugin).toBeDefined();
    expect(plugin?.kind).toBe('plugin');
    expect(plugin?.hasCode).toBe(true);
    // A registry row with no dir on disk is skipped.
    expect(scopes.find((s) => s.id === pluginScopeId('ghost-not-on-disk'))).toBeUndefined();
  });
});

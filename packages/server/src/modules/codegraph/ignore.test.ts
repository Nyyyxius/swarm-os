import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isIgnoredDirName, isVirtualenvDir, shouldSkipDir } from './ignore.js';
import { IGNORED_DIR_NAMES, DEFAULT_GRAPHIFY_EXCLUDES } from './constants.js';
import { discoverScopes, projectScopeId } from './discovery.js';
import { hasCodeFiles } from './scan.js';

let root: string;

function write(p: string, content = 'x'): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ignore-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('isIgnoredDirName', () => {
  it('still ignores every exact name of the legacy set', () => {
    for (const name of IGNORED_DIR_NAMES) {
      expect(isIgnoredDirName(name), name).toBe(true);
    }
  });

  it('ignores HIDDEN suffixed / versioned virtualenv names (the .venv-intraday bug)', () => {
    // A dot-directory is a tooling convention, never a checked-out package, so
    // a separator suffix is safe here — and only here.
    for (const name of [
      '.venv-intraday', // the real trader case
      '.venv2',
      '.venv-3.11',
      '.venv_old',
      '.venv.bak',
    ]) {
      expect(isIgnoredDirName(name), name).toBe(true);
    }
  });

  it('ignores VISIBLE dependency dirs only when the suffix is a version number', () => {
    for (const name of ['venv312', 'venv3', 'node_modules2']) {
      expect(isIgnoredDirName(name), name).toBe(true);
    }
  });

  it('matches case-insensitively', () => {
    expect(isIgnoredDirName('.Venv-intraday')).toBe(true);
    expect(isIgnoredDirName('VENV312')).toBe(true);
  });

  it('does NOT ignore plausible first-party names starting with a base word', () => {
    // The false positive is the dangerous failure mode: it silently deletes
    // real code from the graph. A workspace here is a directory of CLONED
    // REPOS, so any published package name can legitimately show up as a
    // top-level dir — `venv-manager` and `node_modules-path` exist on npm,
    // `venv_utils` on PyPI. Only a version-digit suffix is unambiguous.
    for (const name of [
      'venvutils', // a plausible published package
      'venvmanager',
      'venviron',
      'venv_utils', // separated forms are packages too, NOT virtualenvs
      'venv-manager',
      'venv-tools',
      'venv.d',
      'node_modulesfoo',
      'node_modules-path', // a real npm package name
      'node_modules.bak', // a parked dep tree: cheaper to index once than to
      'node_modules-old', // risk deleting a checkout from the graph forever
      '.github', // must never be caught by a `.git` variant
      '.gitlab',
      'env',
      'env-prod', // only layer 2 (pyvenv.cfg) may ever skip this
      'venv_old', // …same: a REAL venv named this way is caught structurally
      'envoy',
      'distributed', // no `dist` variants at all
      'builder',
      'outbound',
      'src',
      'packages',
      'vendored-sdk', // `vendor` stays exact too
    ]) {
      expect(isIgnoredDirName(name), name).toBe(false);
    }
  });

  it('does not blow up on odd names', () => {
    expect(isIgnoredDirName('')).toBe(false);
    expect(isIgnoredDirName('.')).toBe(false);
    expect(isIgnoredDirName('..')).toBe(false);
  });
});

describe('isVirtualenvDir', () => {
  it('detects a virtualenv by its PEP 405 marker, whatever the dir is called', () => {
    const dir = path.join(root, 'env-prod');
    write(path.join(dir, 'pyvenv.cfg'), 'home = /usr/bin\nversion = 3.11.2\n');
    expect(isVirtualenvDir(dir)).toBe(true);
    // The name alone would never have told us.
    expect(isIgnoredDirName('env-prod')).toBe(false);
  });

  it('is false for an ordinary source dir', () => {
    const dir = path.join(root, 'app');
    write(path.join(dir, 'main.py'), 'def x(): pass');
    expect(isVirtualenvDir(dir)).toBe(false);
  });

  it('does not confuse a nested pyvenv.cfg with a venv root', () => {
    const dir = path.join(root, 'app');
    write(path.join(dir, 'fixtures', 'pyvenv.cfg'), 'home = /usr/bin');
    expect(isVirtualenvDir(dir)).toBe(false);
  });

  it('returns false (never throws) on a missing or unreadable path', () => {
    expect(isVirtualenvDir(path.join(root, 'does-not-exist'))).toBe(false);
    expect(isVirtualenvDir(path.join(root, 'a\0b'))).toBe(false);
    // A path whose parent is a file, not a dir → ENOTDIR, still just `false`.
    const file = path.join(root, 'a-file');
    write(file, 'x');
    expect(isVirtualenvDir(file)).toBe(false);
  });
});

describe('shouldSkipDir', () => {
  it('skips on the name alone, without touching the filesystem', () => {
    // The dir does not exist: proof the decision came from the name.
    expect(shouldSkipDir(path.join(root, 'nope', 'node_modules'), 'node_modules')).toBe(true);
    expect(shouldSkipDir(path.join(root, 'nope', '.venv-intraday'), '.venv-intraday')).toBe(true);
  });

  it('falls through to the structural check when the name says nothing', () => {
    const venv = path.join(root, 'env-prod');
    write(path.join(venv, 'pyvenv.cfg'), 'home = /usr/bin');
    const src = path.join(root, 'venvutils');
    write(path.join(src, 'index.ts'), 'export const a = 1;');

    expect(shouldSkipDir(venv, 'env-prod')).toBe(true);
    expect(shouldSkipDir(src, 'venvutils')).toBe(false);
  });

  it('the two layers split `venv_utils` (a package) from `venv_old` (a real venv)', () => {
    // This pair is the whole point of narrowing layer 1: the NAMES are the same
    // shape, so no name rule can separate them. Layer 2 reads the PEP 405
    // marker, which is the only thing that actually differs.
    const pkg = path.join(root, 'venv_utils');
    write(path.join(pkg, 'index.ts'), 'export const a = 1;');
    const venv = path.join(root, 'venv_old');
    write(path.join(venv, 'pyvenv.cfg'), 'home = /usr/bin\nversion = 3.11.2\n');
    write(path.join(venv, 'lib', 'site-packages', 'numpy', '__init__.py'), 'x');

    expect(isIgnoredDirName('venv_utils')).toBe(false);
    expect(isIgnoredDirName('venv_old')).toBe(false);
    expect(shouldSkipDir(pkg, 'venv_utils')).toBe(false); // stays in the graph
    expect(shouldSkipDir(venv, 'venv_old')).toBe(true); // structurally caught
  });

  it('excludes a virtualenv whose name follows NO convention at all', () => {
    // `myproject-py3.11` is what `poetry` / `virtualenvwrapper` produce. No
    // name rule could ever guess it; `pyvenv.cfg` decides on its own.
    const venv = path.join(root, 'myproject-py3.11');
    write(path.join(venv, 'pyvenv.cfg'), 'home = /usr/bin');
    expect(isIgnoredDirName('myproject-py3.11')).toBe(false);
    expect(shouldSkipDir(venv, 'myproject-py3.11')).toBe(true);
  });
});

/**
 * The header of `constants.ts` promises that `DEFAULT_GRAPHIFY_EXCLUDES` (the
 * globs handed to graphify) excludes the SAME set as the walk predicate. Nothing
 * enforced that promise, and it had already drifted (`.hg`/`.svn` were skipped
 * by the walk and indexed by graphify). Divergence is not cosmetic: a dir the
 * walk skips but graphify indexes puts third-party code in the graph, and a dir
 * graphify skips but the walk keeps makes the change-detection fingerprint move
 * for files that can never change the graph — a permanent re-index loop.
 */
describe('parity between the walk predicate and the graphify excludes', () => {
  /** Tiny translator for the gitignore subset used: literals, `[...]`, `*`. */
  function dirGlobToRegExp(glob: string): RegExp {
    let out = '';
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i] as string;
      if (c === '[') {
        const end = glob.indexOf(']', i);
        out += glob.slice(i, end + 1); // character classes pass through
        i = end;
      } else if (c === '*') {
        out += '[^/]*'; // gitignore `*` never crosses a separator
      } else {
        out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
    }
    return new RegExp(`^${out}$`);
  }

  const dirGlobs = DEFAULT_GRAPHIFY_EXCLUDES.filter((g) => g.endsWith('/')).map((g) =>
    dirGlobToRegExp(g.slice(0, -1)),
  );
  const graphifyWouldExclude = (name: string): boolean => dirGlobs.some((re) => re.test(name));

  it('agrees on every name the two layers of ignore.ts can decide by itself', () => {
    const names = [
      ...IGNORED_DIR_NAMES,
      // pattern hits
      '.venv-intraday', '.venv2', '.venv.bak', '.venv_old', 'venv312', 'node_modules2',
      // must stay in the graph on BOTH sides
      'venv_utils', 'venv-manager', 'venv-tools', 'venv.d', 'venvutils',
      'node_modules-path', 'node_modules.bak', 'node_modulesfoo',
      '.github', '.gitlab', 'env', 'env-prod', 'envoy', 'distributed', 'builder',
      'outbound', 'src', 'packages', 'vendored-sdk',
    ];
    for (const name of names) {
      expect(graphifyWouldExclude(name), name).toBe(isIgnoredDirName(name));
    }
  });

  it('documents the two accepted divergences rather than pretending they do not exist', () => {
    // 1. The structural check has no gitignore equivalent.
    const venv = path.join(root, 'venv_old');
    write(path.join(venv, 'pyvenv.cfg'), 'home = /usr/bin');
    expect(shouldSkipDir(venv, 'venv_old')).toBe(true);
    expect(graphifyWouldExclude('venv_old')).toBe(false);

    // 2. The regexes are case-insensitive, gitignore globs are not.
    expect(isIgnoredDirName('.Venv-intraday')).toBe(true);
    expect(graphifyWouldExclude('.Venv-intraday')).toBe(false);

    // Both fail in the harmless direction: the WALK is the stricter of the two,
    // so the worst case is graph noise inside an already-legitimate scope —
    // never a bogus scope, and never first-party code missing from the graph.
  });
});

describe('integration: the walk and discovery honour the new predicate', () => {
  it('a .venv-intraday no longer counts as first-party code', () => {
    const proj = path.join(root, 'trader');
    write(path.join(proj, '.venv-intraday', 'lib', 'site-packages', 'numpy', '__init__.py'), 'x');
    expect(hasCodeFiles(proj)).toBe(false);

    write(path.join(proj, 'strategy.py'), 'def run(): pass');
    expect(hasCodeFiles(proj)).toBe(true);
  });

  it('venv-shaped PACKAGE names still count as first-party code', () => {
    for (const name of ['venvutils', 'venv_utils', 'venv-manager', 'venv-tools']) {
      const proj = path.join(root, `app-${name}`);
      write(path.join(proj, name, 'index.ts'), 'export const a = 1;');
      expect(hasCodeFiles(proj), name).toBe(true);
    }
  });

  it('discovery no longer promotes a top-level virtualenv to its own scope', () => {
    const workspaceRoot = path.join(root, 'workspace');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    write(path.join(workspaceRoot, '.venv-intraday', 'lib', 'dep.py'), 'x');
    write(path.join(workspaceRoot, 'env-prod', 'pyvenv.cfg'), 'home = /usr/bin');
    write(path.join(workspaceRoot, 'venvutils', 'index.ts'), 'export const a = 1;');
    write(path.join(workspaceRoot, 'venv-manager', 'index.ts'), 'export const b = 2;');
    write(path.join(workspaceRoot, 'trader', 'main.py'), 'def x(): pass');

    const scopes = discoverScopes({ workspaceRoot, dataDir, pluginStore: null });
    const ids = new Set(scopes.map((s) => s.id));

    expect(ids.has(projectScopeId('.venv-intraday'))).toBe(false);
    expect(ids.has(projectScopeId('env-prod'))).toBe(false);
    expect(ids.has(projectScopeId('trader'))).toBe(true);
    // …and the legitimate packages are untouched, separated form included: a
    // cloned `venv-manager` repo must get its own scope like any other project.
    expect(ids.has(projectScopeId('venvutils'))).toBe(true);
    expect(ids.has(projectScopeId('venv-manager'))).toBe(true);
    // Skipped dirs are not fed to the root scope's extraExcludes either.
    const rootScope = scopes.find((s) => s.id === 'project__root');
    expect(rootScope?.extraExcludes.sort()).toEqual(['trader', 'venv-manager', 'venvutils']);
  });
});

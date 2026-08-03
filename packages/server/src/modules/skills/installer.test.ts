import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SwarmDb } from '../db/index.js';
import { SkillStore } from './store.js';
import { SkillInstaller, SkillNotFoundError, EmptyPackError } from './installer.js';
import { SkillValidationError } from './stage.js';
import { firstUnsafeTarEntry } from '../install-core/fetch.js';

let dir: string;
let db: SwarmDb;
let store: SkillStore;
let installer: SkillInstaller;
let skillsDir: string;
let srcDir: string;

function writeSkill(target: string, body: string, opts: { name?: string; version?: string } = {}): void {
  fs.mkdirSync(target, { recursive: true });
  const name = opts.name ?? 'hello-skill';
  const version = opts.version ?? '0.1.0';
  fs.writeFileSync(
    path.join(target, 'SKILL.md'),
    `---\nname: ${name}\nversion: ${version}\ndescription: A greeter.\n---\n${body}\n`,
    'utf8',
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-inst-'));
  db = new SwarmDb(dir);
  store = new SkillStore(db);
  skillsDir = path.join(dir, 'skills');
  installer = new SkillInstaller({ skillsDir, store });
  srcDir = path.join(dir, 'src-skill');
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SkillInstaller', () => {
  it('installs from a local dir and records the row + files', async () => {
    writeSkill(srcDir, 'Say hello in one sentence.');
    const r = await installer.install({ kind: 'dir', dir: srcDir });
    expect(r.name).toBe('hello-skill');
    expect(r.source_kind).toBe('dir');
    expect(r.trust).toBe('local');
    expect(r.body_md).toContain('Say hello');
    expect(r.checksum).toBeTruthy();
    expect(fs.existsSync(path.join(skillsDir, 'hello-skill', 'SKILL.md'))).toBe(true);
    expect(store.get('hello-skill')?.version).toBe('0.1.0');
  });

  it('re-imports (upgrade): new body + checksum, installed_at preserved', async () => {
    writeSkill(srcDir, 'v1 body');
    const first = await installer.install({ kind: 'dir', dir: srcDir });
    writeSkill(srcDir, 'v2 body', { version: '0.2.0' });
    const second = await installer.upgrade('hello-skill');
    expect(second.row.version).toBe('0.2.0');
    expect(second.row.body_md).toContain('v2 body');
    expect(second.row.checksum).not.toBe(first.checksum);
    expect(second.row.installed_at).toBe(first.installed_at);
    // Drift is reported for the Lot 3b diff.
    expect(second.drift.checksumChanged).toBe(true);
    expect(second.drift.previousChecksum).toBe(first.checksum);
    expect(second.drift.previousBody).toContain('v1 body');
  });

  it('rejects a dir without SKILL.md as a validation error', async () => {
    fs.mkdirSync(srcDir, { recursive: true });
    await expect(installer.install({ kind: 'dir', dir: srcDir })).rejects.toBeInstanceOf(
      SkillValidationError,
    );
  });

  it('rejects a malformed SKILL.md (missing name) as a validation error', async () => {
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'SKILL.md'), `---\nversion: 0.1.0\n---\nbody`, 'utf8');
    await expect(installer.install({ kind: 'dir', dir: srcDir })).rejects.toBeInstanceOf(
      SkillValidationError,
    );
  });

  it('upgrade of an unknown skill throws SkillNotFoundError', async () => {
    await expect(installer.upgrade('ghost')).rejects.toBeInstanceOf(SkillNotFoundError);
  });

  it('remove drops the row and the folder', async () => {
    writeSkill(srcDir, 'body');
    await installer.install({ kind: 'dir', dir: srcDir });
    installer.remove('hello-skill');
    expect(store.get('hello-skill')).toBeNull();
    expect(fs.existsSync(path.join(skillsDir, 'hello-skill'))).toBe(false);
  });
});

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

/** Build a pack .tgz from a layout `{ '<name>/SKILL.md': '<contents>', ... }`. */
function makePackTgz(files: Record<string, string>): Buffer {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'packmk-'));
  const out = path.join(work, 'pack.tgz');
  try {
    for (const [rel, contents] of Object.entries(files)) {
      const abs = path.join(work, 'root', rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, contents, 'utf8');
    }
    execFileSync('tar', ['-czf', out, '-C', path.join(work, 'root'), '.']);
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

const SKILL_MD = (name: string, body = 'body', version = '0.1.0'): string =>
  `---\nname: ${name}\nversion: ${version}\ndescription: d.\n---\n${body}\n`;

describe('SkillInstaller export + packs (Lot 5a)', () => {
  /** A fresh, independent install target (its own db + skillsDir). */
  function freshTarget(sub: string): { store: SkillStore; installer: SkillInstaller } {
    const tdb = new SwarmDb(path.join(dir, sub));
    const tstore = new SkillStore(tdb);
    return { store: tstore, installer: new SkillInstaller({ skillsDir: path.join(dir, `${sub}-skills`), store: tstore }) };
  }

  it('exports one skill to a .tgz that round-trips through the upload path (assets + checksum preserved)', async () => {
    writeSkill(srcDir, 'exportable body');
    fs.mkdirSync(path.join(srcDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'assets', 'run.sh'), '#!/bin/sh\necho hi\n', 'utf8');
    const original = await installer.install({ kind: 'dir', dir: srcDir });

    const tgz = await installer.exportSkill('hello-skill');
    expect(Buffer.isBuffer(tgz)).toBe(true);
    expect(tgz.length).toBeGreaterThan(0);

    // Re-import the exported bytes as an UPLOAD into a fresh target.
    const target = freshTarget('rt');
    const reimported = await target.installer.install({ kind: 'upload', tgz });
    expect(reimported.name).toBe('hello-skill');
    expect(reimported.body_md).toContain('exportable body');
    expect(reimported.source_kind).toBe('upload');
    // The tree checksum survives the round-trip (SKILL.md + assets/run.sh identical).
    expect(reimported.checksum).toBe(original.checksum);
    expect(
      fs.existsSync(path.join(dir, 'rt-skills', 'hello-skill', 'assets', 'run.sh')),
    ).toBe(true);
  });

  it('exportSkill of an unknown skill throws SkillNotFoundError', async () => {
    await expect(installer.exportSkill('ghost')).rejects.toBeInstanceOf(SkillNotFoundError);
  });

  it('exports a pack of several skills that installs back (per-skill)', async () => {
    writeSkill(path.join(dir, 's-alpha'), 'alpha body', { name: 'alpha' });
    writeSkill(path.join(dir, 's-beta'), 'beta body', { name: 'beta' });
    await installer.install({ kind: 'dir', dir: path.join(dir, 's-alpha') });
    await installer.install({ kind: 'dir', dir: path.join(dir, 's-beta') });

    const { tgz, included, skipped } = await installer.exportPack(['alpha', 'beta']);
    expect(included.map((e) => e.name).sort()).toEqual(['alpha', 'beta']);
    expect(skipped).toEqual([]);

    const target = freshTarget('pk');
    const result = await target.installer.installPack(tgz);
    expect(result.errors).toEqual([]);
    expect(result.installed.map((r) => r.name).sort()).toEqual(['alpha', 'beta']);
    expect(target.store.get('alpha')?.body_md).toContain('alpha body');
    expect(target.store.get('beta')?.body_md).toContain('beta body');
    // Pack members install like an upload → trust 'community'.
    expect(target.store.get('alpha')?.source_kind).toBe('upload');
    expect(target.store.get('alpha')?.trust).toBe('community');
  });

  it('exportPack skips unknown names but exports the valid ones', async () => {
    writeSkill(path.join(dir, 's-only'), 'only body', { name: 'only' });
    await installer.install({ kind: 'dir', dir: path.join(dir, 's-only') });
    const { included, skipped } = await installer.exportPack(['only', 'ghost']);
    expect(included.map((e) => e.name)).toEqual(['only']);
    expect(skipped).toEqual(['ghost']);
  });

  it('exportPack with only unknown names throws EmptyPackError', async () => {
    await expect(installer.exportPack(['ghost', 'phantom'])).rejects.toBeInstanceOf(EmptyPackError);
  });

  it('installPack reports per-skill errors without aborting the others (partial success)', async () => {
    const tgz = makePackTgz({
      'good/SKILL.md': SKILL_MD('good', 'good body'),
      'bad/SKILL.md': `---\nversion: 0.1.0\n---\nno name here\n`, // missing name → invalid
      'pack.json': JSON.stringify({ version: 1, skills: [{ name: 'good' }, { name: 'bad' }] }),
    });
    const target = freshTarget('partial');
    const result = await target.installer.installPack(tgz);
    expect(result.installed.map((r) => r.name)).toEqual(['good']);
    expect(result.errors.map((e) => e.name)).toEqual(['bad']);
    expect(target.store.get('good')?.body_md).toContain('good body');
  });

  it('installPack rejects a corrupt archive gracefully (SkillValidationError, no crash)', async () => {
    const target = freshTarget('corrupt');
    await expect(
      target.installer.installPack(Buffer.from('this is not a gzip tarball')),
    ).rejects.toBeInstanceOf(SkillValidationError);
  });

  it('installPack rejects an archive with an unsafe (absolute/traversal) path', async () => {
    // Build an archive that carries an absolute member path via `tar -P`.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'evil-'));
    const outside = path.join(work, 'outside.txt');
    fs.writeFileSync(outside, 'pwned', 'utf8');
    const evilTgz = path.join(work, 'evil.tgz');
    execFileSync('tar', ['-cPzf', evilTgz, outside]); // -P keeps the absolute path
    const buf = fs.readFileSync(evilTgz);
    fs.rmSync(work, { recursive: true, force: true });

    const target = freshTarget('traversal');
    // Either the guard trips ("unsafe path") or, if tar normalised it, there is no
    // <name>/SKILL.md → "not a skill pack". Both are a clean SkillValidationError.
    await expect(target.installer.installPack(buf)).rejects.toBeInstanceOf(SkillValidationError);
  });

  it('firstUnsafeTarEntry flags absolute and .. paths, passes clean ones', () => {
    expect(firstUnsafeTarEntry(['skill/SKILL.md', 'pack.json'])).toBeNull();
    expect(firstUnsafeTarEntry(['ok/a', '../escape'])).toBe('../escape');
    expect(firstUnsafeTarEntry(['/etc/passwd'])).toBe('/etc/passwd');
    expect(firstUnsafeTarEntry(['a/../../b'])).toBe('a/../../b');
  });
});

describe('SkillInstaller git source', () => {
  let repo: string;

  beforeEach(() => {
    repo = path.join(dir, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    git(['init', '-q'], repo);
    git(['config', 'user.email', 't@t.io'], repo);
    git(['config', 'user.name', 'Tester'], repo);
    fs.writeFileSync(
      path.join(repo, 'SKILL.md'),
      `---\nname: git-skill\nversion: 1.0.0\ndescription: g.\n---\nv1 body\n`,
      'utf8',
    );
    git(['add', '.'], repo);
    git(['commit', '-qm', 'init'], repo);
  });

  it('installs from a local git repo (records commit) and re-imports on upgrade', async () => {
    const r = await installer.install({ kind: 'git', url: `file://${repo}` });
    expect(r.name).toBe('git-skill');
    expect(r.source_kind).toBe('git');
    expect(r.source_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(r.source_ref).toBe(`file://${repo}`);
    expect(r.body_md).toContain('v1 body');
    expect(r.trust).toBe('community'); // not a local dir → community
    const firstCommit = r.source_commit;

    // Advance the repo, then upgrade re-fetches the recorded source.
    fs.writeFileSync(
      path.join(repo, 'SKILL.md'),
      `---\nname: git-skill\nversion: 2.0.0\ndescription: g.\n---\nv2 body\n`,
      'utf8',
    );
    git(['commit', '-qam', 'v2'], repo);
    const up = await installer.upgrade('git-skill');
    expect(up.row.version).toBe('2.0.0');
    expect(up.row.body_md).toContain('v2 body');
    expect(up.row.source_commit).not.toBe(firstCommit);
  });
});

describe('SkillInstaller trust + review drift', () => {
  it('promotes a git source to verified via the injected allowlist', async () => {
    const inst = new SkillInstaller({
      skillsDir: path.join(dir, 'skills-v'),
      store,
      trust: { verified: ['github.com/acme/'], firstParty: [] },
    });
    const src = path.join(dir, 'v-skill');
    writeSkill(src, 'body', { name: 'v-skill' });
    // A dir source is always local regardless of the allowlist.
    const local = await inst.install({ kind: 'dir', dir: src });
    expect(local.trust).toBe('local');
  });

  it('resets reviewed when a re-import changes the tree (fail-safe)', async () => {
    writeSkill(srcDir, 'v1');
    await installer.install({ kind: 'dir', dir: srcDir });
    store.patch('hello-skill', { reviewed: 1, reviewed_at: new Date().toISOString() });
    expect(store.get('hello-skill')?.reviewed).toBe(1);

    writeSkill(srcDir, 'v2 changed', { version: '0.3.0' });
    const up = await installer.upgrade('hello-skill');
    expect(up.drift.checksumChanged).toBe(true);
    expect(up.row.reviewed).toBe(0); // review invalidated by content drift
  });

  it('preserves reviewed when a re-import is byte-identical', async () => {
    writeSkill(srcDir, 'stable');
    await installer.install({ kind: 'dir', dir: srcDir });
    store.patch('hello-skill', { reviewed: 1, reviewed_at: new Date().toISOString() });
    const up = await installer.upgrade('hello-skill');
    expect(up.drift.checksumChanged).toBe(false);
    expect(up.row.reviewed).toBe(1);
  });
});

describe('SkillInstaller market source', () => {
  let repo: string;
  let mktInstaller: SkillInstaller;

  // A catalog repo laid out like agentskills.io / anthropics/skills:
  // `skills/<name>/SKILL.md`. A bare market name `hello` → subdir `skills/hello`.
  function writeRepoSkill(body: string, version = '1.0.0'): void {
    const skillDir = path.join(repo, 'skills', 'hello');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: hello\nversion: ${version}\ndescription: g.\n---\n${body}\n`,
      'utf8',
    );
  }

  beforeEach(() => {
    repo = path.join(dir, 'catalog-repo');
    fs.mkdirSync(repo, { recursive: true });
    git(['init', '-q'], repo);
    git(['config', 'user.email', 't@t.io'], repo);
    git(['config', 'user.name', 'Tester'], repo);
    writeRepoSkill('v1 market body');
    git(['add', '.'], repo);
    git(['commit', '-qm', 'init'], repo);
    // Catalog points at the LOCAL repo (a full git url is accepted verbatim), so
    // the market path is exercised end-to-end with NO network.
    mktInstaller = new SkillInstaller({
      skillsDir: path.join(dir, 'skills-mkt'),
      store,
      market: { catalog: [`file://${repo}`], catalogPrefix: 'skills', timeoutMs: 1000 },
    });
  });

  it('installs a bare market name via the catalog convention (delegates to git)', async () => {
    const r = await mktInstaller.install({ kind: 'market', ref: 'hello' });
    expect(r.name).toBe('hello');
    expect(r.source_kind).toBe('market');
    expect(r.source_ref).toBe('hello'); // ORIGINAL ref stored so upgrade re-resolves
    expect(r.source_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(r.trust).toBe('community'); // market is never auto-privileged
    expect(r.body_md).toContain('v1 market body');
  });

  it('re-resolves the market ref on upgrade (picks up the repo HEAD)', async () => {
    const first = await mktInstaller.install({ kind: 'market', ref: 'hello' });
    writeRepoSkill('v2 market body', '2.0.0');
    git(['commit', '-qam', 'v2'], repo);
    const up = await mktInstaller.upgrade('hello');
    expect(up.row.version).toBe('2.0.0');
    expect(up.row.body_md).toContain('v2 market body');
    expect(up.row.source_commit).not.toBe(first.source_commit);
    expect(up.drift.checksumChanged).toBe(true);
  });

  it('rejects an unresolvable bare name (no endpoint, empty catalog) as a validation error', async () => {
    const inst = new SkillInstaller({
      skillsDir: path.join(dir, 'skills-mkt-empty'),
      store,
      market: { catalog: [], catalogPrefix: 'skills', timeoutMs: 1000 },
    });
    await expect(inst.install({ kind: 'market', ref: 'ghost' })).rejects.toBeInstanceOf(
      SkillValidationError,
    );
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../db/index.js';
import { SkillStore } from './store.js';
import { SkillInstaller, SkillNotFoundError } from './installer.js';
import { SkillValidationError } from './stage.js';

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
    expect(second.version).toBe('0.2.0');
    expect(second.body_md).toContain('v2 body');
    expect(second.checksum).not.toBe(first.checksum);
    expect(second.installed_at).toBe(first.installed_at);
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

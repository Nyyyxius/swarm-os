import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listSkillAssets, readSkillAsset, assetsSubdir } from './review.js';
import type { SkillRow } from './store.js';

let dir: string;
let skillsDir: string;

function rowWithAssets(over: Partial<SkillRow> = {}): SkillRow {
  const now = new Date().toISOString();
  return {
    name: 'inspectme',
    version: '0.1.0',
    display_name: null,
    description: null,
    source_kind: 'dir',
    source_ref: null,
    source_commit: null,
    checksum: null,
    trust: 'local',
    requires_json: null,
    assets_present: 1,
    reviewed: 0,
    reviewed_at: null,
    body_md: 'body',
    frontmatter_json: '{"assets":{"dir":"assets"}}',
    installed_at: now,
    updated_at: now,
    last_error: null,
    ...over,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-review-'));
  skillsDir = path.join(dir, 'skills');
  const assets = path.join(skillsDir, 'inspectme', 'assets');
  fs.mkdirSync(path.join(assets, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(assets, 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
  fs.writeFileSync(path.join(assets, 'notes.txt'), 'plain text', { mode: 0o644 });
  fs.writeFileSync(path.join(assets, 'sub', 'nested.py'), 'print(1)\n', { mode: 0o644 });
  fs.writeFileSync(path.join(assets, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
  // A sibling file OUTSIDE the assets dir, to prove traversal cannot reach it.
  fs.writeFileSync(path.join(skillsDir, 'inspectme', 'SKILL.md'), 'secret manifest');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('assetsSubdir', () => {
  it('returns the declared dir, or null when no assets', () => {
    expect(assetsSubdir(rowWithAssets())).toBe('assets');
    expect(assetsSubdir(rowWithAssets({ assets_present: 0 }))).toBeNull();
    expect(assetsSubdir(rowWithAssets({ frontmatter_json: '{}' }))).toBeNull();
  });
});

describe('listSkillAssets', () => {
  it('lists files recursively, sorted, with executable + text flags', () => {
    const list = listSkillAssets(skillsDir, rowWithAssets());
    const paths = list.map((a) => a.path);
    expect(paths).toEqual(['blob.bin', 'notes.txt', 'run.sh', 'sub/nested.py']);
    const run = list.find((a) => a.path === 'run.sh')!;
    expect(run.executable).toBe(true);
    expect(run.isText).toBe(true);
    expect(list.find((a) => a.path === 'notes.txt')!.executable).toBe(false);
    expect(list.find((a) => a.path === 'blob.bin')!.isText).toBe(false);
  });

  it('returns [] when the skill ships no assets', () => {
    expect(listSkillAssets(skillsDir, rowWithAssets({ assets_present: 0 }))).toEqual([]);
  });
});

describe('readSkillAsset', () => {
  it('reads a text asset with its metadata', () => {
    const a = readSkillAsset(skillsDir, rowWithAssets(), 'run.sh');
    expect(a?.content).toContain('echo hi');
    expect(a?.executable).toBe(true);
    expect(a?.binary).toBe(false);
  });

  it('withholds binary content but reports metadata', () => {
    const a = readSkillAsset(skillsDir, rowWithAssets(), 'blob.bin');
    expect(a?.binary).toBe(true);
    expect(a?.content).toBe('');
  });

  it('refuses a traversal path (cannot escape the assets dir)', () => {
    expect(readSkillAsset(skillsDir, rowWithAssets(), '../SKILL.md')).toBeNull();
    expect(readSkillAsset(skillsDir, rowWithAssets(), '../../inspectme/SKILL.md')).toBeNull();
    expect(readSkillAsset(skillsDir, rowWithAssets(), '/etc/passwd')).toBeNull();
  });

  it('returns null for a missing asset', () => {
    expect(readSkillAsset(skillsDir, rowWithAssets(), 'nope.txt')).toBeNull();
  });
});

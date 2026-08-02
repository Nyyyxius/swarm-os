import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../db/index.js';
import { SkillStore, type SkillRow } from './store.js';

let dir: string;
let db: SwarmDb;
let store: SkillStore;

function row(over: Partial<SkillRow> = {}): SkillRow {
  const now = new Date().toISOString();
  return {
    name: 'hello-skill',
    version: '0.1.0',
    display_name: 'Hello',
    description: 'greeter',
    source_kind: 'dir',
    source_ref: '/data/skills/hello-skill',
    source_commit: null,
    checksum: 'abc',
    trust: 'local',
    requires_json: null,
    assets_present: 0,
    body_md: 'Say hello.',
    frontmatter_json: '{"name":"hello-skill","version":"0.1.0"}',
    installed_at: now,
    updated_at: now,
    last_error: null,
    ...over,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-store-'));
  db = new SwarmDb(dir);
  store = new SkillStore(db);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SkillStore', () => {
  it('upserts, gets and lists', () => {
    expect(store.get('hello-skill')).toBeNull();
    store.upsert(row());
    const got = store.get('hello-skill');
    expect(got?.name).toBe('hello-skill');
    expect(got?.body_md).toBe('Say hello.');
    expect(store.list()).toHaveLength(1);
  });

  it('preserves installed_at across a re-import upsert', () => {
    store.upsert(row({ installed_at: '2020-01-01T00:00:00.000Z' }));
    store.upsert(row({ version: '0.2.0', installed_at: '2099-01-01T00:00:00.000Z' }));
    const got = store.get('hello-skill');
    expect(got?.version).toBe('0.2.0');
    expect(got?.installed_at).toBe('2020-01-01T00:00:00.000Z');
  });

  it('patch merges fields and bumps updated_at', () => {
    store.upsert(row({ updated_at: '2020-01-01T00:00:00.000Z' }));
    const p = store.patch('hello-skill', { last_error: 'boom' });
    expect(p?.last_error).toBe('boom');
    expect(p?.updated_at).not.toBe('2020-01-01T00:00:00.000Z');
    expect(store.patch('nope', {})).toBeNull();
  });

  it('deletes', () => {
    store.upsert(row());
    store.delete('hello-skill');
    expect(store.get('hello-skill')).toBeNull();
  });
});

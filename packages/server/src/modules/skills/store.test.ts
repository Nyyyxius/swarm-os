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

describe('SkillStore activations', () => {
  function act(over: Partial<Parameters<SkillStore['upsertActivation']>[0]> = {}) {
    return {
      id: `id-${Math.random().toString(36).slice(2)}`,
      skill_name: 'sk',
      scope_type: 'orch' as const,
      scope_id: 'orch1',
      mode: 'inject',
      enabled: 1,
      created_at: new Date().toISOString(),
      ...over,
    };
  }

  it('upserts, lists and updates by (skill, scope_type, scope_id)', () => {
    store.upsertActivation(act());
    let rows = store.listActivations('orch', 'orch1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enabled).toBe(1);
    // Same key → UPDATE (not a second row): flip enabled.
    store.upsertActivation(act({ enabled: 0 }));
    rows = store.listActivations('orch', 'orch1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enabled).toBe(0);
  });

  it('scopes are isolated by type and id', () => {
    store.upsertActivation(act({ scope_type: 'orch', scope_id: 'orch1' }));
    store.upsertActivation(act({ scope_type: 'session', scope_id: 'sess1' }));
    expect(store.listActivations('orch', 'orch1')).toHaveLength(1);
    expect(store.listActivations('session', 'sess1')).toHaveLength(1);
    expect(store.listActivations('orch', 'other')).toEqual([]);
  });

  it('deleteActivation removes a single scope entry', () => {
    store.upsertActivation(act());
    store.deleteActivation('sk', 'orch', 'orch1');
    expect(store.listActivations('orch', 'orch1')).toEqual([]);
  });

  it('deleteActivationsForSkill purges every scope', () => {
    store.upsertActivation(act({ scope_type: 'orch', scope_id: 'orch1' }));
    store.upsertActivation(act({ scope_type: 'session', scope_id: 'sess1' }));
    store.deleteActivationsForSkill('sk');
    expect(store.listActivations('orch', 'orch1')).toEqual([]);
    expect(store.listActivations('session', 'sess1')).toEqual([]);
  });

  it('deleteActivationsForScope purges a scope', () => {
    store.upsertActivation(act({ skill_name: 'a' }));
    store.upsertActivation(act({ skill_name: 'b' }));
    store.deleteActivationsForScope('orch', 'orch1');
    expect(store.listActivations('orch', 'orch1')).toEqual([]);
  });
});

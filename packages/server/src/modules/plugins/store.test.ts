import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../db/index.js';
import { PluginStore, type PluginRow } from './store.js';

let dir: string;
let db: SwarmDb;
let store: PluginStore;

function row(over: Partial<PluginRow> = {}): PluginRow {
  const now = new Date().toISOString();
  return {
    name: 'echo',
    version: '0.1.0',
    source_kind: 'dir',
    source_ref: '/data/plugins/echo',
    enabled: 0,
    config_json: null,
    granted_capabilities_json: null,
    api_version: 1,
    fail_count: 0,
    quarantined_until: null,
    installed_at: now,
    updated_at: now,
    last_error: null,
    ...over,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-store-'));
  db = new SwarmDb(dir);
  store = new PluginStore(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('PluginStore', () => {
  it('creates its tables and round-trips a row', () => {
    expect(store.get('echo')).toBeNull();
    store.upsert(row());
    const got = store.get('echo');
    expect(got?.name).toBe('echo');
    expect(got?.enabled).toBe(0);
    expect(store.list().map((r) => r.name)).toEqual(['echo']);
  });

  it('listEnabled returns only enabled rows', () => {
    store.upsert(row({ name: 'a', enabled: 1 }));
    store.upsert(row({ name: 'b', enabled: 0 }));
    expect(store.listEnabled().map((r) => r.name)).toEqual(['a']);
  });

  it('patch preserves installed_at and bumps updated_at', async () => {
    store.upsert(row());
    const before = store.get('echo')!;
    await new Promise((r) => setTimeout(r, 5));
    const after = store.patch('echo', { enabled: 1, last_error: 'x' });
    expect(after?.enabled).toBe(1);
    expect(after?.last_error).toBe('x');
    expect(after?.installed_at).toBe(before.installed_at);
    expect(after?.updated_at).not.toBe(before.updated_at);
  });

  it('upsert does not overwrite installed_at on conflict', () => {
    store.upsert(row({ installed_at: '2020-01-01T00:00:00.000Z' }));
    store.upsert(row({ installed_at: '2099-01-01T00:00:00.000Z', version: '0.2.0' }));
    const got = store.get('echo')!;
    expect(got.installed_at).toBe('2020-01-01T00:00:00.000Z');
    expect(got.version).toBe('0.2.0');
  });

  it('delete removes the row', () => {
    store.upsert(row());
    store.delete('echo');
    expect(store.get('echo')).toBeNull();
  });

  it('parses config JSON, tolerating malformed input', () => {
    store.upsert(row({ config_json: JSON.stringify({ token: 'abc', n: 3 }) }));
    expect(store.getConfig('echo')).toEqual({ token: 'abc', n: 3 });
    store.patch('echo', { config_json: 'not-json' });
    expect(store.getConfig('echo')).toEqual({});
    store.patch('echo', { config_json: JSON.stringify([1, 2]) }); // array, not object
    expect(store.getConfig('echo')).toEqual({});
  });

  it('kv get/set/delete/list with prefix', () => {
    store.kvSet('echo', 'a:1', 'x');
    store.kvSet('echo', 'a:2', 'y');
    store.kvSet('echo', 'b:1', 'z');
    expect(store.kvGet('echo', 'a:1')).toBe('x');
    expect(store.kvGet('echo', 'missing')).toBeNull();
    expect(store.kvList('echo').map((e) => e.key)).toEqual(['a:1', 'a:2', 'b:1']);
    expect(store.kvList('echo', 'a:').map((e) => e.key)).toEqual(['a:1', 'a:2']);
    store.kvDelete('echo', 'a:1');
    expect(store.kvGet('echo', 'a:1')).toBeNull();
  });

  it('kv is namespaced per plugin', () => {
    store.kvSet('echo', 'k', 'echo-val');
    store.kvSet('other', 'k', 'other-val');
    expect(store.kvGet('echo', 'k')).toBe('echo-val');
    expect(store.kvGet('other', 'k')).toBe('other-val');
  });

  it('purgeKv wipes only that plugin', () => {
    store.kvSet('echo', 'k', '1');
    store.kvSet('other', 'k', '2');
    store.purgeKv('echo');
    expect(store.kvGet('echo', 'k')).toBeNull();
    expect(store.kvGet('other', 'k')).toBe('2');
  });

  it('kv list prefix treats wildcards literally', () => {
    store.kvSet('echo', '50%', 'a');
    store.kvSet('echo', '5000', 'b');
    // A LIKE-injection-style prefix must not match '5000'.
    expect(store.kvList('echo', '50%').map((e) => e.key)).toEqual(['50%']);
  });
});

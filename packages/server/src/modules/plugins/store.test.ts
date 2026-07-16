import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../db/index.js';
import { PluginStore, type PluginRow } from './store.js';
import { PluginStorageError } from './api-types.js';

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

/** Names present in `sqlite_master` (tables/indexes/triggers). */
function schemaNames(): string[] {
  return db.db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type IN ('table','index','trigger')",
    )
    .all()
    .map((r) => r.name);
}

describe('PluginStore db-tables', () => {
  it('tablePrefix matches the uninstall-purge normalisation (dash → underscore)', () => {
    expect(PluginStore.tablePrefix('echo')).toBe('plugin_echo_');
    expect(PluginStore.tablePrefix('slack-bridge')).toBe('plugin_slack_bridge_');
  });

  it('defineTable creates a prefixed table (visible in sqlite_master) and is idempotent', () => {
    const ddl = 'CREATE TABLE IF NOT EXISTS plugin_echo_notes (id INTEGER PRIMARY KEY, body TEXT)';
    store.defineTable('echo', ddl);
    expect(schemaNames()).toContain('plugin_echo_notes');
    // Idempotent — re-running the same IF NOT EXISTS DDL is a no-op, not a throw.
    expect(() => store.defineTable('echo', ddl)).not.toThrow();
  });

  it('defineTable normalises a dashed plugin name into the underscore prefix', () => {
    store.defineTable(
      'slack-bridge',
      'CREATE TABLE plugin_slack_bridge_state (k TEXT PRIMARY KEY, v TEXT)',
    );
    expect(schemaNames()).toContain('plugin_slack_bridge_state');
  });

  it('defineTable accepts a prefixed index and trigger on the plugin table', () => {
    store.defineTable('echo', 'CREATE TABLE plugin_echo_t (id INTEGER PRIMARY KEY, v TEXT)');
    expect(() =>
      store.defineTable('echo', 'CREATE INDEX plugin_echo_t_idx ON plugin_echo_t(v)'),
    ).not.toThrow();
    expect(() =>
      store.defineTable(
        'echo',
        'CREATE TRIGGER plugin_echo_t_tr AFTER INSERT ON plugin_echo_t BEGIN UPDATE plugin_echo_t SET v = v; END',
      ),
    ).not.toThrow();
    expect(schemaNames()).toEqual(
      expect.arrayContaining(['plugin_echo_t', 'plugin_echo_t_idx', 'plugin_echo_t_tr']),
    );
  });

  it('defineTable rejects a table name outside the plugin prefix (nothing created)', () => {
    expect(() => store.defineTable('echo', 'CREATE TABLE evil (id INTEGER)')).toThrow(
      PluginStorageError,
    );
    expect(() =>
      store.defineTable('echo', 'CREATE TABLE plugin_other_x (id INTEGER)'),
    ).toThrow(PluginStorageError);
    expect(schemaNames()).not.toContain('evil');
    expect(schemaNames()).not.toContain('plugin_other_x');
  });

  it('defineTable rejects a multi-statement DDL', () => {
    expect(() =>
      store.defineTable(
        'echo',
        'CREATE TABLE plugin_echo_a (id INTEGER); DROP TABLE roles',
      ),
    ).toThrow();
    expect(schemaNames()).not.toContain('plugin_echo_a');
  });

  it('defineTable rejects a non-CREATE statement (PRAGMA / ATTACH / DROP)', () => {
    expect(() => store.defineTable('echo', 'PRAGMA journal_mode = WAL')).toThrow(
      PluginStorageError,
    );
    expect(() =>
      store.defineTable('echo', "ATTACH DATABASE ':memory:' AS z"),
    ).toThrow(PluginStorageError);
    expect(() => store.defineTable('echo', 'DROP TABLE roles')).toThrow(PluginStorageError);
  });

  it('defineTable rejects reading core data via CREATE TABLE … AS SELECT', () => {
    expect(() =>
      store.defineTable(
        'echo',
        'CREATE TABLE plugin_echo_leak AS SELECT name FROM sqlite_master',
      ),
    ).toThrow(PluginStorageError);
    expect(schemaNames()).not.toContain('plugin_echo_leak');
  });

  it('defineTable rejects a trigger wired onto a core table', () => {
    // Real core table from the applied schema.
    db.db.exec('CREATE TABLE IF NOT EXISTS coretbl (id INTEGER PRIMARY KEY)');
    expect(() =>
      store.defineTable(
        'echo',
        'CREATE TRIGGER plugin_echo_hook AFTER INSERT ON coretbl BEGIN SELECT 1; END',
      ),
    ).toThrow(PluginStorageError);
    expect(schemaNames()).not.toContain('plugin_echo_hook');
  });

  it('prepare runs run/get/all against the plugin table', () => {
    store.defineTable('echo', 'CREATE TABLE plugin_echo_kvt (k TEXT PRIMARY KEY, n INTEGER)');
    store.prepareForPlugin('echo', 'INSERT INTO plugin_echo_kvt (k, n) VALUES (@k, @n)').run({
      k: 'a',
      n: 1,
    });
    store.prepareForPlugin('echo', 'INSERT INTO plugin_echo_kvt (k, n) VALUES (@k, @n)').run({
      k: 'b',
      n: 2,
    });
    const one = store
      .prepareForPlugin<{ k: string }, { n: number }>('echo', 'SELECT n FROM plugin_echo_kvt WHERE k = @k')
      .get({ k: 'a' });
    expect(one?.n).toBe(1);
    const all = store
      .prepareForPlugin<object, { k: string }>('echo', 'SELECT k FROM plugin_echo_kvt ORDER BY k')
      .all();
    expect(all.map((r) => r.k)).toEqual(['a', 'b']);
  });

  it('prepare rejects referencing a core or another plugin table', () => {
    db.db.exec('CREATE TABLE IF NOT EXISTS othercore (id INTEGER)');
    store.defineTable('other', 'CREATE TABLE plugin_other_data (id INTEGER)');
    expect(() => store.prepareForPlugin('echo', 'SELECT * FROM othercore')).toThrow(
      PluginStorageError,
    );
    expect(() => store.prepareForPlugin('echo', 'SELECT * FROM plugin_other_data')).toThrow(
      PluginStorageError,
    );
    // Writes to core are refused just the same.
    expect(() =>
      store.prepareForPlugin('echo', 'DELETE FROM othercore WHERE id = 1'),
    ).toThrow(PluginStorageError);
  });

  it('prepare rejects multi-statement, DDL, PRAGMA and ATTACH', () => {
    store.defineTable('echo', 'CREATE TABLE plugin_echo_p (id INTEGER)');
    expect(() =>
      store.prepareForPlugin('echo', 'SELECT * FROM plugin_echo_p; DROP TABLE plugin_echo_p'),
    ).toThrow();
    expect(() => store.prepareForPlugin('echo', 'DROP TABLE plugin_echo_p')).toThrow(
      PluginStorageError,
    );
    expect(() => store.prepareForPlugin('echo', 'PRAGMA table_info(plugin_echo_p)')).toThrow(
      PluginStorageError,
    );
    expect(() =>
      store.prepareForPlugin('echo', "ATTACH DATABASE ':memory:' AS z"),
    ).toThrow(PluginStorageError);
    // A PRAGMA table-valued function in a subquery is refused too.
    expect(() =>
      store.prepareForPlugin('echo', "SELECT * FROM pragma_table_info('plugin_echo_p')"),
    ).toThrow(PluginStorageError);
  });

  it('purgeAndDelete drops the plugin private tables (prefix normalisation matches)', () => {
    store.upsert(row({ name: 'slack-bridge' }));
    store.defineTable('slack-bridge', 'CREATE TABLE plugin_slack_bridge_state (k TEXT)');
    store.defineTable('slack-bridge', 'CREATE INDEX plugin_slack_bridge_state_i ON plugin_slack_bridge_state(k)');
    expect(schemaNames()).toContain('plugin_slack_bridge_state');
    store.purgeAndDelete('slack-bridge');
    expect(schemaNames()).not.toContain('plugin_slack_bridge_state');
    expect(schemaNames()).not.toContain('plugin_slack_bridge_state_i');
    expect(store.get('slack-bridge')).toBeNull();
  });
});

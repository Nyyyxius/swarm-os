import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../db/index.js';
import { SettingsStore, DEFAULT_INSTANCE_SETTINGS } from './index.js';

let dir: string;
let db: SwarmDb;
let store: SettingsStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-store-'));
  db = new SwarmDb(dir);
  store = new SettingsStore(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SettingsStore — dismissedUpdateVersion', () => {
  it('defaults to null before any write', () => {
    expect(store.get().dismissedUpdateVersion).toBeNull();
    expect(DEFAULT_INSTANCE_SETTINGS.dismissedUpdateVersion).toBeNull();
  });

  it('round-trips through SQLite', () => {
    store.update({ dismissedUpdateVersion: '0.6.0' });
    expect(new SettingsStore(db).get().dismissedUpdateVersion).toBe('0.6.0');
  });

  it('is clearable with an explicit null (un-dismiss)', () => {
    store.update({ dismissedUpdateVersion: '0.6.0' });
    store.update({ dismissedUpdateVersion: null });
    expect(store.get().dismissedUpdateVersion).toBeNull();
  });

  it('survives an appearance-only patch', () => {
    store.update({ dismissedUpdateVersion: '0.6.0' });
    store.update({ accent: '#112233' });
    const s = store.get();
    expect(s.accent).toBe('#112233');
    expect(s.dismissedUpdateVersion).toBe('0.6.0');
  });

  it('survives reset() — resetting the THEME must not resurrect a dismissed badge', () => {
    store.update({ dismissedUpdateVersion: '0.6.0', accent: '#112233' });
    const after = store.reset();
    expect(after.accent).toBe(DEFAULT_INSTANCE_SETTINGS.accent);
    expect(after.dismissedUpdateVersion).toBe('0.6.0');
  });
});

describe('instance_settings migration', () => {
  it('adds dismissed_update_version to a database that predates it', () => {
    // Simulate the only path a deployed instance can take: the table already
    // exists, so `CREATE TABLE IF NOT EXISTS` (schema.sql AND INLINE_SCHEMA)
    // is a no-op and ONLY applyMigrations() can add the column.
    store.update({ accent: '#445566' });
    db.db.exec('ALTER TABLE instance_settings DROP COLUMN dismissed_update_version');
    db.close();

    const reopened = new SwarmDb(dir);
    const cols = reopened.db
      .prepare('PRAGMA table_info(instance_settings)')
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('dismissed_update_version');

    const s = new SettingsStore(reopened);
    expect(s.get().accent).toBe('#445566');
    expect(s.get().dismissedUpdateVersion).toBeNull();
    s.update({ dismissedUpdateVersion: '9.9.9' });
    expect(s.get().dismissedUpdateVersion).toBe('9.9.9');
    reopened.close();

    db = new SwarmDb(dir); // afterEach closes this one
  });
});

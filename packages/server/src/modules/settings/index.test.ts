import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../db/index.js';
import { SettingsStore, DEFAULT_INSTANCE_SETTINGS, PASSWORD_SENTINEL } from './index.js';

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

/**
 * The OpenRouter API key (multi-provider Lot 6b).
 *
 * Two failure modes are worth more than all the others here, and they are
 * silent in opposite directions:
 *
 *  1. **The key leaves the server.** `get()` is what every route serves and
 *     what the web client mirrors into localStorage. If it ever returns the
 *     plaintext, the credential is in every operator's browser storage with no
 *     symptom at all.
 *  2. **The key does not persist.** A column present in the INSERT but absent
 *     from the UPSERT's `ON CONFLICT DO UPDATE SET` list is written once and
 *     never updated again: the operator saves a key, it works, and it is gone
 *     after the next restart with nothing logged. The round-trips below write
 *     TWICE on purpose — only the second write takes the conflict path.
 */
const KEY = 'sk-or-v1-0123456789abcdef';

describe('SettingsStore — openrouterApiKey', () => {
  it('defaults to "no key" before any write', () => {
    expect(store.get().openrouterApiKey).toBeNull();
    expect(store.getOpenRouterApiKey()).toBeNull();
    expect(DEFAULT_INSTANCE_SETTINGS.openrouterApiKey).toBeNull();
  });

  it('MASKS the key on read and only ever hands the plaintext to getOpenRouterApiKey', () => {
    const view = store.update({ openrouterApiKey: KEY });
    // The write's return value is served straight back by PATCH /settings, so it
    // is exactly as exposed as get().
    expect(view.openrouterApiKey).toBe(PASSWORD_SENTINEL);
    expect(store.get().openrouterApiKey).toBe(PASSWORD_SENTINEL);
    expect(JSON.stringify(store.get())).not.toContain(KEY);
    expect(store.getOpenRouterApiKey()).toBe(KEY);
  });

  it('round-trips through SQLite — the UPSERT really updates the column', () => {
    store.update({ openrouterApiKey: KEY });
    // Second write = the ON CONFLICT path. This is the assertion that fails when
    // `openrouter_api_key` is missing from the DO UPDATE SET list.
    store.update({ openrouterApiKey: `${KEY}-rotated` });
    expect(store.getOpenRouterApiKey()).toBe(`${KEY}-rotated`);
    expect(new SettingsStore(db).getOpenRouterApiKey()).toBe(`${KEY}-rotated`);
  });

  it('survives a restart — read back through a fresh handle on the same file', () => {
    store.update({ openrouterApiKey: KEY });
    store.update({ accent: '#112233' }); // second upsert, key untouched
    db.close();
    const reopened = new SwarmDb(dir);
    try {
      expect(new SettingsStore(reopened).getOpenRouterApiKey()).toBe(KEY);
    } finally {
      reopened.close();
    }
    db = new SwarmDb(dir); // afterEach closes this one
  });

  it('keeps the stored key when the sentinel is echoed back', () => {
    store.update({ openrouterApiKey: KEY });
    // What the form sends when the operator opened the drawer, changed nothing
    // in this field, and saved.
    const view = store.update({ openrouterApiKey: PASSWORD_SENTINEL });
    expect(view.openrouterApiKey).toBe(PASSWORD_SENTINEL);
    expect(store.getOpenRouterApiKey()).toBe(KEY);
  });

  it('survives a patch that does not mention it at all', () => {
    store.update({ openrouterApiKey: KEY });
    store.update({ accent: '#445566', fontSize: 14 });
    expect(store.getOpenRouterApiKey()).toBe(KEY);
  });

  it('is deleted by an explicit null, and by an empty string', () => {
    store.update({ openrouterApiKey: KEY });
    expect(store.update({ openrouterApiKey: null }).openrouterApiKey).toBeNull();
    expect(store.getOpenRouterApiKey()).toBeNull();

    store.update({ openrouterApiKey: KEY });
    expect(store.update({ openrouterApiKey: '' }).openrouterApiKey).toBeNull();
    expect(store.getOpenRouterApiKey()).toBeNull();
  });

  it('trims a pasted key — a trailing newline would fail auth with no visible cause', () => {
    store.update({ openrouterApiKey: `  ${KEY}\n` });
    expect(store.getOpenRouterApiKey()).toBe(KEY);
  });

  it('survives reset() — resetting the THEME must not revoke a credential', () => {
    store.update({ openrouterApiKey: KEY, accent: '#112233' });
    const after = store.reset();
    expect(after.accent).toBe(DEFAULT_INSTANCE_SETTINGS.accent);
    expect(after.openrouterApiKey).toBe(PASSWORD_SENTINEL);
    expect(store.getOpenRouterApiKey()).toBe(KEY);
  });
});

describe('instance_settings migration', () => {
  it('adds openrouter_api_key to a database that predates it', () => {
    // Same and only path a deployed instance can take: the table exists, so
    // `CREATE TABLE IF NOT EXISTS` is a no-op and applyMigrations() is the sole
    // source of the column.
    store.update({ accent: '#778899' });
    db.db.exec('ALTER TABLE instance_settings DROP COLUMN openrouter_api_key');
    db.close();

    const reopened = new SwarmDb(dir);
    const cols = reopened.db
      .prepare('PRAGMA table_info(instance_settings)')
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('openrouter_api_key');

    const s = new SettingsStore(reopened);
    expect(s.get().accent).toBe('#778899');
    expect(s.get().openrouterApiKey).toBeNull();
    s.update({ openrouterApiKey: KEY });
    expect(s.getOpenRouterApiKey()).toBe(KEY);
    reopened.close();

    db = new SwarmDb(dir); // afterEach closes this one
  });

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

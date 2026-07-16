/**
 * db-tables façade — `api.storage.defineTable` / `api.storage.prepare`.
 *
 * Exercises the capability gate and the epoch lifecycle at the API layer (the
 * SQL-guard rules themselves are covered directly on `PluginStore` in
 * `store.test.ts`). Builds a minimal `SwarmPluginApi` over a real `SwarmDb`
 * with a MUTABLE epoch so a statement held across `disable()` can be checked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { SwarmDb } from '../db/index.js';
import { PluginStore } from './store.js';
import { buildPluginApi, type PluginGuard } from './api.js';
import {
  DisposableStore,
  PluginCapabilityError,
  PluginDisabledError,
  type SwarmPluginApi,
  type PluginCapability,
} from './api-types.js';
import { eventBus } from '../../events.js';
import { withModule } from '../../logger.js';

let dir: string;
let db: SwarmDb;
let store: PluginStore;

const PLUGIN = 'echo';

/** Identity guard — crash isolation is not under test here. */
const identityGuard: PluginGuard = <A extends unknown[]>(
  _hook: string,
  fn: (...a: A) => unknown,
) => (...a: A): unknown => fn(...a);

function buildApi(
  caps: PluginCapability[],
): { api: SwarmPluginApi; setEpoch: (n: number) => void } {
  let epoch = 0;
  const api = buildPluginApi(
    {
      store,
      eventBus,
      log: withModule('test.storage'),
      zod: z,
      granted: new Set(caps),
      guard: identityGuard,
      currentEpoch: () => epoch,
      onConfigChange: [],
    },
    PLUGIN,
    new DisposableStore(),
    0,
  );
  return { api, setEpoch: (n: number) => { epoch = n; } };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-tables-'));
  db = new SwarmDb(dir);
  store = new PluginStore(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('storage.defineTable / prepare façade', () => {
  it('creates and round-trips a private table end to end', () => {
    const { api } = buildApi(['db-tables']);
    api.storage.defineTable(
      'CREATE TABLE IF NOT EXISTS plugin_echo_items (id INTEGER PRIMARY KEY, label TEXT)',
    );
    api.storage
      .prepare('INSERT INTO plugin_echo_items (label) VALUES (@label)')
      .run({ label: 'first' });
    const row = api.storage
      .prepare<{ id: number }, { label: string }>('SELECT label FROM plugin_echo_items WHERE id = @id')
      .get({ id: 1 });
    expect(row?.label).toBe('first');
  });

  it('requires the db-tables capability', () => {
    const { api } = buildApi([]); // nothing granted
    expect(() => api.storage.defineTable('CREATE TABLE plugin_echo_x (id INTEGER)')).toThrow(
      PluginCapabilityError,
    );
    expect(() => api.storage.prepare('SELECT 1')).toThrow(PluginCapabilityError);
    // db-kv is a DIFFERENT capability — granting it does not unlock tables.
    const { api: kvOnly } = buildApi(['db-kv']);
    expect(() => kvOnly.storage.defineTable('CREATE TABLE plugin_echo_x (id INTEGER)')).toThrow(
      PluginCapabilityError,
    );
  });

  it('rejects reaching another plugin / core table through the façade', () => {
    db.db.exec('CREATE TABLE IF NOT EXISTS somecore (id INTEGER)');
    const { api } = buildApi(['db-tables']);
    expect(() => api.storage.prepare('SELECT * FROM somecore')).toThrow(/somecore/);
    expect(() => api.storage.defineTable('CREATE TABLE not_prefixed (id INTEGER)')).toThrow();
  });

  it('invalidates a held statement after disable (epoch bump → PluginDisabledError)', () => {
    const { api, setEpoch } = buildApi(['db-tables']);
    api.storage.defineTable('CREATE TABLE plugin_echo_e (id INTEGER PRIMARY KEY, v TEXT)');
    const stmt = api.storage.prepare('SELECT v FROM plugin_echo_e');
    // Works while live.
    expect(() => stmt.all()).not.toThrow();
    // Simulate disable(): the host bumps the plugin's epoch.
    setEpoch(1);
    expect(() => stmt.all()).toThrow(PluginDisabledError);
    expect(() => stmt.run()).toThrow(PluginDisabledError);
    expect(() => stmt.get()).toThrow(PluginDisabledError);
    // A brand-new prepare through the stale epoch is refused as well.
    expect(() => api.storage.prepare('SELECT 1')).toThrow(PluginDisabledError);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwarmDb } from '../db/index.js';
import { UpdateStore, UpdateStoreSchemaError, TERMINAL_UPDATE_STATES, type UpdateRunRow } from './store.js';

let dir: string;
let db: SwarmDb;
let store: UpdateStore;

function row(over: Partial<UpdateRunRow> = {}): UpdateRunRow {
  return {
    id: 'run-2026-01-01T00-00-00',
    kind: 'system',
    state: 'scheduled',
    target_version: '0.6.0',
    scheduled_for: '2026-01-01T00:00:00.000Z',
    warned_at: null,
    started_at: null,
    finished_at: null,
    run_dir: '/data/updater/runs/run-1',
    env_file: null,
    env_line_before: null,
    teams_snapshot_json: null,
    teams_warned_json: null,
    teams_reconciled_json: null,
    error: null,
    log_tail: null,
    ...over,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-store-'));
  db = new SwarmDb(dir);
  store = new UpdateStore(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('UpdateStore', () => {
  it('creates update_runs in its own constructor (schema.sql is not shipped)', () => {
    expect(() => store.assertReady()).not.toThrow();
    const t = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='update_runs'")
      .get();
    expect(t).toBeTruthy();
  });

  it('assertReady throws loudly when the table was dropped underneath us', () => {
    db.db.exec('DROP TABLE update_runs');
    expect(() => store.assertReady()).toThrow(UpdateStoreSchemaError);
  });

  it('is idempotent across constructions (a second boot must not fail)', () => {
    store.insert(row());
    const second = new UpdateStore(db);
    expect(second.get('run-2026-01-01T00-00-00')?.state).toBe('scheduled');
  });

  /**
   * `CREATE TABLE IF NOT EXISTS` skips an existing table WHOLESALE, so an
   * already-deployed instance can only ever get a new column through the
   * `ALTER`. This is that instance: the table as an older build left it.
   */
  it('ALTERs a table that predates the reconciliation column, idempotently', () => {
    db.db.exec('DROP TABLE update_runs');
    db.db.exec(`
      CREATE TABLE update_runs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
        target_version TEXT, scheduled_for TEXT, warned_at TEXT, started_at TEXT,
        finished_at TEXT, run_dir TEXT NOT NULL, env_file TEXT, env_line_before TEXT,
        teams_snapshot_json TEXT, teams_warned_json TEXT, error TEXT, log_tail TEXT
      );
    `);
    const upgraded = new UpdateStore(db);
    expect(() => upgraded.assertReady()).not.toThrow();
    upgraded.insert(row({ teams_reconciled_json: '[{"orch_id":"o1","back":true}]' }));
    expect(upgraded.get('run-2026-01-01T00-00-00')?.teams_reconciled_json).toBe(
      '[{"orch_id":"o1","back":true}]',
    );
    // And the boot after that one, on a table that now has it.
    expect(() => new UpdateStore(db).assertReady()).not.toThrow();
  });

  it('assertReady refuses a table whose migration never landed', () => {
    db.db.exec('ALTER TABLE update_runs DROP COLUMN teams_reconciled_json');
    // The store object predates the drop, so this is the schema regression the
    // assertion exists for: loud at boot, not on the first run of the month.
    expect(() => store.assertReady()).toThrow(/teams_reconciled_json/);
  });

  it('round-trips a run, byte-exact rollback line included', () => {
    store.insert(row({ env_file: '/srv/.env', env_line_before: 'SWARM_OS_IMAGE=ghcr.io/x/y:0.5.0' }));
    const got = store.get('run-2026-01-01T00-00-00');
    expect(got?.env_line_before).toBe('SWARM_OS_IMAGE=ghcr.io/x/y:0.5.0');
    expect(got?.target_version).toBe('0.6.0');
  });

  it('THROWS on a write failure instead of swallowing it (rollback data)', () => {
    store.insert(row());
    expect(() => store.insert(row())).toThrow();
  });

  it('patches only allow-listed columns', () => {
    store.insert(row());
    store.patch('run-2026-01-01T00-00-00', { state: 'applying', started_at: '2026-01-01T00:01:00.000Z' });
    const got = store.get('run-2026-01-01T00-00-00');
    expect(got?.state).toBe('applying');
    expect(got?.started_at).toBe('2026-01-01T00:01:00.000Z');
    // An unknown key is dropped, never interpolated into the SQL.
    expect(() =>
      store.patch('run-2026-01-01T00-00-00', {
        ['state = state; DROP TABLE update_runs; --']: 'x',
      } as unknown as Partial<UpdateRunRow>),
    ).not.toThrow();
    expect(() => store.assertReady()).not.toThrow();
  });

  it('listActive returns only non-terminal runs', () => {
    store.insert(row({ id: 'a', state: 'applying', started_at: '2026-01-01T00:00:01.000Z' }));
    store.insert(row({ id: 'b', state: 'success', started_at: '2026-01-01T00:00:02.000Z' }));
    store.insert(row({ id: 'c', state: 'rolled_back', started_at: '2026-01-01T00:00:03.000Z' }));
    expect(store.listActive().map((r) => r.id)).toEqual(['a']);
    expect(TERMINAL_UPDATE_STATES.has('success')).toBe(true);
    expect(TERMINAL_UPDATE_STATES.has('applying')).toBe(false);
  });

  it('lists most recent first', () => {
    store.insert(row({ id: 'a', started_at: '2026-01-01T00:00:01.000Z' }));
    store.insert(row({ id: 'b', started_at: '2026-01-02T00:00:01.000Z' }));
    expect(store.listRecent(10).map((r) => r.id)).toEqual(['b', 'a']);
    expect(store.listRecent(1).map((r) => r.id)).toEqual(['b']);
  });
});

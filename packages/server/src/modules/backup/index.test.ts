import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { SwarmDb } from '../db/index.js';
import { BackupScheduler } from './index.js';

/**
 * BackupScheduler — online snapshot + retention.
 *
 * We drive `runOnce()` directly (the setInterval path is just a timer wrapper)
 * against a real SwarmDb so the better-sqlite3 `.backup()` online API is
 * exercised end to end.
 */

let tmpRoot: string;
let db: SwarmDb;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-backup-'));
  db = new SwarmDb(tmpRoot);
});

afterEach(() => {
  db.close();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const backupsDir = () => path.join(tmpRoot, 'backups');
const snapshots = () =>
  fs
    .readdirSync(backupsDir())
    .filter((f) => f.startsWith('swarm-os-') && f.endsWith('.db'))
    .sort();

describe('BackupScheduler', () => {
  it('writes a restorable snapshot under <dataDir>/backups', async () => {
    const sched = new BackupScheduler({
      db: db.db,
      dataDir: tmpRoot,
      intervalMs: 60_000,
      keep: 5,
      now: () => new Date('2026-06-09T12:00:00.000Z'),
    });

    const res = await sched.runOnce();

    expect(res.file).not.toBeNull();
    const files = snapshots();
    expect(files).toEqual(['swarm-os-2026-06-09T12-00-00-000Z.db']);

    // The snapshot is a valid SQLite DB carrying the same schema (sanity: it
    // opens and exposes the orchestrators table).
    const opened = new Database(res.file!, { readonly: true });
    const row = opened
      .prepare<[], { n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE name='orchestrators'")
      .get();
    expect(row?.n).toBe(1);
    opened.close();
  });

  it('prunes to the newest `keep` snapshots', async () => {
    // Distinct timestamps so the filenames sort chronologically.
    const stamps = [
      '2026-06-09T01:00:00.000Z',
      '2026-06-09T02:00:00.000Z',
      '2026-06-09T03:00:00.000Z',
      '2026-06-09T04:00:00.000Z',
    ];
    for (const s of stamps) {
      const sched = new BackupScheduler({
        db: db.db,
        dataDir: tmpRoot,
        intervalMs: 60_000,
        keep: 2,
        now: () => new Date(s),
      });
      await sched.runOnce();
    }

    const files = snapshots();
    expect(files).toHaveLength(2);
    // Oldest two pruned; newest two kept.
    expect(files).toEqual([
      'swarm-os-2026-06-09T03-00-00-000Z.db',
      'swarm-os-2026-06-09T04-00-00-000Z.db',
    ]);
  });

  it('is disabled when keep is 0 — start() takes no snapshot', async () => {
    const sched = new BackupScheduler({
      db: db.db,
      dataDir: tmpRoot,
      intervalMs: 60_000,
      keep: 0,
    });
    sched.start();
    sched.stop();
    expect(fs.existsSync(backupsDir())).toBe(false);
  });

  it('list() returns existing snapshots newest-first with size + mtime', async () => {
    const stamps = ['2026-06-09T01:00:00.000Z', '2026-06-09T02:00:00.000Z'];
    for (const s of stamps) {
      await new BackupScheduler({
        db: db.db,
        dataDir: tmpRoot,
        intervalMs: 60_000,
        keep: 10,
        now: () => new Date(s),
      }).runOnce();
    }

    const sched = new BackupScheduler({ db: db.db, dataDir: tmpRoot, intervalMs: 60_000, keep: 10 });
    const list = sched.list();

    expect(list.map((e) => e.name)).toEqual([
      'swarm-os-2026-06-09T02-00-00-000Z.db', // newest first
      'swarm-os-2026-06-09T01-00-00-000Z.db',
    ]);
    for (const e of list) {
      expect(e.sizeBytes).toBeGreaterThan(0);
      expect(e.mtimeMs).toBeGreaterThan(0);
    }
  });

  it('list() returns [] when no backups dir exists yet', () => {
    const sched = new BackupScheduler({ db: db.db, dataDir: tmpRoot, intervalMs: 60_000, keep: 10 });
    expect(sched.list()).toEqual([]);
  });
});

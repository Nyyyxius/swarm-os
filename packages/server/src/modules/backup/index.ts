/**
 * Hot SQLite backup scheduler.
 *
 * Why in-process (and not OS cron / a sidecar):
 *  - The container runs a single process (`tini → node`); a second crond would
 *    need a supervisor and breaks the one-process-per-container model.
 *  - We already hold the live better-sqlite3 connection, whose native
 *    `db.backup()` uses SQLite's **online backup API** — consistent under WAL
 *    with concurrent writers, no `-wal`/`-shm` juggling, no `sqlite3` binary.
 *  - `<dataDir>/backups` is on the bind-mounted `/data`, so every snapshot
 *    lands on the host automatically and survives container rebuilds.
 *
 * Trade-off (accepted): when the process is down/wedged no snapshots are taken
 * — but a stopped process isn't mutating the DB either, so the last snapshot
 * stays representative. This covers point-in-time recovery, NOT host-disk loss
 * (for that, push `backups/` off-site — restic/rclone — from the host or here).
 *
 * Each run writes `swarm-os-<ISO>.db` and prunes all but the newest `keep`
 * files. A failed run is logged and swallowed: backups must never take the
 * orchestrator down.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Database as Db } from 'better-sqlite3';
import { withModule } from '../../logger.js';

const log = withModule('backup');

const FILE_PREFIX = 'swarm-os-';
const FILE_SUFFIX = '.db';

export interface BackupSchedulerOptions {
  /** Live better-sqlite3 handle (e.g. `SwarmDb.db`). */
  db: Db;
  /** `<dataDir>` — snapshots go under `<dataDir>/backups`. */
  dataDir: string;
  /** Interval between snapshots, ms. */
  intervalMs: number;
  /** How many of the newest snapshots to retain. Older ones are pruned. */
  keep: number;
  /** Override for tests. */
  now?: () => Date;
}

export class BackupScheduler {
  private readonly _db: Db;
  private readonly _dir: string;
  private readonly _intervalMs: number;
  private readonly _keep: number;
  private readonly _now: () => Date;
  private _timer: ReturnType<typeof setInterval> | null = null;
  /** Guards against overlap if a snapshot ever runs longer than the interval. */
  private _running = false;

  constructor(opts: BackupSchedulerOptions) {
    this._db = opts.db;
    this._dir = path.join(opts.dataDir, 'backups');
    this._intervalMs = opts.intervalMs;
    this._keep = opts.keep;
    this._now = opts.now ?? (() => new Date());
  }

  /**
   * Arm the periodic snapshot. Idempotent. Does NOT run a snapshot immediately
   * — the first one fires after `intervalMs`, so a boot/redeploy loop can't
   * spew a snapshot on every restart.
   */
  start(): void {
    if (this._timer) return;
    if (this._intervalMs <= 0 || this._keep <= 0) {
      log.info({ event: 'backup.disabled', intervalMs: this._intervalMs, keep: this._keep });
      return;
    }
    const timer = setInterval(() => {
      void this.runOnce();
    }, this._intervalMs);
    // Never hold the event loop open during shutdown.
    if (typeof timer.unref === 'function') timer.unref();
    this._timer = timer;
    log.info({ event: 'backup.started', dir: this._dir, intervalMs: this._intervalMs, keep: this._keep });
  }

  /** Disarm the timer. Idempotent. */
  stop(): void {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  /**
   * Take one snapshot + prune. Public so an operator route or a test can force
   * a backup. Never throws — failures are logged at warn and swallowed.
   */
  async runOnce(): Promise<{ file: string | null; pruned: number }> {
    if (this._running) {
      log.warn({ event: 'backup.skipped_overlap' });
      return { file: null, pruned: 0 };
    }
    this._running = true;
    try {
      fs.mkdirSync(this._dir, { recursive: true });
      const stamp = this._now().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(this._dir, `${FILE_PREFIX}${stamp}${FILE_SUFFIX}`);
      await this._db.backup(dest);
      const pruned = this._prune();
      log.info({ event: 'backup.done', file: path.basename(dest), pruned });
      return { file: dest, pruned };
    } catch (err) {
      log.warn({
        event: 'backup.failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return { file: null, pruned: 0 };
    } finally {
      this._running = false;
    }
  }

  /**
   * Snapshot filenames in `_dir`, oldest first. ISO timestamps sort
   * lexicographically == chronologically, so a plain sort suffices. Returns
   * `[]` if the directory doesn't exist yet. Never throws.
   */
  private _snapshotNames(): string[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this._dir);
    } catch {
      return [];
    }
    return entries.filter((f) => f.startsWith(FILE_PREFIX) && f.endsWith(FILE_SUFFIX)).sort();
  }

  /**
   * Existing snapshots, newest first, with size + mtime. Never throws — a
   * file that vanishes between readdir and stat is skipped.
   */
  list(): Array<{ name: string; sizeBytes: number; mtimeMs: number }> {
    const out: Array<{ name: string; sizeBytes: number; mtimeMs: number }> = [];
    for (const name of this._snapshotNames()) {
      try {
        const st = fs.statSync(path.join(this._dir, name));
        out.push({ name, sizeBytes: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* file removed concurrently — skip */
      }
    }
    return out.reverse(); // newest first
  }

  /** Delete all but the newest `_keep` snapshots. Returns the count removed. */
  private _prune(): number {
    const snapshots = this._snapshotNames();
    const stale = snapshots.slice(0, Math.max(0, snapshots.length - this._keep));
    let removed = 0;
    for (const f of stale) {
      try {
        fs.rmSync(path.join(this._dir, f));
        removed += 1;
      } catch (err) {
        log.warn({
          event: 'backup.prune_failed',
          file: f,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return removed;
  }
}

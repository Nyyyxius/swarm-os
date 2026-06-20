/**
 * Operator backup surface — `POST /backup` (force a snapshot now) and
 * `GET /backups` (list existing snapshots).
 *
 * Mounted **after** the X-Auth-Token middleware in `http/main.ts` so anonymous
 * callers get 401 (parity with `/orchestrators`). Both reuse the live
 * {@link BackupScheduler} that already owns the scheduled snapshots, so a
 * manual backup and the 6-hourly one share identical mechanics + retention.
 *
 * `runOnce()` never throws — `ok:false` covers a failed or overlapping
 * snapshot. We return the snapshot **basename** (not the `/data/...` path),
 * matching the `name` field of `list()`.
 */
import { Router, type Request, type Response } from 'express';
import * as path from 'node:path';
import type { BackupScheduler } from '../../modules/backup/index.js';

export function createBackupRouter(backup: BackupScheduler): Router {
  const router = Router();

  router.post('/backup', async (_req: Request, res: Response) => {
    const r = await backup.runOnce();
    res.json({
      ok: r.file !== null,
      file: r.file ? path.basename(r.file) : null,
      pruned: r.pruned,
    });
  });

  router.get('/backups', (_req: Request, res: Response) => {
    res.json({ backups: backup.list() });
  });

  return router;
}

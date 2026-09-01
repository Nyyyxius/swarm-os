/**
 * REST surface for agent crons (docs/crons-agents.md §2.3).
 *
 * Mounted with the AUTHENTICATED routers in `http/main.ts` (behind
 * `X-Auth-Token`, under the bootGate 503), next to `createRolesRouter` — "who
 * may schedule" is "anyone holding the global token", the same level of power
 * the token already grants.
 *
 *   GET    /crons            -> { crons: CronView[], schedulingEnabled }
 *   POST   /crons            -> 201 { cron }
 *   GET    /crons/:id        -> { cron }
 *   PATCH  /crons/:id        -> { cron }            (partial, incl. { paused })
 *   DELETE /crons/:id        -> 204                  (runs cascade via FK)
 *   POST   /crons/:id/fire   -> 202 { runId } | 409  (manual fire)
 *   GET    /crons/:id/runs   -> { runs: CronRun[] }
 *
 * Two design points worth restating here, because they are easy to undo:
 *
 *  - `nextRun` is READ OFF THE ARMED `Cron` (`scheduler.nextRun(id)`), never
 *    recomputed from a bare `new Cron(expr)`: a fresh probe evaluates in the
 *    process's local timezone rather than `SWARM_OS_SCHEDULE_TZ`. A paused cron
 *    — or any cron while cadence is disabled instance-wide — reports `null`,
 *    because the UI must never advertise a fire that will not happen.
 *  - every mutation calls `scheduler.reload()`. There is no cron-change event
 *    bus; the mutating route IS the re-arm trigger (same contract the roles
 *    route used to have for the per-role scheduler).
 *
 * The manual fire answers 202 and never blocks: a script run may last longer
 * than Node's 300 s `requestTimeout`, so the operator gets a `runId` and polls
 * `/crons/:id/runs`. For a script cron the response's `run` is `null` — the
 * child is still executing and its row is journalled, under that same `runId`,
 * when it exits. A run already in flight answers 409 rather than queueing a
 * second one (same guard as the tick path, §2.5).
 *
 * Script crons are validated at creation: `scriptPath` + `interpreter` are
 * required, and the path must realpath under the workspace or data root. That
 * check is a UX affordance, not the security boundary — the runner repeats it
 * at every fire, on the resolved path it then actually executes.
 *
 * The field rules themselves live in `modules/crons/validate.ts`, NOT here: the
 * plugin façade (`api.crons.*`) is a second write surface onto the same table
 * and has to refuse exactly the same inputs. This router owns the HTTP shape
 * (status codes, envelope) and nothing else.
 */

import { Router, type Request, type Response } from 'express';
import { CronStoreError, type CronRecord, type CronStore } from '../../modules/crons/store.js';
import type { CronScheduler } from '../../modules/crons/scheduler.js';
import type { CronScriptRunner } from '../../modules/crons/runner.js';
import {
  validateCronInit,
  validateCronPatch,
  type CronInput,
  type CronParsed,
  type CronValidationDeps,
  type RoleExistsLookup,
} from '../../modules/crons/validate.js';
import { withModule } from '../../logger.js';

export type { RoleExistsLookup } from '../../modules/crons/validate.js';

const log = withModule('crons.route');

export function createCronsRouter(
  store: CronStore,
  scheduler: CronScheduler,
  roles?: RoleExistsLookup,
  runner?: CronScriptRunner,
): Router {
  const router = Router();

  // Role existence + script containment, wired once for both write routes. A
  // server booted without a script runner simply refuses `action: 'script'`.
  const validation: CronValidationDeps = {
    ...(roles ? { roles } : {}),
    ...(runner ? { resolveScriptPath: (p: string) => runner.resolveScriptPath(p) } : {}),
  };

  /**
   * 400 for a refused write. The `code` is emitted only when it says something
   * the message does not (`UNKNOWN_ROLE`, `INVALID_SCRIPT`) — a plain field
   * error keeps the bare `{ error }` envelope the UI already parses.
   */
  function rejected(res: Response, r: Extract<CronParsed<unknown>, { ok: false }>): Response {
    return res
      .status(400)
      .json(r.code === 'INVALID' ? { error: r.error } : { error: r.error, code: r.code });
  }

  /** Serialise a cron for a response: the record + its live scheduling state. */
  function view(cron: CronRecord): Record<string, unknown> {
    return {
      ...cron,
      nextRun: scheduler.nextRun(cron.id)?.toISOString() ?? null,
      lastRun: store.lastRun(cron.id),
      running: scheduler.isRunning(cron.id),
    };
  }

  /** Map a store failure to its HTTP shape. Unknown failures stay 500. */
  function failed(res: Response, err: unknown): void {
    if (err instanceof CronStoreError) {
      if (err.code === 'INVALID') {
        res.status(400).json({ error: err.message, code: 'INVALID' });
        return;
      }
      if (err.code === 'NAME_TAKEN') {
        res.status(409).json({ error: err.message, code: 'NAME_TAKEN' });
        return;
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ event: 'crons.route_failed', error: message });
    res.status(500).json({ error: message, code: 'STORE_FAILED' });
  }

  router.get('/crons', (_req: Request, res: Response) => {
    res.json({
      crons: store.list().map(view),
      // Global switch (`SWARM_OS_SCHEDULE_ENABLED`). When false nothing is
      // armed, every `nextRun` is null, and the UI says so in a banner rather
      // than letting the operator believe their cadences are running.
      schedulingEnabled: scheduler.enabled,
    });
  });

  // async: a script cron's path is realpath-checked before it is stored.
  router.post('/crons', async (req: Request, res: Response) => {
    const parsed = await validateCronInit((req.body ?? {}) as CronInput, validation);
    if (!parsed.ok) return rejected(res, parsed);
    try {
      const cron = store.create(parsed.value);
      scheduler.reload();
      log.info({ event: 'crons.created', cronId: cron.id, name: cron.name, roleId: cron.roleId });
      return res.status(201).json({ cron: view(cron) });
    } catch (err) {
      return failed(res, err);
    }
  });

  router.get('/crons/:id', (req: Request<{ id: string }>, res: Response) => {
    const cron = store.get(req.params.id);
    if (!cron) {
      res.status(404).json({ error: 'not found', code: 'NOT_FOUND' });
      return;
    }
    res.json({ cron: view(cron) });
  });

  router.patch('/crons/:id', async (req: Request<{ id: string }>, res: Response) => {
    const existing = store.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not found', code: 'NOT_FOUND' });
    const parsed = await validateCronPatch(existing, (req.body ?? {}) as CronInput, validation);
    if (!parsed.ok) return rejected(res, parsed);
    try {
      const updated = store.update(req.params.id, parsed.value);
      if (!updated) return res.status(404).json({ error: 'not found', code: 'NOT_FOUND' });
      scheduler.reload();
      log.info({ event: 'crons.updated', cronId: updated.id, paused: updated.paused });
      return res.json({ cron: view(updated) });
    } catch (err) {
      return failed(res, err);
    }
  });

  router.delete('/crons/:id', (req: Request<{ id: string }>, res: Response) => {
    try {
      store.delete(req.params.id);
      scheduler.reload();
      log.info({ event: 'crons.deleted', cronId: req.params.id });
      res.status(204).end();
    } catch (err) {
      failed(res, err);
    }
  });

  /**
   * Manual fire. 202 + `{ runId }`, never synchronous — see the module header.
   * Allowed on a paused cron and while cadence is disabled: it is an explicit
   * operator gesture, not a cadence.
   */
  router.post('/crons/:id/fire', (req: Request<{ id: string }>, res: Response) => {
    const cron = store.get(req.params.id);
    if (!cron) return res.status(404).json({ error: 'not found', code: 'NOT_FOUND' });
    if (scheduler.isRunning(cron.id)) {
      return res.status(409).json({
        error: 'a run of this cron is already in flight',
        code: 'RUN_IN_FLIGHT',
      });
    }
    const fired = scheduler.fire(cron.id, 'manual');
    if (!fired) {
      return res
        .status(500)
        .json({ error: 'the run could not be recorded', code: 'STORE_FAILED' });
    }
    log.info({
      event: 'crons.fired_manually',
      cronId: cron.id,
      runId: fired.runId,
      // `null` for a script cron: the child is still running and the history
      // row lands when it exits, under this same runId.
      outcome: fired.run?.outcome ?? null,
    });
    return res.status(202).json({ runId: fired.runId, run: fired.run });
  });

  router.get('/crons/:id/runs', (req: Request<{ id: string }>, res: Response) => {
    const cron = store.get(req.params.id);
    if (!cron) {
      res.status(404).json({ error: 'not found', code: 'NOT_FOUND' });
      return;
    }
    res.json({ runs: store.listRuns(cron.id) });
  });

  return router;
}

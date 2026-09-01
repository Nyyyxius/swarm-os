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
 */

import { Router, type Request, type Response } from 'express';
import {
  CRON_INTERPRETERS,
  CronStoreError,
  DEFAULT_CRON_TIMEOUT_MS,
  MAX_CRON_TIMEOUT_MS,
  CRON_NAME_RE,
  type CronAction,
  type CronInit,
  type CronPatch,
  type CronRecord,
  type CronStore,
} from '../../modules/crons/store.js';
import { isValidCron, type CronScheduler } from '../../modules/crons/scheduler.js';
import type { CronScriptRunner } from '../../modules/crons/runner.js';
import { withModule } from '../../logger.js';

const log = withModule('crons.route');

/**
 * The slice of the role store this router needs: "does this role exist". A cron
 * pointing at a role id that never existed is a typo worth reporting at the
 * form; a role deleted LATER leaves an orphan cron on purpose (§6.2 — operator
 * config is not cascade-deleted).
 */
export interface RoleExistsLookup {
  get(id: string): unknown | null;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseName(x: unknown): Parsed<string> {
  if (typeof x !== 'string') return { ok: false, error: 'name must be a string' };
  const trimmed = x.trim();
  if (!CRON_NAME_RE.test(trimmed)) {
    return {
      ok: false,
      error:
        'name must be a slug of 1-64 chars: letters, digits, dot, dash, underscore (it is also the `cron:<name>` sender of the messages)',
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * A cron expression, restricted to FIVE fields (§2.2). croner itself accepts a
 * 6-field, to-the-second form — refused here: a per-second script cron is a
 * fork bomb bounded only by the overlap guard, and no operator asks for one on
 * purpose from this form.
 */
function parseSchedule(x: unknown): Parsed<string> {
  if (typeof x !== 'string') return { ok: false, error: 'schedule must be a string' };
  const trimmed = x.trim();
  if (trimmed === '') return { ok: false, error: 'schedule is required' };
  if (trimmed.split(/\s+/).length !== 5) {
    return {
      ok: false,
      error: 'schedule must have exactly 5 fields (minute hour day month weekday) — per-second expressions are refused',
    };
  }
  if (!isValidCron(trimmed)) {
    return { ok: false, error: 'schedule must be a valid cron expression (e.g. "0 6,12,20 * * *")' };
  }
  return { ok: true, value: trimmed };
}

function parseAction(x: unknown): Parsed<CronAction> {
  if (x === 'message' || x === 'script') return { ok: true, value: x };
  return { ok: false, error: "action must be 'message' or 'script'" };
}

function parseNullableString(x: unknown, field: string): Parsed<string | null> {
  if (x == null) return { ok: true, value: null };
  if (typeof x !== 'string') return { ok: false, error: `${field} must be a string or null` };
  return { ok: true, value: x.length === 0 ? null : x };
}

function parseScriptArgs(x: unknown): Parsed<string[] | null> {
  if (x == null) return { ok: true, value: null };
  if (!Array.isArray(x) || x.some((v) => typeof v !== 'string')) {
    return { ok: false, error: 'scriptArgs must be an array of strings or null' };
  }
  return { ok: true, value: x as string[] };
}

function parseInterpreter(x: unknown): Parsed<string | null> {
  if (x == null) return { ok: true, value: null };
  if (typeof x !== 'string' || !CRON_INTERPRETERS.includes(x)) {
    return { ok: false, error: `interpreter must be one of ${CRON_INTERPRETERS.join('|')}` };
  }
  return { ok: true, value: x };
}

function parseTimeoutMs(x: unknown): Parsed<number | null> {
  if (x == null) return { ok: true, value: null };
  if (typeof x !== 'number' || !Number.isInteger(x) || x < 1000 || x > MAX_CRON_TIMEOUT_MS) {
    return {
      ok: false,
      error: `timeoutMs must be an integer between 1000 and ${MAX_CRON_TIMEOUT_MS}, or null`,
    };
  }
  return { ok: true, value: x };
}

interface CronBody {
  name?: unknown;
  roleId?: unknown;
  schedule?: unknown;
  action?: unknown;
  message?: unknown;
  scriptPath?: unknown;
  scriptArgs?: unknown;
  interpreter?: unknown;
  timeoutMs?: unknown;
  paused?: unknown;
}

export function createCronsRouter(
  store: CronStore,
  scheduler: CronScheduler,
  roles?: RoleExistsLookup,
  runner?: CronScriptRunner,
): Router {
  const router = Router();

  /**
   * Containment check for a script cron, at CREATION time. The runner re-runs
   * exactly this at every fire (the path may have been swapped since), so this
   * call buys no security — it buys an operator a refusal in the form instead
   * of a silent `error` run three hours later.
   *
   * Returns an error string, or `null` when the path is acceptable.
   */
  async function checkScript(
    scriptPath: string | null,
    interpreter: string | null,
  ): Promise<string | null> {
    if (!scriptPath) return "scriptPath is required when action is 'script'";
    if (!interpreter) return "interpreter is required when action is 'script'";
    if (!runner) return 'script crons are unavailable on this server (no script runner configured)';
    try {
      await runner.resolveScriptPath(scriptPath);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
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

  function checkRole(roleId: string): boolean {
    return !roles || roles.get(roleId) != null;
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
    const body = (req.body ?? {}) as CronBody;

    const name = parseName(body.name);
    if (!name.ok) return res.status(400).json({ error: name.error });
    if (typeof body.roleId !== 'string' || body.roleId.length === 0) {
      return res.status(400).json({ error: 'roleId is required and must be a non-empty string' });
    }
    if (!checkRole(body.roleId)) {
      return res.status(400).json({ error: `unknown role '${body.roleId}'`, code: 'UNKNOWN_ROLE' });
    }
    const schedule = parseSchedule(body.schedule);
    if (!schedule.ok) return res.status(400).json({ error: schedule.error });
    const action = parseAction(body.action);
    if (!action.ok) return res.status(400).json({ error: action.error });
    const message = parseNullableString(body.message, 'message');
    if (!message.ok) return res.status(400).json({ error: message.error });
    const scriptPath = parseNullableString(body.scriptPath, 'scriptPath');
    if (!scriptPath.ok) return res.status(400).json({ error: scriptPath.error });
    const scriptArgs = parseScriptArgs(body.scriptArgs);
    if (!scriptArgs.ok) return res.status(400).json({ error: scriptArgs.error });
    const interpreter = parseInterpreter(body.interpreter);
    if (!interpreter.ok) return res.status(400).json({ error: interpreter.error });
    const timeoutMs = parseTimeoutMs(body.timeoutMs);
    if (!timeoutMs.ok) return res.status(400).json({ error: timeoutMs.error });
    if (body.paused !== undefined && typeof body.paused !== 'boolean') {
      return res.status(400).json({ error: 'paused must be a boolean' });
    }
    // §2.2 invariants, checked here so the operator gets a field-level message
    // (the store re-checks them — the plugin façade and the migration write
    // there too).
    if (action.value === 'message' && message.value == null) {
      return res.status(400).json({ error: "message is required when action is 'message'" });
    }
    if (action.value === 'script') {
      const reason = await checkScript(scriptPath.value, interpreter.value);
      if (reason) return res.status(400).json({ error: reason, code: 'INVALID_SCRIPT' });
    }

    const init: CronInit = {
      name: name.value,
      roleId: body.roleId,
      schedule: schedule.value,
      action: action.value,
      message: message.value,
      scriptPath: scriptPath.value,
      scriptArgs: scriptArgs.value,
      interpreter: interpreter.value,
      // A script cron stores its budget explicitly rather than leaning on the
      // store's `null`-means-default: the number an operator is going to be
      // judged by (and will want to raise) should be visible in the UI, not
      // implied. Message crons keep `null` — they have no timeout.
      timeoutMs:
        action.value === 'script' ? (timeoutMs.value ?? DEFAULT_CRON_TIMEOUT_MS) : timeoutMs.value,
      paused: body.paused === true,
    };
    try {
      const cron = store.create(init);
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
    const body = (req.body ?? {}) as CronBody;
    const patch: CronPatch = {};

    if (body.name !== undefined) {
      const r = parseName(body.name);
      if (!r.ok) return res.status(400).json({ error: r.error });
      patch.name = r.value;
    }
    if (body.roleId !== undefined) {
      if (typeof body.roleId !== 'string' || body.roleId.length === 0) {
        return res.status(400).json({ error: 'roleId must be a non-empty string' });
      }
      if (!checkRole(body.roleId)) {
        return res.status(400).json({ error: `unknown role '${body.roleId}'`, code: 'UNKNOWN_ROLE' });
      }
      patch.roleId = body.roleId;
    }
    if (body.schedule !== undefined) {
      const r = parseSchedule(body.schedule);
      if (!r.ok) return res.status(400).json({ error: r.error });
      patch.schedule = r.value;
    }
    if (body.action !== undefined) {
      const r = parseAction(body.action);
      if (!r.ok) return res.status(400).json({ error: r.error });
      patch.action = r.value;
    }
    if (body.message !== undefined) {
      const r = parseNullableString(body.message, 'message');
      if (!r.ok) return res.status(400).json({ error: r.error });
      patch.message = r.value;
    }
    if (body.scriptPath !== undefined) {
      const r = parseNullableString(body.scriptPath, 'scriptPath');
      if (!r.ok) return res.status(400).json({ error: r.error });
      patch.scriptPath = r.value;
    }
    if (body.scriptArgs !== undefined) {
      const r = parseScriptArgs(body.scriptArgs);
      if (!r.ok) return res.status(400).json({ error: r.error });
      patch.scriptArgs = r.value;
    }
    if (body.interpreter !== undefined) {
      const r = parseInterpreter(body.interpreter);
      if (!r.ok) return res.status(400).json({ error: r.error });
      patch.interpreter = r.value;
    }
    if (body.timeoutMs !== undefined) {
      const r = parseTimeoutMs(body.timeoutMs);
      if (!r.ok) return res.status(400).json({ error: r.error });
      patch.timeoutMs = r.value;
    }
    if (body.paused !== undefined) {
      if (typeof body.paused !== 'boolean') {
        return res.status(400).json({ error: 'paused must be a boolean' });
      }
      patch.paused = body.paused;
    }

    // Invariants are enforced against the MERGED cron: a patch can clear the
    // message while the action stays `message`, which would leave a cadence
    // with nothing to deliver.
    const effAction = patch.action ?? existing.action;
    const effMessage = patch.message !== undefined ? patch.message : existing.message;
    if (effAction === 'message' && effMessage == null) {
      return res.status(400).json({ error: "message is required when action is 'message'" });
    }
    if (effAction === 'script') {
      const effScriptPath = patch.scriptPath !== undefined ? patch.scriptPath : existing.scriptPath;
      const effInterpreter =
        patch.interpreter !== undefined ? patch.interpreter : existing.interpreter;
      const reason = await checkScript(effScriptPath, effInterpreter);
      if (reason) return res.status(400).json({ error: reason, code: 'INVALID_SCRIPT' });
      // Same reasoning as POST: materialise the budget so it is visible. Only
      // when the merged cron has none — never overwriting an explicit value.
      const effTimeout = patch.timeoutMs !== undefined ? patch.timeoutMs : existing.timeoutMs;
      if (effTimeout == null) patch.timeoutMs = DEFAULT_CRON_TIMEOUT_MS;
    }

    try {
      const updated = store.update(req.params.id, patch);
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

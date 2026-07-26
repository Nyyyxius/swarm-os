/**
 * Operator update surface.
 *
 *   GET    /updates            everything the drawer needs (system, plugins,
 *                              eligibility, current run, recent runs)
 *   POST   /updates/apply      start now → 202 + runId
 *   POST   /updates/apply-now  cut the warning window short (never below 120 s)
 *   POST   /updates/schedule   one-shot at an ISO datetime → 202 + runId
 *   DELETE /updates/schedule   cancel a pending schedule
 *   POST   /updates/cancel     cancel during the warning window
 *   POST   /updates/dismiss    stop nagging about one version
 *   GET    /updates/:id        run detail + log tail
 *
 * Mounted **after** the X-Auth-Token middleware in `http/main.ts` so anonymous
 * callers get 401 (parity with `/backup`). That split is the point: `/info` is
 * public and carries only `{ available, latest }`, while release notes, plugin
 * origins, the self-update eligibility reason — which name the deployment's
 * transport and image — and every write route live here, behind auth.
 *
 * Shape follows `routes/backup.ts`: a factory taking the live service, thin
 * handlers, no business logic. Three rules the handlers DO enforce, because they
 * are about this surface rather than about updating:
 *
 *  - **409 when a run is already in flight.** Applying twice would mean two
 *    `docker compose up` on the same project, and the second would fight the
 *    first's verification window.
 *  - **503 when no runner is attached.** An instance wired without the apply
 *    machine can still detect and dismiss; answering 202 and doing nothing
 *    would be worse than saying so.
 *  - **the 120 s floor on `/updates/apply-now`.** `resolveGraceSeconds` floors
 *    every window at {@link MIN_GRACE_SECONDS}; the runner's `applyNow()` is a
 *    truncation primitive that does not re-check it, so the check belongs to
 *    whoever exposes it. See the handler for why refusing beats silently
 *    waiting.
 */
import { Router, type Request, type Response } from 'express';
import type { UpdateService } from '../../modules/updates/index.js';
import {
  MIN_GRACE_SECONDS,
  UpdateBusyError,
  UpdateInvalidInputError,
  type ApplyInput,
  type UpdateRunner,
  type UpdateRunView,
} from '../../modules/updates/runner.js';

/** Guard against a pathological body being persisted as a settings value. */
const VERSION_MAX_LEN = 64;
/** A grace window longer than this is a schedule, not a warning. */
const GRACE_MAX_SECONDS = 24 * 60 * 60;

interface DismissBody {
  version?: unknown;
}

interface ApplyBody {
  kind?: unknown;
  targetVersion?: unknown;
  graceSeconds?: unknown;
}

interface ScheduleBody extends ApplyBody {
  at?: unknown;
}

/** `cancel` and `apply-now` take the same body: which run, or the one in flight. */
interface RunIdBody {
  runId?: unknown;
}

/**
 * Seconds of the **hard floor** still to run, counted from the instant the
 * window opened (`warnedAt`, stamped by `warnTeams` in the same tick as the
 * deadline). `0` once the floor has elapsed; `null` when it cannot be
 * established at all — which the caller treats as "not elapsed", because a
 * floor that cannot be proved past has not been proved past.
 *
 * NOT read from `graceRemainingSeconds`: that counts down to the operator's
 * window, which may be 300 s or 24 h, and says nothing about the first 120.
 */
function floorRemainingSeconds(run: UpdateRunView, nowMs: number): number | null {
  const openedMs = run.warnedAt === null ? NaN : Date.parse(run.warnedAt);
  if (!Number.isFinite(openedMs)) return null;
  return Math.max(0, Math.ceil((openedMs + MIN_GRACE_SECONDS * 1000 - nowMs) / 1000));
}

/** Parsed `{kind, targetVersion, graceSeconds}` or an operator-facing message. */
function parseApplyBody(body: ApplyBody): ApplyInput | string {
  const kind = body.kind === undefined ? 'system' : body.kind;
  if (kind !== 'system') {
    // `plugins` is deliberately NOT routed here: plugin upgrades are hot, need
    // no restart and no grace window, and already have their own endpoint
    // (`POST /plugins/:name/upgrade`). Mixing them into the system cycle would
    // put a 5-minute countdown in front of a 5-second operation.
    return 'kind must be "system" — plugin upgrades go through POST /plugins/:name/upgrade';
  }
  if (typeof body.targetVersion !== 'string' || body.targetVersion.trim().length === 0) {
    return 'targetVersion must be a non-empty string (e.g. "0.6.0")';
  }
  const targetVersion = body.targetVersion.trim();
  if (targetVersion.length > VERSION_MAX_LEN) {
    return `targetVersion must be ≤ ${VERSION_MAX_LEN} chars`;
  }
  let graceSeconds: number | undefined;
  if (body.graceSeconds !== undefined) {
    if (typeof body.graceSeconds !== 'number' || !Number.isFinite(body.graceSeconds) || body.graceSeconds < 0) {
      return 'graceSeconds must be a non-negative number of seconds';
    }
    if (body.graceSeconds > GRACE_MAX_SECONDS) {
      return `graceSeconds must be ≤ ${GRACE_MAX_SECONDS}`;
    }
    graceSeconds = Math.floor(body.graceSeconds);
  }
  return { kind: 'system', targetVersion, graceSeconds };
}

/** Map the runner's typed errors onto statuses. Anything else is a 500. */
function sendRunnerError(res: Response, err: unknown): void {
  if (err instanceof UpdateBusyError) {
    res.status(409).json({ error: err.message, runId: err.runId });
    return;
  }
  if (err instanceof UpdateInvalidInputError) {
    res.status(400).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: String(err) });
}

export function createUpdatesRouter(updates: UpdateService): Router {
  const router = Router();

  /** The runner is late-bound (`updates.setRunner`), so resolve it per request. */
  const requireRunner = (res: Response): UpdateRunner | null => {
    const runner = updates.runner;
    if (!runner) {
      res.status(503).json({
        error:
          'This instance has update detection but no apply machine attached, so it cannot install anything itself. Update from the host shell.',
      });
      return null;
    }
    return runner;
  };

  router.get('/updates', (_req: Request, res: Response) => {
    res.json(updates.getFullState());
  });

  router.post('/updates/dismiss', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as DismissBody;
    // `null` is the documented un-dismiss. `undefined` is a malformed call —
    // treating it as "clear" would silently un-hide a badge on a typo.
    if (body.version === null) {
      res.json({ system: updates.dismiss(null) });
      return;
    }
    if (typeof body.version !== 'string' || body.version.trim().length === 0) {
      res.status(400).json({ error: 'version must be a non-empty string, or null to un-dismiss' });
      return;
    }
    const version = body.version.trim();
    if (version.length > VERSION_MAX_LEN) {
      res.status(400).json({ error: `version must be ≤ ${VERSION_MAX_LEN} chars` });
      return;
    }
    res.json({ system: updates.dismiss(version) });
  });

  router.post('/updates/apply', async (req: Request, res: Response) => {
    const runner = requireRunner(res);
    if (!runner) return;
    const parsed = parseApplyBody((req.body ?? {}) as ApplyBody);
    if (typeof parsed === 'string') {
      res.status(400).json({ error: parsed });
      return;
    }
    try {
      const { runId } = await runner.apply(parsed);
      // 202, not 200: the run outlives this request — and, by design, outlives
      // this process. The client follows it through `GET /updates/:id`.
      res.status(202).json({ runId, run: runner.getRun(runId) });
    } catch (err) {
      sendRunnerError(res, err);
    }
  });

  /**
   * Cut the warning window short — the operator has decided the leads have had
   * long enough. `runner.applyNow()` is the truncation itself; everything here
   * is the two questions it does not ask.
   *
   * **The floor is not negotiable.** `resolveGraceSeconds` floors every window
   * at 120 s because below that a lead mid-turn cannot realistically reach an
   * idle boundary, read the notice and wrap up — the warning would be an
   * announcement. `applyNow()` is called by the runner's own paths and takes
   * that as given, so the check lives at the surface that offers the shortcut.
   * Inside the floor we answer 409 and NAME the remaining seconds rather than
   * queue the apply for later: the operator asked for "now", and an endpoint
   * that answers 202 and applies in 90 s has answered a different question.
   * "Ask again in 90 s" is a fact they can act on; a silent delay is not.
   */
  router.post('/updates/apply-now', (req: Request, res: Response) => {
    const runner = requireRunner(res);
    if (!runner) return;
    const body = (req.body ?? {}) as RunIdBody;
    const runId = typeof body.runId === 'string' && body.runId.length > 0 ? body.runId : undefined;
    const run: UpdateRunView | null = runId ? runner.getRun(runId) : runner.currentRun();
    if (!run) {
      // A named run that does not exist is a 404, as on `GET /updates/:id`; an
      // unnamed one means nothing is in flight, which is a 409 like `cancel`.
      if (runId) {
        res.status(404).json({ error: 'no such update run' });
        return;
      }
      res.status(409).json({
        error: 'Nothing to apply: no update run is in flight. Start one with POST /updates/apply.',
      });
      return;
    }
    if (run.state !== 'warning_teams') {
      res.status(409).json({
        error:
          `This run is "${run.state}", not in its warning window — there is nothing left to shorten. ` +
          'A scheduled run has to be cancelled and re-applied; past the window the host updater owns the outcome.',
        runId: run.id,
        state: run.state,
      });
      return;
    }
    const floorLeft = floorRemainingSeconds(run, Date.now());
    if (floorLeft === null) {
      res.status(409).json({
        error:
          'This run has no recorded start for its warning window, so the ' +
          `${MIN_GRACE_SECONDS} s floor cannot be shown to have elapsed. The update applies at its deadline.`,
        runId: run.id,
      });
      return;
    }
    if (floorLeft > 0) {
      res.status(409).json({
        error:
          `The warning window has a hard floor of ${MIN_GRACE_SECONDS} s and ${floorLeft} s of it are left. ` +
          'Applying now would give a lead mid-turn no chance to reach an idle boundary and read the notice. ' +
          `Ask again in ${floorLeft} s.`,
        runId: run.id,
        remainingSeconds: floorLeft,
      });
      return;
    }
    // Past the floor, and the window is the operator's to end.
    if (!runner.applyNow(run.id)) {
      // Raced: the deadline fired, or the run was cancelled, between the read
      // above and here. Either way there is no window left to truncate.
      res.status(409).json({
        error: 'The warning window has already ended; the run is proceeding on its own.',
        runId: run.id,
      });
      return;
    }
    res.json({ applied: true, run: runner.getRun(run.id) });
  });

  router.post('/updates/schedule', (req: Request, res: Response) => {
    const runner = requireRunner(res);
    if (!runner) return;
    const body = (req.body ?? {}) as ScheduleBody;
    if (typeof body.at !== 'string' || body.at.trim().length === 0) {
      res.status(400).json({ error: 'at must be an ISO 8601 datetime string' });
      return;
    }
    const parsed = parseApplyBody(body);
    if (typeof parsed === 'string') {
      res.status(400).json({ error: parsed });
      return;
    }
    try {
      const r = runner.schedule({ ...parsed, at: body.at.trim() });
      res.status(202).json({ ...r, run: runner.getRun(r.runId) });
    } catch (err) {
      sendRunnerError(res, err);
    }
  });

  router.delete('/updates/schedule', (_req: Request, res: Response) => {
    const runner = requireRunner(res);
    if (!runner) return;
    const cancelled = runner.cancelSchedule();
    if (!cancelled) {
      res.status(404).json({ error: 'no update is currently scheduled' });
      return;
    }
    res.json({ cancelled: true });
  });

  router.post('/updates/cancel', (req: Request, res: Response) => {
    const runner = requireRunner(res);
    if (!runner) return;
    const body = (req.body ?? {}) as RunIdBody;
    const runId = typeof body.runId === 'string' && body.runId.length > 0 ? body.runId : undefined;
    const cancelled = runner.cancel(runId);
    if (!cancelled) {
      // Past the warning window the host script owns the outcome, and there is
      // nothing safe to interrupt: aborting mid-`up` is the worst of both.
      res.status(409).json({
        error:
          'Nothing to cancel: no run is in its warning window. Once the host updater has started, the run has to reach its own verdict.',
      });
      return;
    }
    res.json({ cancelled: true, run: runId ? runner.getRun(runId) : runner.currentRun() });
  });

  // LAST: a bare `:id` param would otherwise shadow `/updates/apply` & friends.
  router.get('/updates/:id', (req: Request, res: Response) => {
    const runner = requireRunner(res);
    if (!runner) return;
    const raw = req.params.id;
    const run = runner.getRun(typeof raw === 'string' ? raw : '');
    if (!run) {
      res.status(404).json({ error: 'no such update run' });
      return;
    }
    res.json({ run });
  });

  return router;
}

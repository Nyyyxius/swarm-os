/**
 * CronScheduler — the ONE in-process cadence engine (docs/crons-agents.md §2.1).
 *
 * Generalisation, not duplication: this is the former `RoleScheduler` with the
 * cron set read from the `crons` table instead of the `roles.schedule` column.
 * There is exactly one scheduling system left in the server after Lot 1.
 *
 * Why in-process (and not an OS cron / sidecar container): same rationale as the
 * backup scheduler — the container runs a single `tini → node` process and we
 * already hold the live spawner in memory. A tick therefore delivers straight
 * into a lead's mailbox via the existing messaging primitive (no HTTP self-call,
 * no token, no second container), and it works identically under the `local` and
 * `ssh` transports.
 *
 * Model: a cron targets a ROLE. At each tick we resolve that role's *live*
 * orchestrators (by `roleId`) and deliver to each one's lead inbox — a targeted
 * send, never a broadcast to every lead. 1 instance → 1 lead; N instances → N
 * leads (the fan-out is intentional; downstream idempotency, e.g.
 * `UNIQUE(cycle_window_id)` keyed on `{{fire}}`, absorbs the duplicates).
 *
 * The armed set is rebuilt wholesale by `reload()` at boot and after every cron
 * mutation (the crons route invokes it) — there is no cron-change event bus, so
 * the mutating route is the re-arm trigger.
 *
 * Two things this adds over the role scheduler it replaces:
 *   - every fire, including the ones that deliver nothing, is journalled in
 *     `cron_runs` (that is what makes a cron debuggable from the UI);
 *   - an OVERLAP GUARD lives on the SCHEDULER, not inside a run: a `Set<cronId>`
 *     that `reload()` never touches, so a PATCH landing during a long run cannot
 *     re-arm a second concurrent run of the same cron (§2.5).
 *
 * Trade-off (accepted, unchanged): ticks only fire while the process is up — but
 * a stopped process delivers nothing useful anyway, and `reload()` at boot
 * re-arms from the DB so the next wall-clock window fires normally.
 */
import { Cron } from 'croner';
import { withModule } from '../../logger.js';
import type { Spawner } from '../spawner/index.js';
import { sendMessage, type MessagingDefaults } from '../orchestrator/messaging.js';
import { renderTemplate } from './template.js';
import type { CronScriptRunner } from './runner.js';
import {
  newCronRunId,
  type CronRecord,
  type CronRun,
  type CronRunKind,
  type CronRunOutcome,
  type CronStore,
} from './store.js';

const log = withModule('crons.scheduler');

/**
 * Validate a cron expression with the same parser that will arm it. Exported
 * because the route validates before writing, so the UI can never store a
 * pattern `reload()` would later reject.
 *
 * NOTE: croner also accepts 6-field (to-the-second) expressions. The route
 * additionally restricts the accepted form to 5 fields (§2.2) — a per-second
 * script cron is a fork bomb bounded only by the overlap guard.
 */
export function isValidCron(expr: string): boolean {
  try {
    const probe = new Cron(expr, { paused: true });
    probe.stop();
    return true;
  } catch {
    return false;
  }
}

export interface CronSchedulerOptions {
  store: CronStore;
  spawner: Spawner;
  /** Mailbox size cap + idle threshold, reused for the lead delivery. */
  defaults: MessagingDefaults;
  /** IANA timezone for cron evaluation. Default 'UTC' (set by config). */
  timezone: string;
  /** Master switch — `SWARM_OS_SCHEDULE_ENABLED`. */
  enabled: boolean;
  /**
   * Executor for `action='script'` crons (Lot 2). Optional: without one, a
   * script cron journals an `error` rather than crashing — the same degraded
   * mode the store gets when its tables cannot be opened.
   */
  runner?: CronScriptRunner;
  /** Clock override for tests (fire-time stamping). */
  now?: () => Date;
}

/**
 * Bookkeeping for a script run that is still in flight. Held by the scheduler
 * (not the runner) because it is what shutdown needs in order to write the
 * `error` row: the runner knows about processes, the scheduler knows about runs.
 *
 * `settled` is the anti-double-write latch. `stop()` journals the run
 * synchronously and flips it; the async continuation, which resolves a moment
 * later when the killed child's pipes close, sees the flag and writes nothing —
 * by then `db.close()` may well have happened.
 */
interface ScriptRunState {
  runId: string;
  kind: CronRunKind;
  firedAt: Date;
  startedAt: number;
  settled: boolean;
}

/**
 * What a fire returns. `run` is the journalled row when the fire settled
 * synchronously (message delivery, overlap); it is `null` for a script run,
 * which is still executing — the operator polls `/crons/:id/runs` with `runId`,
 * and `GET /crons` reports `running: true` meanwhile.
 */
export interface CronFireResult {
  runId: string;
  run: CronRun | null;
}

export class CronScheduler {
  private readonly _store: CronStore;
  private readonly _spawner: Spawner;
  private readonly _defaults: MessagingDefaults;
  private readonly _timezone: string;
  private readonly _enabled: boolean;
  private readonly _runner: CronScriptRunner | null;
  private readonly _now: () => Date;
  /** cronId → live Cron. Rebuilt wholesale by reload(). */
  private readonly _armed = new Map<string, Cron>();
  /**
   * Crons with a run in flight. Lives on the SCHEDULER (not in `_armed`, not in
   * a closure) precisely so it SURVIVES `reload()`: a PATCH during a long run
   * rebuilds the armed set, and the guard has to outlive that rebuild or the
   * next tick would start a second concurrent run. Shared by the tick path and
   * the manual fire (which the route turns into a 409).
   */
  private readonly _inFlight = new Set<string>();
  /**
   * cronId → the script run currently executing for it. A strict subset of
   * `_inFlight` (message deliveries never appear here, they settle inline).
   * This is the shutdown ledger: `stop()` walks it to journal what it kills.
   */
  private readonly _scriptRuns = new Map<string, ScriptRunState>();

  constructor(opts: CronSchedulerOptions) {
    this._store = opts.store;
    this._spawner = opts.spawner;
    this._defaults = opts.defaults;
    this._timezone = opts.timezone;
    this._enabled = opts.enabled;
    this._runner = opts.runner ?? null;
    this._now = opts.now ?? (() => new Date());
  }

  /** Whether cadence is enabled at all (`SWARM_OS_SCHEDULE_ENABLED`). */
  get enabled(): boolean {
    return this._enabled;
  }

  /**
   * Arm the crons. No-op when disabled. Idempotent.
   *
   * Called AFTER the bootGate flips (index.ts), not next to the constructor:
   * now that every fire writes a `cron_runs` row, ticks landing during
   * auto-resume would persist a trail of `noop`s for teams that were merely
   * still coming back up.
   */
  start(): void {
    if (!this._enabled) {
      log.info({ event: 'crons.disabled' });
      return;
    }
    log.info({ event: 'crons.started', timezone: this._timezone });
    this.reload();
  }

  /**
   * Rebuild the armed set from the crons table. Stops every existing Cron and
   * re-arms one per NON-PAUSED cron. Called at boot and after any cron mutation
   * (so a pause/edit takes effect immediately). An invalid pattern in the DB
   * (shouldn't happen — the route validates) is skipped with a warn, never
   * crashing the boot. Logs the armed set with each cron's next fire time so an
   * operator can confirm a cadence took effect.
   */
  reload(): void {
    if (!this._enabled) return;
    for (const c of this._armed.values()) c.stop();
    this._armed.clear();
    const armed: Array<{ id: string; name: string; schedule: string; next: string | null }> = [];
    for (const cron of this._store.list()) {
      if (cron.paused) continue;
      try {
        const job = new Cron(cron.schedule, { timezone: this._timezone }, () => {
          this.fire(cron.id, 'tick');
        });
        this._armed.set(cron.id, job);
        armed.push({
          id: cron.id,
          name: cron.name,
          schedule: cron.schedule,
          next: job.nextRun()?.toISOString() ?? null,
        });
      } catch (err) {
        log.warn({
          event: 'crons.invalid_cron',
          cronId: cron.id,
          schedule: cron.schedule,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    log.info({ event: 'crons.reload', armed: armed.length, crons: armed });
  }

  /**
   * Next fire time of an ARMED cron, or `null` when it is paused, invalid, or
   * cadence is disabled instance-wide.
   *
   * Read off the live `Cron` on purpose (never recomputed from a fresh
   * `new Cron(expr)`): a bare probe would evaluate in the process's local
   * timezone instead of `SWARM_OS_SCHEDULE_TZ`, and the UI would advertise a
   * fire time hours away from the real one.
   */
  nextRun(cronId: string): Date | null {
    return this._armed.get(cronId)?.nextRun() ?? null;
  }

  /** Whether a run of this cron is currently in flight (route → 409). */
  isRunning(cronId: string): boolean {
    return this._inFlight.has(cronId);
  }

  /**
   * Fire one cron. Never throws.
   *
   * Returns `{ runId, run }` — `run` is the journalled row for a fire that
   * settled synchronously, and `null` for a script run still executing (see
   * `CronFireResult`). `null` overall means the cron is unknown, or the history
   * row could not be written.
   *
   * Deliberately NOT gated on `_enabled`: a manual fire is an explicit operator
   * gesture, allowed on a paused cron and on an instance with cadence disabled
   * (§2.3) — which was already the de-facto behaviour of the role scheduler's
   * public `fireRole`.
   */
  fire(cronId: string, kind: CronRunKind): CronFireResult | null {
    const cron = this._store.get(cronId);
    if (!cron) {
      log.warn({ event: 'crons.fire.unknown', cronId, kind });
      return null;
    }
    const firedAt = this._now();

    // Overlap: record the skipped tick rather than dropping it silently — a
    // cron that is systematically slower than its cadence must be visible in
    // LAST RUNS. Checked here too (not only in the route) because the tick path
    // has no route in front of it.
    if (this._inFlight.has(cronId)) {
      log.info({ event: 'crons.fire.overlap', cronId, name: cron.name, kind });
      const run = this._store.recordRun({
        cronId,
        firedAt,
        kind,
        outcome: 'overlap',
        outputExcerpt: 'previous run still in flight',
      });
      return run ? { runId: run.id, run } : null;
    }

    this._inFlight.add(cronId);
    const startedAt = Date.now();

    // action='script' — the guard is held ACROSS the child's whole lifetime,
    // and only the async continuation releases it. Releasing at launch (the
    // shape a plain `try/finally` around a fire-and-forget call would give)
    // would let the next tick start a second concurrent run, which is the one
    // thing the overlap guard exists to prevent.
    if (cron.action === 'script') {
      const state: ScriptRunState = {
        runId: newCronRunId(),
        kind,
        firedAt,
        startedAt,
        settled: false,
      };
      this._scriptRuns.set(cronId, state);
      void this.runScript(cron, state);
      return { runId: state.runId, run: null };
    }

    try {
      const result = this.deliverMessage(cron, firedAt);
      const run = this._store.recordRun({
        cronId,
        firedAt,
        kind,
        outcome: result.outcome,
        durationMs: Date.now() - startedAt,
        outputExcerpt: result.excerpt,
        deliveredTo: result.deliveredTo,
      });
      return run ? { runId: run.id, run } : null;
    } catch (err) {
      // Defensive: the delivery below already swallows its own failures.
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ event: 'crons.fire.failed', cronId, name: cron.name, error: message });
      const run = this._store.recordRun({
        cronId,
        firedAt,
        kind,
        outcome: 'error',
        durationMs: Date.now() - startedAt,
        outputExcerpt: message,
      });
      return run ? { runId: run.id, run } : null;
    } finally {
      this._inFlight.delete(cronId);
    }
  }

  /**
   * action='message' — render the template and deliver it to the lead inbox of
   * every live orchestrator of the cron's role.
   *
   * The delivery loop is the ONE primitive both actions use (§2.1.5): `from` is
   * `cron:<name>`, and each orchestrator is wrapped in its own try/catch (the
   * `broadcastToLeadsFromExternal` pattern) so one team's failure never denies
   * the tick to the others and never throws out of a timer callback.
   *
   * `skipRecipientCheck` is kept from the role scheduler: a cadence must reach
   * a lead that is merely idle/waiting, not only one the messaging layer would
   * class as active.
   */
  private deliverMessage(
    cron: CronRecord,
    firedAt: Date,
  ): { outcome: CronRunOutcome; excerpt: string | null; deliveredTo: string[] } {
    return this.deliver(cron, renderTemplate(cron.message ?? '', firedAt));
  }

  /**
   * THE delivery primitive (§2.1.5) — shared verbatim by `action='message'` and
   * by a script that answered `wake:true`. Extracted rather than duplicated on
   * purpose: the `from = "cron:<name>"` identity, the `skipRecipientCheck`, the
   * per-orchestrator try/catch and the wake/noop/error verdict must be the same
   * for both actions, or a script wake would behave subtly differently from a
   * template wake for no reason an operator could guess.
   */
  private deliver(
    cron: CronRecord,
    content: string,
  ): { outcome: CronRunOutcome; excerpt: string | null; deliveredTo: string[] } {
    const from = `cron:${cron.name}`;
    const deliveredTo: string[] = [];
    let noLead = 0;
    let failed = 0;
    let lastError: string | null = null;

    for (const orch of this._spawner.listActive()) {
      if (orch.roleId !== cron.roleId) continue;
      const lead = orch.lead;
      if (!lead) {
        noLead += 1;
        continue;
      }
      try {
        sendMessage(
          { orchestrator: orch, mailbox: orch.mailbox, defaults: this._defaults },
          from,
          lead.id,
          content,
          { skipRecipientCheck: true },
        );
        deliveredTo.push(orch.id);
      } catch (err) {
        failed += 1;
        lastError = err instanceof Error ? err.message : String(err);
        log.warn({
          event: 'crons.deliver_failed',
          cronId: cron.id,
          name: cron.name,
          orchestratorId: orch.id,
          error: lastError,
        });
      }
    }

    if (deliveredTo.length > 0) {
      log.info({
        event: 'crons.fire',
        cronId: cron.id,
        name: cron.name,
        deliveredTo,
        noLead,
        failed,
      });
      return { outcome: 'wake', excerpt: null, deliveredTo };
    }
    // Nothing delivered. An attempt that THREW is an error worth surfacing; a
    // role with no live instance is a plain `noop` (§6.1 — v1 does not restart
    // a stopped team).
    if (failed > 0) {
      return { outcome: 'error', excerpt: lastError, deliveredTo };
    }
    log.info({ event: 'crons.fire.noop', cronId: cron.id, name: cron.name, noLead });
    return { outcome: 'noop', excerpt: null, deliveredTo };
  }

  /**
   * action='script' (§2.5) — run the script, then let ITS verdict decide.
   *
   * Outcome mapping, all four of them:
   *   - `wake:true`  → the delivery primitive above: `wake` if a lead got it,
   *                    `noop` if the role has no live instance, `error` if
   *                    every attempt threw;
   *   - `wake:false` → `skip` (the script ran fine and said "nothing to do" —
   *                    the normal, cheap case a script cron exists for);
   *   - anything else (non-zero exit, timeout, overflow, unparseable output,
   *                    a path that no longer resolves under the roots) →
   *                    `error`, with the runner's reason as the excerpt.
   *
   * Async, and the ONLY place the overlap guard for this cron is released. The
   * `settled` latch guards the journalling: `stop()` may already have written
   * this run's row (and closed the DB) while the killed child was dying.
   */
  private async runScript(cron: CronRecord, state: ScriptRunState): Promise<void> {
    let outcome: CronRunOutcome = 'error';
    let excerpt: string | null = null;
    let exitCode: number | null = null;
    let deliveredTo: string[] = [];

    try {
      if (!this._runner) {
        excerpt = 'no script runner is configured on this server';
        log.warn({ event: 'crons.script_no_runner', cronId: cron.id, name: cron.name });
      } else {
        const result = await this._runner.run({
          cronId: cron.id,
          cronName: cron.name,
          scriptPath: cron.scriptPath ?? '',
          interpreter: cron.interpreter ?? '',
          args: cron.scriptArgs ?? [],
          timeoutMs: cron.timeoutMs,
          firedAt: state.firedAt,
        });
        exitCode = result.exitCode;
        excerpt = result.excerpt;
        if (!result.ok) {
          outcome = 'error';
          log.warn({
            event: 'crons.script_failed',
            cronId: cron.id,
            name: cron.name,
            exitCode,
            reason: result.excerpt,
          });
        } else if (!result.wake) {
          outcome = 'skip';
        } else {
          const delivery = this.deliver(cron, result.message ?? `[cron:${cron.name}] wake requested`);
          outcome = delivery.outcome;
          deliveredTo = delivery.deliveredTo;
          // Keep the script's own output as the excerpt unless the DELIVERY is
          // what failed — then the delivery error is the actionable half.
          if (delivery.outcome === 'error' && delivery.excerpt) excerpt = delivery.excerpt;
        }
      }
    } catch (err) {
      // The runner never throws; this is the belt to its braces (an exception
      // escaping here would become an unhandled rejection from a timer).
      outcome = 'error';
      excerpt = err instanceof Error ? err.message : String(err);
      log.warn({ event: 'crons.script_threw', cronId: cron.id, name: cron.name, error: excerpt });
    } finally {
      if (!state.settled) {
        state.settled = true;
        this._store.recordRun({
          id: state.runId,
          cronId: cron.id,
          firedAt: state.firedAt,
          kind: state.kind,
          outcome,
          exitCode,
          durationMs: Date.now() - state.startedAt,
          outputExcerpt: excerpt,
          deliveredTo,
        });
      }
      // Only drop the ledger entry if it is still OURS: `stop()` clears the map
      // wholesale, and a later run of the same cron must not be evicted by a
      // straggler continuation.
      if (this._scriptRuns.get(cron.id) === state) this._scriptRuns.delete(cron.id);
      this._inFlight.delete(cron.id);
    }
  }

  /**
   * Disarm every cron and settle whatever was running. Idempotent.
   *
   * The second half is the shutdown contract of §2.5, and its ORDER is the
   * whole point: `index.ts` calls this synchronously and then walks on to
   * `db.close()`. So we kill the process groups AND write their `error` rows
   * right here, synchronously — waiting for the children's exit callbacks would
   * put the write after the database is gone, leaving a SIGTERM'd deployment
   * with an orphaned script and no trace of it in the run history.
   */
  stop(): void {
    for (const c of this._armed.values()) c.stop();
    this._armed.clear();

    this._runner?.killAll();
    for (const [cronId, state] of this._scriptRuns) {
      if (!state.settled) {
        state.settled = true;
        this._store.recordRun({
          id: state.runId,
          cronId,
          firedAt: state.firedAt,
          kind: state.kind,
          outcome: 'error',
          durationMs: Date.now() - state.startedAt,
          outputExcerpt: 'run killed by server shutdown',
        });
      }
      this._inFlight.delete(cronId);
    }
    this._scriptRuns.clear();
  }

  /** Number of armed crons — for tests / introspection. */
  get armedCount(): number {
    return this._armed.size;
  }
}

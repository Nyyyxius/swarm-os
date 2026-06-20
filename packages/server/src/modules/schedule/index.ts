/**
 * Per-role cron scheduler (in-process).
 *
 * Why in-process (and not an OS cron / sidecar container): same rationale as
 * the backup scheduler — the container runs a single `tini → node` process and
 * we already hold the live spawner + role store in memory. A scheduled tick
 * therefore delivers straight into a lead's mailbox via the existing messaging
 * primitive (no HTTP self-call, no token, no second container).
 *
 * Model: the cadence lives ON THE ROLE (`role.schedule` cron + `role.scheduleMessage`
 * template). At each tick we resolve the role's *live* orchestrators (by
 * `roleId`) and deliver the rendered message to each one's lead inbox — a
 * targeted send, never a broadcast to all leads. 1 instance → 1 lead; N
 * instances → N leads (fan-out is intentional; downstream idempotency, e.g.
 * `UNIQUE(cycle_window_id)`, absorbs duplicates).
 *
 * The cron set is rebuilt by `reload()` at boot and after every role
 * create/update/delete (the roles route invokes it) — there is no role-change
 * event bus, so the mutating route is the re-arm trigger.
 *
 * Trade-off (accepted): ticks only fire while the process is up — but a stopped
 * process delivers nothing useful anyway, and `reload()` at boot re-arms from
 * the DB so the next wall-clock window fires normally after a restart.
 */
import { Cron } from 'croner';
import { withModule } from '../../logger.js';
import type { RoleStore } from '../roles/index.js';
import type { Spawner } from '../spawner/index.js';
import { sendMessage, type MessagingDefaults } from '../orchestrator/messaging.js';
import { renderTemplate } from './template.js';

const log = withModule('schedule');

/** Validate a 5/6-field cron expression. Used by the roles route (and reload). */
export function isValidCron(expr: string): boolean {
  try {
    const probe = new Cron(expr, { paused: true });
    probe.stop();
    return true;
  } catch {
    return false;
  }
}

export interface RoleSchedulerOptions {
  roleStore: RoleStore;
  spawner: Spawner;
  /** Mailbox size cap + idle threshold, reused for the lead delivery. */
  defaults: MessagingDefaults;
  /** IANA timezone for cron evaluation. Default 'UTC' (set by config). */
  timezone: string;
  /** Master switch — `SWARM_OS_SCHEDULE_ENABLED`. */
  enabled: boolean;
  /** Clock override for tests (fire-time stamping). */
  now?: () => Date;
}

export class RoleScheduler {
  private readonly _roleStore: RoleStore;
  private readonly _spawner: Spawner;
  private readonly _defaults: MessagingDefaults;
  private readonly _timezone: string;
  private readonly _enabled: boolean;
  private readonly _now: () => Date;
  /** roleId → live Cron. Rebuilt wholesale by reload(). */
  private readonly _crons = new Map<string, Cron>();

  constructor(opts: RoleSchedulerOptions) {
    this._roleStore = opts.roleStore;
    this._spawner = opts.spawner;
    this._defaults = opts.defaults;
    this._timezone = opts.timezone;
    this._enabled = opts.enabled;
    this._now = opts.now ?? (() => new Date());
  }

  /** Arm crons from the roles table. No-op when disabled. Idempotent. */
  start(): void {
    if (!this._enabled) {
      log.info({ event: 'schedule.disabled' });
      return;
    }
    log.info({ event: 'schedule.started', timezone: this._timezone });
    this.reload();
  }

  /**
   * Rebuild the cron set from the current roles. Stops every existing Cron and
   * re-arms one per role that carries a `schedule`. Called at boot and after
   * any role mutation (so a UI/PATCH cadence change re-arms immediately). An
   * invalid pattern in the DB (shouldn't happen — the route validates) is
   * skipped with a warn, never crashing the boot. Logs the armed set with each
   * role's next fire time so operators can confirm a cadence took effect.
   */
  reload(): void {
    if (!this._enabled) return;
    for (const c of this._crons.values()) c.stop();
    this._crons.clear();
    const armed: Array<{ roleId: string; label: string; schedule: string; next: string | null }> = [];
    for (const role of this._roleStore.list()) {
      if (!role.schedule) continue;
      try {
        const cron = new Cron(role.schedule, { timezone: this._timezone }, () => {
          this.fireRole(role.id);
        });
        this._crons.set(role.id, cron);
        armed.push({
          roleId: role.id,
          label: role.label,
          schedule: role.schedule,
          next: cron.nextRun()?.toISOString() ?? null,
        });
      } catch (err) {
        log.warn({
          event: 'schedule.invalid_cron',
          roleId: role.id,
          schedule: role.schedule,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    log.info({ event: 'schedule.reload', armed: armed.length, crons: armed });
  }

  /**
   * Deliver the role's templated message to the lead inbox of every live
   * orchestrator of this role. Public so a test (or an operator route, later)
   * can drive a tick without waiting on a timer. Never throws.
   */
  fireRole(roleId: string): void {
    const role = this._roleStore.get(roleId);
    if (!role || !role.schedule) return;
    const content = renderTemplate(role.scheduleMessage ?? '', this._now());
    const deliveredTo: string[] = [];
    let skipped = 0;
    for (const orch of this._spawner.listActive()) {
      if (orch.roleId !== roleId) continue;
      const lead = orch.lead;
      if (!lead) {
        skipped += 1;
        continue;
      }
      try {
        sendMessage(
          { orchestrator: orch, mailbox: orch.mailbox, defaults: this._defaults },
          'system',
          lead.id,
          content,
          { skipRecipientCheck: true },
        );
        deliveredTo.push(orch.id);
      } catch (err) {
        skipped += 1;
        log.warn({
          event: 'schedule.deliver_failed',
          roleId,
          orchestratorId: orch.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (deliveredTo.length === 0) {
      log.info({ event: 'schedule.fire.noop', roleId, label: role.label, skipped });
    } else {
      log.info({ event: 'schedule.fire', roleId, label: role.label, deliveredTo, skipped });
    }
  }

  /** Disarm all crons. Idempotent. */
  stop(): void {
    for (const c of this._crons.values()) c.stop();
    this._crons.clear();
  }

  /** Number of armed crons — for tests / introspection. */
  get armedCount(): number {
    return this._crons.size;
  }
}

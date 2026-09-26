/**
 * Roles — reusable orchestrator templates.
 *
 * A role lets the operator pre-fill an orchestrator's lead prompt, preambles,
 * default model/effort/permission-mode, the number of workers to spawn at
 * boot, and a per-orchestrator set of connectors (Discord webhook URL today).
 * Every field except `label` is optional — the role can also be used purely
 * as a descriptive tag.
 *
 * Storage: rows in the `roles` SQLite table. Connectors are JSON-serialized
 * in a single `connectors_json` column to stay future-proof for new
 * connector types without further schema churn.
 */

import * as crypto from 'node:crypto';
import { withModule } from '../../logger.js';
import type { SwarmDb, RoleRow } from '../db/index.js';
import type { EffortLevel, PermissionMode } from '../../config.js';

const log = withModule('roles');

/**
 * Connector type discriminant. `'discord'` is the built-in; any other string
 * is a plugin-provided connector type (J4) whose provider lives in the
 * `ConnectorRegistry`. The `(string & {})` keeps `'discord'` autocompletion
 * while still accepting arbitrary plugin types.
 */
export type ConnectorType = 'discord' | (string & {});

export interface DiscordConnector {
  type: 'discord';
  /**
   * Discord webhook URL for outbound system notifications (session waiting,
   * orchestrator ended, exit anomaly). Optional — a connector can run with
   * only the bot (`botToken`+`channelId`) when the operator does not want
   * system embeds in the channel.
   * At least one of `webhookUrl` or (`botToken`+`channelId`) must be set;
   * the route layer enforces that invariant.
   */
  webhookUrl?: string;
  /**
   * Discord channel id (snowflake) the lead converses in. Optional —
   * when set AND `botToken` is also set, the bot subscribes to this
   * channel: every human message becomes an entry in the lead's inbox
   * (`from: 'discord:<username>'`) and the lead can write back via
   * the `discord.send_message` MCP tool.
   */
  channelId?: string;
  /**
   * Discord bot OAuth token for this role. When set, swarm-os opens a
   * dedicated Gateway connection so the role's leads listen on
   * `channelId` and post via `discord.send_message` under this bot's
   * identity. Multiple roles can share the same token (the pool dedups),
   * but each role can also have its own bot user — that's the whole
   * point of moving from a global token to a per-role one.
   */
  botToken?: string;
}

/**
 * A plugin-provided connector (J4). Unlike the flat built-in `DiscordConnector`,
 * its provider-specific fields live under `config` (validated at the route layer
 * against the connector type's declared schema). `type` is any non-`'discord'`
 * string with a provider registered in the `ConnectorRegistry`.
 */
export interface GenericConnector {
  type: string;
  config: Record<string, unknown>;
}

export type Connector = DiscordConnector | GenericConnector;

/**
 * OPTIONAL per-role override of the approval gate (human-in-the-loop guard,
 * docs/garde-fous-approbation.md §9, P5). Absent (`null`) on a role → the guard
 * behaves EXACTLY as the built-in default: it arms for the modes
 * `isPromptingMode` selects (claude default/plan/acceptEdits), and the Discord
 * approval notification is ON. Every field is independently optional, so a role
 * can override one aspect and inherit the rest.
 */
export interface RoleApprovalSettings {
  /**
   * Master switch for the guard on teams of this role. `false` = never create
   * an approval — the session runs as if the gate did not exist (identical to a
   * bypass session for this purpose). `true`/`undefined` = the guard is active
   * (which modes arm it is still governed by `armingModes` / the default).
   */
  enabled?: boolean;
  /**
   * Explicit allowlist of permission modes that ARM the guard, overriding the
   * built-in per-provider default (`isPromptingMode`). Matched verbatim against
   * `session.permissionMode`. An empty array arms for NO mode. `undefined` =
   * inherit the default.
   */
  armingModes?: string[];
  /**
   * Whether the Discord approval embed/message is posted for this role. `false`
   * = suppress it (the web toast/page, REST API and console remain the actionable
   * controls). `undefined`/`true` = ON.
   */
  discordNotify?: boolean;
}

/**
 * Defensively parse the persisted `approval_json`. Any malformed / unexpected
 * shape degrades to `null` (no override) rather than throwing — this is read on
 * the hook path indirectly and must never break arming. Only recognised,
 * correctly-typed fields survive.
 */
export function parseApprovalSettings(json: string | null | undefined): RoleApprovalSettings | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const out: RoleApprovalSettings = {};
    if (typeof obj.enabled === 'boolean') out.enabled = obj.enabled;
    if (Array.isArray(obj.armingModes)) {
      out.armingModes = obj.armingModes.filter((m): m is string => typeof m === 'string');
    }
    if (typeof obj.discordNotify === 'boolean') out.discordNotify = obj.discordNotify;
    return Object.keys(out).length > 0 ? out : null;
  } catch (err) {
    log.warn({
      event: 'roles.approval_parse_failed',
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Serialize approval settings for storage. `null`/empty → `null` (no override). */
function serializeApprovalSettings(approval: RoleApprovalSettings | null | undefined): string | null {
  if (!approval) return null;
  const out: RoleApprovalSettings = {};
  if (typeof approval.enabled === 'boolean') out.enabled = approval.enabled;
  if (Array.isArray(approval.armingModes)) {
    out.armingModes = approval.armingModes.filter((m): m is string => typeof m === 'string');
  }
  if (typeof approval.discordNotify === 'boolean') out.discordNotify = approval.discordNotify;
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

/** Narrow a connector to the flat built-in Discord shape. */
export function isDiscordConnector(c: Connector): c is DiscordConnector {
  return c.type === 'discord';
}

/**
 * Flatten a connector to the `Record<string, unknown>` config a
 * `ChannelConnectorProvider.subscribeOrch` expects. Discord exposes its flat
 * fields; a generic connector exposes its `config` object.
 */
export function connectorConfig(c: Connector): Record<string, unknown> {
  if (isDiscordConnector(c)) {
    const out: Record<string, unknown> = {};
    if (c.webhookUrl != null) out.webhookUrl = c.webhookUrl;
    if (c.channelId != null) out.channelId = c.channelId;
    if (c.botToken != null) out.botToken = c.botToken;
    return out;
  }
  return c.config ?? {};
}

/**
 * A skill activated on a role (docs/plan-skills-importables.md §3.2). Persisted
 * JSON-serialized in `roles.skills_json`, same convention as `connectors_json`.
 */
export type SkillActivationMode = 'inject';
export interface RoleSkillRef {
  /** Installed skill name (`skills.name`). */
  name: string;
  /** Injection mode. Only `'inject'` at MVP (native materialization is later). */
  mode: SkillActivationMode;
}

/** Defensively parse the persisted `skills_json`; any malformed shape → `[]`. */
export function parseRoleSkills(json: string | null | undefined): RoleSkillRef[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: RoleSkillRef[] = [];
    for (const e of parsed) {
      if (e && typeof e === 'object' && typeof (e as { name?: unknown }).name === 'string') {
        out.push({ name: (e as { name: string }).name, mode: 'inject' });
      }
    }
    return out;
  } catch (err) {
    log.warn({
      event: 'roles.skills_parse_failed',
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * What the budget janitor (modules/orchestrator/budget-watch) does the first
 * time a team of this role crosses `costBudgetUsd`:
 *
 *   - `notify` — emit `session.budget_exceeded` (toast on the web, Discord when
 *     the role carries a webhook) and let the team keep running;
 *   - `pause` — all of the above, then SIGSTOP every running session of the
 *     team, LEAD INCLUDED. Nothing is killed: the operator resumes by hand.
 *
 * `notify` is the default everywhere — the destructive outcome is never the one
 * you get by omission.
 */
export type BudgetAction = 'notify' | 'pause';

/** The two accepted budget actions, single source of truth for the whitelist. */
export const BUDGET_ACTIONS: readonly BudgetAction[] = ['notify', 'pause'];

/** The action used when none is stored (or when a stored value is unknown). */
export const DEFAULT_BUDGET_ACTION: BudgetAction = 'notify';

/**
 * Narrow a persisted `budget_action` to the union. Anything unrecognised — a
 * value from a newer server, a hand-edited row — degrades to `notify`. Failing
 * OPEN here would mean pausing a team on a typo, so the fallback is always the
 * harmless outcome.
 */
export function toBudgetAction(raw: string | null | undefined): BudgetAction {
  return raw === 'pause' ? 'pause' : DEFAULT_BUDGET_ACTION;
}

/**
 * Narrow a persisted `auto_compact_pct` to `null | 0..100`.
 *
 * Anything that is not an integer in range — a `250` or a `35.5` from a
 * hand-edited row or a downgrade, a NaN out of a corrupted file — reads as
 * `null`, i.e. "inherit the instance default". Never as an arbitrary
 * threshold: a stored `250` would silently mean "never compact" and a stored
 * `-5` "compact on every boundary", and in both cases the operator would be
 * looking at a role that ignores the only number they can see. Degrading to
 * the documented instance default is the one outcome that is explainable.
 *
 * The route (`http/routes/roles.ts parseAutoCompactPct`) rejects those values
 * at the door with a 400; this is the read-side half of the same rule, for
 * rows that never came through the route.
 */
export function toAutoCompactPct(raw: number | null | undefined): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 100) return null;
  return raw;
}

export interface Role {
  id: string;
  label: string;
  leadPrompt: string | null;
  leadPreamble: string | null;
  workerPreamble: string | null;
  workerCount: number | null;
  defaultModel: string | null;
  defaultEffort: EffortLevel | null;
  defaultPermissionMode: PermissionMode | null;
  /**
   * Agent provider a team of this role starts on. NULL = inherit the instance
   * default (`config.defaultProvider`). Same nullable shape as `defaultModel`.
   */
  defaultProvider: string | null;
  connectors: Connector[];
  /**
   * @deprecated Cadence moved to the `crons` entity (docs/crons-agents.md).
   * ALWAYS `null`: existing values were migrated into `crons` at the boot that
   * shipped Lot 1, and `create`/`update` below force the column back to NULL.
   * Kept on the type (and in the table) so a downgrade still reads, and so the
   * plugin SDK's `Role` shape does not break.
   */
  schedule: string | null;
  /**
   * @deprecated Moved to `crons.message` — see `schedule` above. Always `null`.
   */
  scheduleMessage: string | null;
  /**
   * OPTIONAL approval-gate override (P5). NULL = no override → the built-in
   * default arming (`isPromptingMode`) and Discord notification ON.
   */
  approval: RoleApprovalSettings | null;
  /** Skills activated on this role (docs/plan-skills-importables.md §3.2). */
  skills: RoleSkillRef[];
  /**
   * Dead-worker reaper toggle. When `true`, the in-process session reaper
   * (modules/orchestrator/reaper) soft-deletes (hideSession) terminal workers
   * — statuses `killed`/`exited`/`failed` — of teams of this role once they
   * have been terminal for longer than `autoRemoveDeadWorkersDelayMs`. Default
   * `false` everywhere (no surprise behaviour change). Never touches leads or
   * non-terminal sessions.
   */
  autoRemoveDeadWorkers: boolean;
  /**
   * Grace period (ms) a terminal worker stays visible before the reaper hides
   * it. Only consulted when `autoRemoveDeadWorkers` is `true`. Default 600000
   * (10 min).
   */
  autoRemoveDeadWorkersDelayMs: number;
  /**
   * Cost budget (docs/monitoring-agents.md, Lot 14): the ceiling in USD on the
   * CUMULATIVE spend of one team of this role — removed/reaped workers
   * included, since the bill is read from the Lot 12 DB aggregate. `null` = no
   * budget (the default), which is NOT the same as `0`.
   *
   * The figure compared against it is a LOWER BOUND: a model with no published
   * rate contributes 0 rather than a guess, so a team can only ever cross its
   * budget LATE, never early.
   */
  costBudgetUsd: number | null;
  /** What happens at the crossing. Always set; `notify` unless stored otherwise. */
  budgetAction: BudgetAction;
  /**
   * Auto-compact threshold (docs/auto-compact.md D6): the percentage of its
   * context window an agent of this role may reach before the server arms a
   * `/compact` at its next idle boundary (idle AND inbox empty — never mid-turn).
   *
   * Three distinct states, and the difference between the first two is the
   * whole point of the field:
   *
   *   - `null` — INHERIT the instance default (`config.autoCompactPct`, 35 by
   *     default). This is what every role reads until someone sets a number,
   *     and what a role goes back to when the form is cleared;
   *   - `0` — auto-compact DISABLED for this role, whatever the instance says.
   *     An explicit opt-out, not an absence of setting;
   *   - `1..100` — this role's own threshold, which wins over the instance.
   *
   * Resolved live at every boundary (`role.autoCompactPct ?? config.autoCompactPct`),
   * never cached: editing a role takes effect on its running agents without a
   * restart, which is the only acceptable behaviour on a fleet that never stops.
   *
   * Since v0.10.1 (docs/auto-compact.md §8.2) this is the team's LEAD
   * threshold only — workers read `workerAutoCompactPct`.
   */
  autoCompactPct: number | null;
  /**
   * Auto-compact threshold for this role's WORKERS (docs/auto-compact.md §8.2,
   * v0.10.1). Same three states as `autoCompactPct`, but a `null` inherits
   * `config.workerAutoCompactPct` (`SWARM_OS_WORKER_AUTO_COMPACT_PCT`), which
   * is `0` = OFF by default: workers run short, linear tasks and their reset
   * is their lead's call. Resolved live, like the lead's
   * (`role.workerAutoCompactPct ?? config.workerAutoCompactPct`).
   */
  workerAutoCompactPct: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Default grace period (ms) before a dead worker is reaped. 10 minutes. */
export const DEFAULT_AUTO_REMOVE_DEAD_WORKERS_DELAY_MS = 600_000;

export interface RoleInit {
  label: string;
  leadPrompt?: string | null;
  leadPreamble?: string | null;
  workerPreamble?: string | null;
  workerCount?: number | null;
  defaultModel?: string | null;
  defaultEffort?: EffortLevel | null;
  defaultPermissionMode?: PermissionMode | null;
  defaultProvider?: string | null;
  connectors?: Connector[];
  /** @deprecated Ignored — forced to NULL by the store (docs/crons-agents.md §2.1.1). */
  schedule?: string | null;
  /** @deprecated Ignored — forced to NULL by the store (docs/crons-agents.md §2.1.1). */
  scheduleMessage?: string | null;
  approval?: RoleApprovalSettings | null;
  skills?: RoleSkillRef[];
  autoRemoveDeadWorkers?: boolean;
  autoRemoveDeadWorkersDelayMs?: number;
  costBudgetUsd?: number | null;
  budgetAction?: BudgetAction;
  /**
   * Omitted = the store's default (`null` = inherit the instance threshold).
   * An explicit `null` on a PATCH means "go back to inheriting" — see
   * `RoleStore.update`, where `undefined` and `null` are NOT interchangeable.
   */
  autoCompactPct?: number | null;
  /** Same contract as `autoCompactPct`, for the workers (docs/auto-compact.md §8.2). */
  workerAutoCompactPct?: number | null;
}

export type RolePatch = Partial<RoleInit>;

function rowToRole(row: RoleRow): Role {
  let connectors: Connector[] = [];
  if (row.connectors_json) {
    try {
      const parsed = JSON.parse(row.connectors_json) as unknown;
      if (Array.isArray(parsed)) connectors = parsed as Connector[];
    } catch (err) {
      log.warn({
        event: 'roles.connectors_parse_failed',
        roleId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    id: row.id,
    label: row.label,
    leadPrompt: row.lead_prompt,
    leadPreamble: row.lead_preamble,
    workerPreamble: row.worker_preamble,
    workerCount: row.worker_count,
    defaultModel: row.default_model,
    defaultEffort: row.default_effort as EffortLevel | null,
    defaultPermissionMode: row.default_permission_mode as PermissionMode | null,
    defaultProvider: row.default_provider,
    connectors,
    schedule: row.schedule,
    scheduleMessage: row.schedule_message,
    approval: parseApprovalSettings(row.approval_json),
    skills: parseRoleSkills(row.skills_json),
    // SQLite stores the flag as 0/1; anything but 1 reads as OFF. Delay is a
    // plain INTEGER (NOT NULL DEFAULT 600000) — the `?? default` guards test
    // fixtures / rows read before the column existed.
    autoRemoveDeadWorkers: row.auto_remove_dead_workers === 1,
    autoRemoveDeadWorkersDelayMs:
      typeof row.auto_remove_dead_workers_delay_ms === 'number'
        ? row.auto_remove_dead_workers_delay_ms
        : DEFAULT_AUTO_REMOVE_DEAD_WORKERS_DELAY_MS,
    // A budget is a positive finite REAL or nothing. A stored 0, a NaN out of
    // a corrupted row, or a negative amount all read as "no budget" rather than
    // as a ceiling every team is instantly over — the janitor must never pause
    // a fleet because of a bad row.
    costBudgetUsd:
      typeof row.cost_budget_usd === 'number' &&
      Number.isFinite(row.cost_budget_usd) &&
      row.cost_budget_usd > 0
        ? row.cost_budget_usd
        : null,
    budgetAction: toBudgetAction(row.budget_action),
    autoCompactPct: toAutoCompactPct(row.auto_compact_pct),
    // Same read-side sanitising: a corrupt or hand-edited value inherits, it
    // never becomes an arbitrary threshold (and `undefined` — a row read
    // through a fixture predating the column — inherits too).
    workerAutoCompactPct: toAutoCompactPct(row.worker_auto_compact_pct),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function roleToRow(r: Role): RoleRow {
  return {
    id: r.id,
    label: r.label,
    lead_prompt: r.leadPrompt,
    lead_preamble: r.leadPreamble,
    worker_preamble: r.workerPreamble,
    worker_count: r.workerCount,
    default_model: r.defaultModel,
    default_effort: r.defaultEffort,
    default_permission_mode: r.defaultPermissionMode,
    default_provider: r.defaultProvider,
    connectors_json: r.connectors.length ? JSON.stringify(r.connectors) : null,
    schedule: r.schedule,
    schedule_message: r.scheduleMessage,
    approval_json: serializeApprovalSettings(r.approval),
    skills_json: r.skills.length ? JSON.stringify(r.skills) : null,
    auto_remove_dead_workers: r.autoRemoveDeadWorkers ? 1 : 0,
    auto_remove_dead_workers_delay_ms: r.autoRemoveDeadWorkersDelayMs,
    cost_budget_usd: r.costBudgetUsd,
    budget_action: r.budgetAction,
    auto_compact_pct: r.autoCompactPct,
    worker_auto_compact_pct: r.workerAutoCompactPct,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

export class RoleStore {
  constructor(private readonly db: SwarmDb) {}

  create(init: RoleInit): Role {
    const now = new Date().toISOString();
    const role: Role = {
      id: crypto.randomUUID(),
      label: init.label,
      leadPrompt: init.leadPrompt ?? null,
      leadPreamble: init.leadPreamble ?? null,
      workerPreamble: init.workerPreamble ?? null,
      workerCount: init.workerCount ?? null,
      defaultModel: init.defaultModel ?? null,
      defaultEffort: init.defaultEffort ?? null,
      defaultPermissionMode: init.defaultPermissionMode ?? null,
      defaultProvider: init.defaultProvider ?? null,
      connectors: init.connectors ?? [],
      // NEUTRALISED (docs/crons-agents.md §2.1.1). The 400 on the roles route
      // is not enough: the plugin façade hands its `RoleInit` straight to this
      // store (`plugins/api.ts`), so a plugin writing a `schedule` would
      // re-feed the legacy-migration source at every boot — a cadence that
      // keeps resurrecting as a duplicate cron. The column is dead here, in the
      // one place every writer goes through.
      schedule: null,
      scheduleMessage: null,
      approval: init.approval ?? null,
      skills: init.skills ?? [],
      autoRemoveDeadWorkers: init.autoRemoveDeadWorkers ?? false,
      autoRemoveDeadWorkersDelayMs:
        init.autoRemoveDeadWorkersDelayMs ?? DEFAULT_AUTO_REMOVE_DEAD_WORKERS_DELAY_MS,
      costBudgetUsd: init.costBudgetUsd ?? null,
      budgetAction: init.budgetAction ?? DEFAULT_BUDGET_ACTION,
      // `??` is correct HERE (unlike in `update`): on a create there is no
      // previous value, so "omitted" and "explicitly null" both mean inherit.
      autoCompactPct: init.autoCompactPct ?? null,
      workerAutoCompactPct: init.workerAutoCompactPct ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insertRole(roleToRow(role));
    return role;
  }

  get(id: string): Role | null {
    const row = this.db.getRole(id);
    return row ? rowToRole(row) : null;
  }

  list(): Role[] {
    return this.db.listRoles().map(rowToRole);
  }

  update(id: string, patch: RolePatch): Role | null {
    const existing = this.get(id);
    if (!existing) return null;
    const updated: Role = {
      ...existing,
      label: patch.label ?? existing.label,
      leadPrompt: patch.leadPrompt !== undefined ? patch.leadPrompt : existing.leadPrompt,
      leadPreamble: patch.leadPreamble !== undefined ? patch.leadPreamble : existing.leadPreamble,
      workerPreamble: patch.workerPreamble !== undefined ? patch.workerPreamble : existing.workerPreamble,
      workerCount: patch.workerCount !== undefined ? patch.workerCount : existing.workerCount,
      defaultModel: patch.defaultModel !== undefined ? patch.defaultModel : existing.defaultModel,
      defaultEffort: patch.defaultEffort !== undefined ? patch.defaultEffort : existing.defaultEffort,
      defaultPermissionMode:
        patch.defaultPermissionMode !== undefined
          ? patch.defaultPermissionMode
          : existing.defaultPermissionMode,
      defaultProvider:
        patch.defaultProvider !== undefined ? patch.defaultProvider : existing.defaultProvider,
      connectors: patch.connectors !== undefined ? patch.connectors : existing.connectors,
      // NEUTRALISED — see `create`. A patch can never set a cadence back on a
      // role, whichever door it came through (route, plugin façade, test).
      schedule: null,
      scheduleMessage: null,
      approval: patch.approval !== undefined ? patch.approval : existing.approval,
      skills: patch.skills !== undefined ? patch.skills : existing.skills,
      autoRemoveDeadWorkers:
        patch.autoRemoveDeadWorkers !== undefined
          ? patch.autoRemoveDeadWorkers
          : existing.autoRemoveDeadWorkers,
      autoRemoveDeadWorkersDelayMs:
        patch.autoRemoveDeadWorkersDelayMs !== undefined
          ? patch.autoRemoveDeadWorkersDelayMs
          : existing.autoRemoveDeadWorkersDelayMs,
      // `null` is a MEANINGFUL patch value here (clear the budget), so the
      // `!== undefined` guard is load-bearing — `??` would make a clear a no-op.
      costBudgetUsd:
        patch.costBudgetUsd !== undefined ? patch.costBudgetUsd : existing.costBudgetUsd,
      budgetAction: patch.budgetAction !== undefined ? patch.budgetAction : existing.budgetAction,
      // Same load-bearing `!== undefined` as the budget above: `null` is a
      // MEANINGFUL patch value (back to inheriting the instance threshold), so
      // a `??` here would make "clear the field" a silent no-op and leave the
      // role pinned to a number the operator just erased.
      autoCompactPct:
        patch.autoCompactPct !== undefined ? patch.autoCompactPct : existing.autoCompactPct,
      // Same load-bearing `!== undefined`: `null` sends the workers back to
      // the instance default (off unless the operator moved it).
      workerAutoCompactPct:
        patch.workerAutoCompactPct !== undefined
          ? patch.workerAutoCompactPct
          : existing.workerAutoCompactPct,
      updatedAt: new Date().toISOString(),
    };
    this.db.updateRole(roleToRow(updated));
    return updated;
  }

  delete(id: string): boolean {
    return this.db.deleteRole(id);
  }

  /**
   * Clear the approval-gate override on EVERY role (`roles.approval_json = NULL`),
   * so a role falls back to the built-in default arming. Called by the `approvals`
   * feature descriptor's purge() when the feature is UNINSTALLED
   * (docs/builtin-features.md D7): the per-role override is approval-subsystem
   * data and must not survive its data purge. A clean store method rather than a
   * raw UPDATE from the descriptor. Returns the number of roles touched. Budget
   * config (`costBudgetUsd`/`budgetAction`) is deliberately left intact (D7).
   */
  clearApprovalSettings(): number {
    return this.db.clearAllRoleApprovalSettings();
  }
}

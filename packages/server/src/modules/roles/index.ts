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
   * 5-field cron expression. When set, the in-process RoleScheduler
   * (modules/schedule) delivers `scheduleMessage` to the lead inbox of every
   * live orchestrator of this role at each tick (TZ = SWARM_OS_SCHEDULE_TZ,
   * default UTC). NULL = no cadence.
   */
  schedule: string | null;
  /**
   * Message template delivered to the lead at each cron tick. Supports
   * `{{fire}}` (fire time truncated to the minute, e.g. `2026-06-18T20:00Z`),
   * `{{now}}` (full ISO), and `{{window:Nh}}`/`{{window:Nm}}`. Required when
   * `schedule` is set (route-enforced).
   */
  scheduleMessage: string | null;
  /**
   * OPTIONAL approval-gate override (P5). NULL = no override → the built-in
   * default arming (`isPromptingMode`) and Discord notification ON.
   */
  approval: RoleApprovalSettings | null;
  createdAt: string;
  updatedAt: string;
}

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
  schedule?: string | null;
  scheduleMessage?: string | null;
  approval?: RoleApprovalSettings | null;
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
      schedule: init.schedule ?? null,
      scheduleMessage: init.scheduleMessage ?? null,
      approval: init.approval ?? null,
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
      schedule: patch.schedule !== undefined ? patch.schedule : existing.schedule,
      scheduleMessage:
        patch.scheduleMessage !== undefined ? patch.scheduleMessage : existing.scheduleMessage,
      approval: patch.approval !== undefined ? patch.approval : existing.approval,
      updatedAt: new Date().toISOString(),
    };
    this.db.updateRole(roleToRow(updated));
    return updated;
  }

  delete(id: string): boolean {
    return this.db.deleteRole(id);
  }
}

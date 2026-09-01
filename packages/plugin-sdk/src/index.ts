/**
 * @swarm-os/plugin-sdk — the PUBLIC contract for authoring swarm-os plugins.
 *
 * This package is **types-only**: it declares the shape of the `SwarmPluginApi`
 * a plugin receives at `activate()`, plus every satellite type, and carries NO
 * runtime dependency on the server. A plugin runs *inside* the swarm-os process,
 * so it never imports the server's internals — it compiles against these stable
 * shapes and uses the injected `api` object at runtime.
 *
 * Add it as a devDependency for autocompletion; do not depend on it at runtime:
 *
 * ```ts
 * import type { SwarmPlugin, SwarmPluginApi } from '@swarm-os/plugin-sdk';
 *
 * const plugin: SwarmPlugin = {
 *   activate(api: SwarmPluginApi) {
 *     api.log.info('hello from my plugin');
 *   },
 * };
 * export default plugin;
 * ```
 *
 * The only external type reference is `zod` (v4), for MCP tool schemas built via
 * `api.zod`. Keep it as a devDependency alongside this SDK.
 */

import type { z } from 'zod';

// ---------------------------------------------------------------------------
// Host contract version
// ---------------------------------------------------------------------------

/** The host API contract version this SDK targets. A manifest with a higher
 *  `apiVersion` is refused at enable — the host cannot honour a newer contract. */
export const HOST_API_VERSION = 1;

// ---------------------------------------------------------------------------
// Minimal structural stand-ins for host-provided objects (no express/pino dep)
// ---------------------------------------------------------------------------

/** Structural subset of the pino logger handed to a plugin (`api.log`). */
export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Structural subset of the Express router `api.http.createRouter()` returns.
 * A plugin builds routes on it and registers it via `api.http.registerRouter`.
 * (Typed loosely on purpose — the concrete Router comes from the SERVER's
 * express instance, so authors should not import their own express.)
 */
export interface Router {
  use(...handlers: unknown[]): Router;
  get(path: string, ...handlers: unknown[]): Router;
  post(path: string, ...handlers: unknown[]): Router;
  put(path: string, ...handlers: unknown[]): Router;
  patch(path: string, ...handlers: unknown[]): Router;
  delete(path: string, ...handlers: unknown[]): Router;
}

// ---------------------------------------------------------------------------
// Capabilities & manifest
// ---------------------------------------------------------------------------

/** Capabilities a manifest may DECLARE; the operator GRANTS a subset in the UI. */
export const PLUGIN_CAPABILITIES = [
  'events',
  'events-emit',
  'messaging',
  'teams',
  'roles',
  'mcp-tools',
  'http-routes',
  'http-public',
  'agent-assets',
  'db-kv',
  'db-tables',
  'notify',
  'schedule',
  'connectors',
  'settings-read',
  'host-exec',
  'crons',
] as const;

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

/**
 * A UI panel a plugin exposes (feature B.3, uiPanels v1). The swarm-os SPA
 * renders one navigation entry per panel of an ENABLED plugin and hosts `path`
 * inside an iframe under the plugin's authenticated HTTP zone
 * (`/plugin-api/<name>/`).
 */
export interface UiPanel {
  /** `^[a-z][a-z0-9-]*$`, unique within `uiPanels` — also the SPA route segment. */
  id: string;
  /** Navigation label (non-empty, ≤ 80 chars). */
  title: string;
  /** RELATIVE path under `/plugin-api/<name>/` — no absolute path, no `..`. */
  path: string;
}

/** A flat subset of JSON Schema driving the auto-generated config/connector form. */
export interface PluginConfigProp {
  type: 'string' | 'number' | 'boolean';
  /** Allowed values (string or number props) — renders a <select>. */
  enum?: Array<string | number>;
  default?: string | number | boolean;
  title?: string;
  description?: string;
  /** `'password'` masks the value on read (string props only). */
  format?: 'password';
}

export interface PluginConfigSchema {
  type: 'object';
  properties: Record<string, PluginConfigProp>;
  required?: string[];
}

/** `plugin.json` — declares what the plugin is and what it wants. */
export interface PluginManifest {
  /** `^[a-z][a-z0-9-]{1,40}$` — prefix for routes/tools/events. */
  name: string;
  /** semver. */
  version: string;
  displayName?: string;
  description?: string;
  /** ESM entry (relative `.js`), e.g. `"dist/index.js"`. */
  main: string;
  /** Refused at enable if `> HOST_API_VERSION`. */
  apiVersion: number;
  /** Declared capabilities — the operator grants a subset. */
  capabilities: PluginCapability[];
  configSchema?: PluginConfigSchema;
  /** Scripts/CLI shipped for the AGENTS to run (capability `agent-assets`). */
  agentAssets?: { dir: string };
  /** Channel connector types this plugin provides (capability `connectors`). */
  connectors?: Array<{ type: string; label: string; schema?: PluginConfigSchema }>;
  /** UI panels rendered by the SPA as iframes (feature B.3). Optional, default `[]`. */
  uiPanels?: UiPanel[];
}

// ---------------------------------------------------------------------------
// Disposables
// ---------------------------------------------------------------------------

export interface Disposable {
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type BuiltinSwarmEventKind =
  | 'orchestrator.created'
  | 'orchestrator.updated'
  | 'orchestrator.destroyed'
  | 'session.created'
  | 'session.status_changed'
  | 'session.exited'
  | 'mailbox.message'
  | 'plugin.host.changed';

/** Open union — plugins emit `plugin.<name>.<subKind>` via `api.events.emit`. */
export type SwarmEventKind = BuiltinSwarmEventKind | `plugin.${string}`;

export interface SwarmEvent {
  kind: SwarmEventKind;
  ts: string;
  orchestratorId?: string;
  sessionId?: string;
  payload?: unknown;
}

// ---------------------------------------------------------------------------
// Messaging outcomes + mailbox message
// ---------------------------------------------------------------------------

export interface Message {
  id: string;
  from: string;
  content: string;
  ts: string;
  fromOrchestratorId?: string;
  fromOrchestratorName?: string;
  fromSessionName?: string;
  sourceKind?: string;
  sourceMessageId?: string;
  threadId?: string;
  threadName?: string;
}

export interface SendOutcome {
  delivered: boolean;
  dropped: boolean;
  queueSize: number;
  signalled: boolean;
}

export interface BroadcastOutcome {
  delivered_to: string[];
  skipped: string[];
}

export interface CrossSendOutcome {
  delivered: boolean;
  dropped: boolean;
  queueSize: number;
  signalled: boolean;
  to_session_id: string;
  to_orchestrator_id: string;
}

export interface CrossBroadcastOutcome {
  delivered_to: Array<{ orchestrator_id: string; session_id: string }>;
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type PermissionMode =
  | 'auto'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'default'
  | 'dontAsk'
  | 'plan';

export interface DiscordConnector {
  type: 'discord';
  webhookUrl?: string;
  channelId?: string;
  botToken?: string;
}

export interface GenericConnector {
  type: string;
  config: Record<string, unknown>;
}

export type Connector = DiscordConnector | GenericConnector;

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
  connectors: Connector[];
  /**
   * @deprecated The per-role cadence moved to the first-class `crons` entity
   * (docs/crons-agents.md). ALWAYS reads back `null`: existing values were
   * migrated into `crons`, and the role store forces the column to NULL on
   * every write. Kept on the type so an existing plugin still compiles.
   */
  schedule: string | null;
  /** @deprecated Moved to `crons.message` — see `schedule`. Always `null`. */
  scheduleMessage: string | null;
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
  connectors?: Connector[];
  /** @deprecated Ignored — the role store writes NULL (docs/crons-agents.md). */
  schedule?: string | null;
  /** @deprecated Ignored — the role store writes NULL (docs/crons-agents.md). */
  scheduleMessage?: string | null;
}

export type RolePatch = Partial<RoleInit>;

// ---------------------------------------------------------------------------
// Crons (capability `crons`)
// ---------------------------------------------------------------------------

/**
 * What a tick does.
 *   - `message` — render the template and drop it in the lead inbox of every
 *     live instance of the target role.
 *   - `script`  — run a local script that decides whether waking the agent is
 *     worth an agent turn, and with what message.
 */
export type CronAction = 'message' | 'script';

/** A cron as `api.crons.*` returns it: the stored row + its live next fire. */
export interface Cron {
  id: string;
  /**
   * Display slug, UNIQUE across the instance — and the identity a plugin
   * reconciles against (`getByName`). It is also the sender of the messages the
   * cron delivers, which show up as `cron:<name>`.
   */
  name: string;
  /** Target ROLE (not a session): the tick fans out to every live instance. */
  roleId: string;
  /** 5-field cron expression, evaluated in the server's `SWARM_OS_SCHEDULE_TZ`. */
  schedule: string;
  action: CronAction;
  /** `action: 'message'` — template, supports `{{fire}}`, `{{now}}`, `{{window:Nh|Nm}}`. */
  message: string | null;
  /** `action: 'script'` — absolute path, under the workspace or data roots. */
  scriptPath: string | null;
  scriptArgs: string[] | null;
  /** `action: 'script'` — `'python3' | 'bash' | 'node'`. */
  interpreter: string | null;
  /** `action: 'script'` — per-run wall-clock budget (1 000 … 240 000 ms). */
  timeoutMs: number | null;
  /** A paused cron stays in the list but is not armed (and has no next run). */
  paused: boolean;
  /**
   * ISO-8601 of the next fire, read off the ARMED job — `null` whenever no fire
   * is coming: the cron is paused, cadence is disabled instance-wide, or the row
   * was only just written. Read `paused`, never a null `nextRun`, to tell
   * whether a cron is switched off.
   */
  nextRun: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CronInit {
  /** 1-64 chars: letters, digits, dot, dash, underscore. UNIQUE. */
  name: string;
  roleId: string;
  /** EXACTLY 5 fields — a 6-field (per-second) expression is refused. */
  schedule: string;
  action: CronAction;
  /** Required when `action: 'message'`. */
  message?: string | null;
  /** Required when `action: 'script'`, together with `interpreter`. */
  scriptPath?: string | null;
  scriptArgs?: string[] | null;
  interpreter?: string | null;
  /** Script crons only; defaults to 60 000 ms, capped at 240 000 ms. */
  timeoutMs?: number | null;
  /** Create it switched off (default `false`). */
  paused?: boolean;
}

/**
 * Partial edit. An omitted key is left untouched; an explicit `null` clears the
 * field (e.g. `{ scriptArgs: null }` drops the args).
 */
export type CronPatch = Partial<CronInit>;

// ---------------------------------------------------------------------------
// Notify + settings
// ---------------------------------------------------------------------------

export type NotificationKind =
  | 'session.waiting'
  | 'orchestrator.ended'
  | 'session.exit_anomaly';

export interface NotificationInput {
  kind: NotificationKind;
  orchestrator: { id: string; name: string; role: string; status: string };
  session?: {
    id: string;
    name: string;
    role: string;
    type: 'lead' | 'worker';
    status: string;
    exitCode?: number | null;
    stopReason?: string | null;
  };
  message: string;
  extra?: Record<string, unknown>;
}

/** Severity of a custom notification — maps to the embed colour. */
export type NotificationLevel = 'info' | 'warn' | 'critical';

/**
 * Free-form notification sent via `api.notify.custom`. The embed title is
 * prefixed `[plugin:<name>]` by the host — the plugin name is injected, never
 * supplied by the caller. `level` maps to the embed colour (info → green,
 * warn → yellow, critical → red); default `info`.
 */
export interface CustomNotificationInput {
  /** Non-empty, ≤ 200 chars after trim. */
  title: string;
  /** Non-empty, ≤ 4000 chars after trim. */
  message: string;
  /** Default `'info'`. */
  level?: NotificationLevel;
}

// ---------------------------------------------------------------------------
// Host exec (api.host.exec — capability `host-exec`)
// ---------------------------------------------------------------------------

/** Input to `api.host.exec` — a command to run on the host over SSH. */
export interface HostExecInput {
  /** Program + args. Non-empty; element 0 is the binary (resolved on the host PATH). */
  argv: string[];
  /** Working directory on the host. Container `/workspace` + `/data` paths are translated. */
  cwd?: string;
  /** Wall-clock timeout in ms. Default 30 000, capped at 120 000. */
  timeoutMs?: number;
  /** Per-stream capture cap in bytes. Default 1 MiB, capped at 8 MiB. */
  maxOutputBytes?: number;
}

/** Result of `api.host.exec`. */
export interface HostExecResult {
  /** Exit code, or `null` when terminated by a signal (including timeout). */
  code: number | null;
  /** Captured stdout (utf8), truncated to `maxOutputBytes` with a marker suffix. */
  stdout: string;
  /** Captured stderr (utf8), truncated to `maxOutputBytes` with a marker suffix. */
  stderr: string;
  /** True when the process was killed because it exceeded `timeoutMs`. */
  timedOut: boolean;
}

/** Input to `api.host.spawnJob` — a command launched as a DETACHED host job. */
export interface HostJobSpawnInput {
  /** Program + args. Non-empty; element 0 is the binary (resolved on the host PATH). */
  argv: string[];
  /** Working directory on the host. Container `/workspace` + `/data` paths are translated. */
  cwd?: string;
}

/** Opaque handle returned by `api.host.spawnJob` — `jobId` is a server-minted UUID. */
export interface HostJobRef {
  jobId: string;
}

/** Snapshot returned by `api.host.jobStatus`. */
export interface HostJobStatus {
  /** True while the job's process group is still alive (no exit recorded yet). */
  running: boolean;
  /** Exit code once finished; `null` while running or if the job vanished untracked. */
  code: number | null;
  /** Last `tailBytes` of stdout (utf8), with a truncation marker when clipped. */
  stdoutTail: string;
  /** Last `tailBytes` of stderr (utf8), with a truncation marker when clipped. */
  stderrTail: string;
}

export interface InstanceSettings {
  instanceLabel: string | null;
  accent: string;
  bgTint: string;
  fontSize: number;
  density: string;
  darkMode: boolean;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Teams (snapshot projection)
// ---------------------------------------------------------------------------

export interface TeamView {
  id: string;
  name: string;
  role: string;
  status: string;
  leadSessionId: string | null;
  sessions: Array<{
    id: string;
    name: string;
    role: string;
    type: 'lead' | 'worker';
    status: string;
  }>;
}

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

export interface PluginToolDef {
  name: string;
  title: string;
  description: string;
  /** When true the host applies the existing `requireLead` guard. */
  leadOnly?: boolean;
  inputSchema: z.ZodRawShape;
  outputSchema?: z.ZodRawShape;
  handler(
    args: Record<string, unknown>,
    ctx: PluginToolContext,
  ): Promise<object> | object;
}

/** PROJECTION of the real MCP context — never the live session_secret. */
export interface PluginToolContext {
  orchestratorId: string;
  orchestratorName: string;
  sessionId: string;
  sessionName: string;
  role: string;
  isLead: boolean;
}

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

export interface ChannelConnectorProvider {
  subscribeOrch(
    connectorConfig: Record<string, unknown>,
    sub: PluginOrchSubscription,
  ): Promise<void>;
  unsubscribeOrch(orchId: string): Promise<void>;
  stopAll(): Promise<void>;
}

export interface PluginOrchSubscription {
  orchestratorId: string;
  getLeadSessionId(): string | null;
  pushToLeadInbox(
    content: string,
    meta?: {
      from?: string;
      sourceKind?: string;
      sourceMessageId?: string;
      threadId?: string;
      threadName?: string;
    },
  ): void;
  /** Wake the lead's PTY if idle — same path as the Discord bridge. */
  notifyLead(): void;
}

// ---------------------------------------------------------------------------
// The injected API
// ---------------------------------------------------------------------------

export interface SwarmPluginApi {
  readonly pluginName: string;
  readonly log: Logger;
  readonly zod: typeof z;

  readonly config: {
    get<T = Record<string, unknown>>(): T;
    onChange(cb: (next: unknown) => void): Disposable;
  };

  readonly storage: {
    kv: {
      get(k: string): string | null;
      set(k: string, v: string): void;
      delete(k: string): void;
      list(prefix?: string): Array<{ key: string; value: string }>;
    };
    defineTable(ddl: string): void;
    prepare<P extends object = object, R = unknown>(
      sql: string,
    ): { run(p?: P): void; get(p?: P): R | undefined; all(p?: P): R[] };
  };

  readonly events: {
    on(kind: SwarmEventKind | '*', cb: (ev: SwarmEvent) => void): Disposable;
    emit(
      subKind: string,
      payload?: unknown,
      opts?: { orchestratorId?: string; sessionId?: string },
    ): void;
  };

  readonly teams: {
    list(): TeamView[];
    get(id: string): TeamView | null;
    create(spec: {
      name: string;
      roleId?: string;
      cwd: string;
      prompt?: string;
    }): Promise<{ id: string; leadSessionId: string }>;
    destroy(id: string, reason?: string): Promise<void>;
    spawnWorker(
      orchId: string,
      spec: { name: string; role?: string; prompt: string; cwd?: string },
    ): Promise<{ sessionId: string }>;
    killWorker(orchId: string, sessionId: string): Promise<void>;
  };

  readonly roles: {
    list(): Role[];
    get(id: string): Role | null;
    create(init: RoleInit): Role;
    update(id: string, patch: RolePatch): Role;
    delete(id: string): void;
  };

  /**
   * Agent crons (capability `crons`) — the same entity the `#/crons` screen and
   * the `/crons` REST surface drive, with the same validation. This is how a
   * plugin PROVISIONS the cadences it needs instead of asking the operator to
   * type them into a form.
   *
   * Use it as an idempotent UPSERT BY NAME at every `activate()`, so a redeploy
   * reconciles instead of duplicating:
   *
   * ```ts
   * const wanted = {
   *   name: 'trader-open',              // stable identity, UNIQUE, also `cron:<name>`
   *   roleId,
   *   schedule: '30 9 * * 1-5',         // 5 fields, server timezone
   *   action: 'message' as const,
   *   message: 'market open — {{now}}',
   * };
   * const found = api.crons.getByName(wanted.name);
   * if (!found) {
   *   await api.crons.create(wanted);
   * } else if (found.schedule !== wanted.schedule || found.message !== wanted.message) {
   *   await api.crons.update(found.id, { schedule: wanted.schedule, message: wanted.message });
   * }
   * ```
   *
   * DIFF BEFORE WRITING, as above. Every mutation re-arms the scheduler and
   * bumps `updatedAt`, so an unconditional `update` on each activation makes the
   * cron look permanently edited and needlessly rebuilds the armed set. And
   * `create` on an existing name THROWS (the name is unique) rather than
   * adopting the row — `getByName` first is not optional.
   *
   * Validation is identical to the operator's form: 5-field expression, known
   * `roleId`, `message` required for a message cron, `scriptPath` + `interpreter`
   * required (and contained under the workspace/data roots) for a script cron.
   * A rejected write throws with the field-level reason.
   *
   * Ownership is not enforced: crons a plugin creates are visible and editable in
   * the UI, and vice-versa. Prefix your names (`myplugin-…`) so an operator can
   * tell where a cadence came from.
   */
  readonly crons: {
    list(): Cron[];
    get(id: string): Cron | null;
    /** `null` when no cron carries that name — the read half of an upsert. */
    getByName(name: string): Cron | null;
    /** Async: a `script` cron's path is realpath-checked before it is stored. */
    create(init: CronInit): Promise<Cron>;
    /** Partial edit. Throws when `id` is unknown. */
    update(id: string, patch: CronPatch): Promise<Cron>;
    /** Idempotent — deleting an unknown id is a no-op. Run history cascades. */
    delete(id: string): void;
  };

  readonly messaging: {
    sendToSession(orchId: string, sessionId: string, content: string): SendOutcome;
    sendToLead(orchId: string, content: string): CrossSendOutcome;
    broadcast(orchId: string, content: string): BroadcastOutcome;
    broadcastToLeads(content: string): CrossBroadcastOutcome;
    /** Destructive — reserved for bridges. */
    readInbox(orchId: string, sessionId: string): Message[];
  };

  readonly mcp: { registerTool(def: PluginToolDef): Disposable };

  readonly http: {
    createRouter(): Router;
    registerRouter(router: Router): Disposable;
    registerPublicRouter(router: Router): Disposable;
  };

  readonly notify: {
    send(input: NotificationInput): Promise<void>;
    /** Free-form alert embed titled `[plugin:<name>] …` — see `CustomNotificationInput`. */
    custom(input: CustomNotificationInput): Promise<void>;
  };

  readonly schedule: {
    cron(expr: string, cb: () => void | Promise<void>): Disposable;
    interval(ms: number, cb: () => void): Disposable;
  };

  readonly connectors: {
    register(type: string, provider: ChannelConnectorProvider): Disposable;
  };

  readonly settings: { instance(): InstanceSettings };

  readonly agentAssets: { readonly basePath: string };

  /**
   * Run an arbitrary command on the HOST over SSH (capability `host-exec`).
   *
   * ⚠️ TRUST MODEL — the most powerful capability in the system: arbitrary code
   * execution on the host as the SSH user. Grant it only to plugins you trust
   * absolutely. Available ONLY under the `ssh` agent transport; rejects with a
   * clear error under `local`. `argv` runs directly (no shell word-splitting),
   * no interactive PTY; a non-zero exit is a normal result, a timeout returns
   * `timedOut: true`.
   *
   * `exec` is for SHORT foreground commands. For long work that must OUTLIVE the
   * call (and a swarm-os restart), use the detached job trio `spawnJob` /
   * `jobStatus` / `killJob` (same `host-exec` capability): the job runs under
   * `setsid` in its own session and its bookkeeping lives on the `/data` bind
   * mount, so `killJob` can take down its whole process group across a restart.
   */
  readonly host: {
    exec(input: HostExecInput): Promise<HostExecResult>;
    spawnJob(input: HostJobSpawnInput): Promise<HostJobRef>;
    jobStatus(input: { jobId: string; tailBytes?: number }): Promise<HostJobStatus>;
    killJob(input: { jobId: string }): Promise<void>;
  };
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export interface SwarmPlugin {
  activate(api: SwarmPluginApi): void | Promise<void>;
  /** Optional — the host's disposables cover everything registered via the API. */
  deactivate?(): void | Promise<void>;
}

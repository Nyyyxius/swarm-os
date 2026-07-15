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
] as const;

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

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
  /** Reserved for v2. */
  uiPanels?: unknown[];
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
  schedule: string | null;
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
  schedule?: string | null;
  scheduleMessage?: string | null;
}

export type RolePatch = Partial<RoleInit>;

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
   */
  readonly host: {
    exec(input: HostExecInput): Promise<HostExecResult>;
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

/**
 * Plugin system — public contract shared between the host and plugin authors.
 *
 * This module declares the FULL surface (`SwarmPluginApi` and every satellite
 * type) so plugin authors compile against a stable shape from J1 onward. The
 * host only *materialises* a reduced subset in J1 (`log`, `config.get`,
 * `storage.kv`, `events.on/emit`, `schedule.interval` — see `api.ts`); the
 * remaining groups (`teams`, `roles`, `messaging`, `mcp`, `http`, `notify`,
 * `connectors`, `settings`) are declared here but throw a clear
 * `PluginCapabilityError` until a later milestone wires them (J2–J4).
 *
 * ⚠️ Crash-isolation is structural: EVERY callback a plugin registers is
 * wrapped by the host's `guard()` before it can run, and every façade carries
 * an epoch token so a tick still in flight after `disable()` raises a benign
 * `PluginDisabledError` instead of a silent no-op (see `host.ts`).
 */

import { z } from 'zod';
import type { Logger } from 'pino';
import type { Router } from 'express';
import type { SwarmEvent, SwarmEventKind } from '../../events.js';
import type { Role, RoleInit, RolePatch } from '../roles/index.js';
import type {
  SendOutcome,
  BroadcastOutcome,
  CrossSendOutcome,
  CrossBroadcastOutcome,
} from '../orchestrator/messaging.js';
import type { Message } from '../orchestrator/mailbox.js';
import type { NotificationInput } from '../notify/index.js';
import type { InstanceSettings } from '../settings/index.js';

/**
 * Capabilities a manifest may DECLARE. The operator then GRANTS a subset in
 * the UI; `buildPluginApi` materialises only `manifest ∩ granted`. Declaring a
 * capability does not grant access — it only makes the checkbox appear.
 */
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
] as const;

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

// ---------------------------------------------------------------------------
// Disposables
// ---------------------------------------------------------------------------

export interface Disposable {
  dispose(): void;
}

/**
 * Tracks the resources a plugin acquires during `activate()` and tears them
 * down in REVERSE order at `disable()`. Every `on`/`register`/`schedule`
 * method auto-adds its handle here, so a plugin that never implements
 * `deactivate()` is still fully torn down. Each `dispose()` runs in its own
 * try/catch so one throwing disposable can't strand the rest.
 */
export class DisposableStore {
  private readonly items: Disposable[] = [];
  private disposed = false;

  constructor(private readonly onError?: (err: unknown) => void) {}

  add<T extends Disposable>(d: T): T {
    if (this.disposed) {
      // Late add after teardown — dispose immediately so it can't leak.
      try {
        d.dispose();
      } catch {
        /* swallowed — store is already torn down */
      }
      return d;
    }
    this.items.push(d);
    return d;
  }

  disposeAll(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Reverse order: last-acquired resource released first.
    for (let i = this.items.length - 1; i >= 0; i--) {
      const d = this.items[i];
      if (!d) continue;
      try {
        d.dispose();
      } catch (err) {
        this.onError?.(err);
      }
    }
    this.items.length = 0;
  }
}

/**
 * Raised by any façade method reached through a STALE epoch — i.e. an
 * asynchronous tick that was still in flight when the plugin got disabled.
 * `guard()` swallows it WITHOUT charging the crash counter. Never surfaced as
 * a silent no-op: value-returning methods (`kv.get`, `teams.list`, …) would
 * otherwise return `undefined` and crash the plugin's own code.
 */
export class PluginDisabledError extends Error {
  constructor(pluginName: string) {
    super(`plugin '${pluginName}' is disabled (stale epoch)`);
    this.name = 'PluginDisabledError';
  }
}

/**
 * Raised when a plugin reaches a façade whose capability the operator did not
 * grant (or that this milestone does not materialise yet). This IS a real
 * error surfaced to the plugin — not swallowed by `guard()` unless the plugin
 * itself lets it propagate out of a guarded callback.
 */
export class PluginCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginCapabilityError';
  }
}

// ---------------------------------------------------------------------------
// Runtime status / view
// ---------------------------------------------------------------------------

export type PluginRuntimeStatus =
  | 'disabled'
  | 'enabled'
  | 'error'
  | 'crashed'
  | 'quarantined';

/** Returned by every REST endpoint and `PluginHost.list()`. */
export interface PluginView {
  name: string;
  version: string;
  displayName?: string;
  status: PluginRuntimeStatus;
  enabled: boolean;
  sourceKind: string;
  apiVersion: number;
  /** Requested by the manifest. */
  capabilities: PluginCapability[];
  /** Granted by the operator (⊆ capabilities). Null before first enable. */
  grantedCapabilities: string[] | null;
  failCount: number;
  quarantinedUntil: string | null;
  lastError: string | null;
  installedAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Tool / connector projections (materialised in later milestones)
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

/**
 * PROJECTION of the real MCP `ToolContext` — a plugin never receives the
 * live Orchestrator/Session/Spawner handles or the `session_secret`.
 */
export interface PluginToolContext {
  orchestratorId: string;
  orchestratorName: string;
  sessionId: string;
  sessionName: string;
  role: string;
  isLead: boolean;
}

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
    },
  ): void;
  /** Wake the lead's PTY if idle — same path as the Discord bridge. */
  notifyLead(): void;
}

// ---------------------------------------------------------------------------
// TeamView — snapshot projection of an orchestrator (no session_secret)
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
// The injected API
// ---------------------------------------------------------------------------

export interface SwarmPluginApi {
  readonly pluginName: string;
  readonly log: Logger;
  readonly zod: typeof z;

  readonly config: {
    get<T = Record<string, unknown>>(): T;
    /** Otherwise the host `reload()`s the plugin on a config PUT. */
    onChange(cb: (next: unknown) => void): Disposable;
  };

  readonly storage: {
    kv: {
      get(k: string): string | null;
      set(k: string, v: string): void;
      delete(k: string): void;
      list(prefix?: string): Array<{ key: string; value: string }>;
    };
    /** J2 — private `plugin_<name'>_*` tables. */
    defineTable(ddl: string): void;
    prepare<P extends object = object, R = unknown>(
      sql: string,
    ): { run(p?: P): void; get(p?: P): R | undefined; all(p?: P): R[] };
  };

  readonly events: {
    /**
     * Handlers are dispatched ASYNCHRONOUSLY (`setImmediate`) so they never
     * sit on the synchronous `emitEvent → sendMessage` path; each is wrapped
     * by `guard()` and removed at `disable()`.
     */
    on(kind: SwarmEventKind | '*', cb: (ev: SwarmEvent) => void): Disposable;
    /** Kind is forced to `plugin.${pluginName}.${subKind}` — no forging core kinds. */
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
    /**
     * Build a fresh router from the SERVER's express instance. Plugins should
     * use this rather than importing their own express — a router from a
     * different express version may not mount cleanly.
     */
    createRouter(): Router;
    registerRouter(router: Router): Disposable; // /plugin-api/<name>/* — after auth
    registerPublicRouter(router: Router): Disposable; // /public/plugins/<name>/* — before auth
  };

  readonly notify: { send(input: NotificationInput): Promise<void> };

  readonly schedule: {
    cron(expr: string, cb: () => void | Promise<void>): Disposable;
    interval(ms: number, cb: () => void): Disposable;
  };

  readonly connectors: {
    register(type: string, provider: ChannelConnectorProvider): Disposable;
  };

  readonly settings: { instance(): InstanceSettings };

  /**
   * Scripts/CLI the plugin ships for the AGENTS to run (capability
   * `agent-assets`). `basePath` is the transport-aware absolute directory the
   * plugin's declared `agentAssets.dir` was copied to — the plugin uses it when
   * announcing its scripts to leads (e.g. `bash <basePath>/hello.sh`).
   */
  readonly agentAssets: { readonly basePath: string };
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export interface SwarmPlugin {
  activate(api: SwarmPluginApi): void | Promise<void>;
  /** Optional — the DisposableStore covers everything registered via the API. */
  deactivate?(): void | Promise<void>;
}

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
import type { ApprovalReplyResolver } from '../approvals/reply.js';
import type { ApprovalReactionResolver } from '../approvals/reaction.js';
import type { SwarmEvent, SwarmEventKind } from '../../events.js';
import type { Role, RoleInit, RolePatch } from '../roles/index.js';
import type {
  SendOutcome,
  BroadcastOutcome,
  CrossSendOutcome,
  CrossBroadcastOutcome,
} from '../orchestrator/messaging.js';
import type { Message } from '../orchestrator/mailbox.js';
import type {
  HostExecInput,
  HostExecResult,
  HostJobRef,
  HostJobStatus,
  HostJobSpawnInput,
} from '../orchestrator/ssh-exec.js';
import type { NotificationInput, NotificationLevel } from '../notify/index.js';
import type { InstanceSettings } from '../settings/index.js';
import type { UiPanel } from './manifest.js';

export type {
  HostExecInput,
  HostExecResult,
  HostJobRef,
  HostJobStatus,
  HostJobSpawnInput,
} from '../orchestrator/ssh-exec.js';
export type { UiPanel } from './manifest.js';

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
  'host-exec',
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

/**
 * Raised by `storage.defineTable` / `storage.prepare` when a plugin's SQL
 * violates the private-table contract: a statement that is not mono-statement,
 * a DDL/DML referencing a table OUTSIDE the plugin's `plugin_<name'>_` prefix,
 * a `defineTable` that would create a non-prefixed object, or a forbidden verb
 * (PRAGMA/ATTACH/DETACH/VACUUM/transaction control). This is a real error
 * surfaced to the plugin — the guardrail keeps a plugin's SQL strictly inside
 * its own tables and off the core schema (`roles`, `plugins`, …).
 */
export class PluginStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginStorageError';
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
  /**
   * Git HEAD the plugin was installed from. Null for npm/dir/upload sources and
   * for anything installed before origin tracking existed — those can only ever
   * report an "unknown" update status.
   */
  sourceCommit: string | null;
  /**
   * Update detection. Declared here, but NOT populated by this module: the
   * plugin host knows nothing about remotes. `routes/plugins.ts` (`withUpdate`)
   * fills both in from the `UpdateService` sweep as the view goes out.
   *
   * Absent whenever detection is not wired, or the sweep has never seen this
   * plugin — treat an absent value as "not checked", never as "up to date".
   * `latestVersion` stays null for a git plugin: the newest thing at its source
   * is a sha, and there is nowhere honest to put one here.
   */
  latestVersion?: string | null;
  updateStatus?: 'up_to_date' | 'available' | 'unknown' | 'error';
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
  /**
   * UI panels the plugin declares (feature B.3). Surfaced ONLY when the plugin
   * is enabled — a disabled plugin's HTTP routes are torn down, so exposing a
   * panel would dead-link. Empty `[]` otherwise.
   */
  uiPanels: UiPanel[];
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
  /**
   * P5 (approval gate) — OPTIONAL outbound seam. Post `text` to the channel the
   * given orch is bound to and return the posted message id, or `null` when this
   * provider/orch cannot post (not bound, gateway down, no id). The server's
   * approval hook (`modules/approvals/discord-notify.ts`) calls this to route the
   * "approval requested" message through a plugin-owned channel (e.g. the
   * `discord-agent` connector) and persist the returned id so a native *reply*
   * can later be correlated back to the approval. Additive: providers that omit
   * it simply fall back to the built-in bot / webhook path.
   *
   * ⚠️ The host reconstructs a guarded provider in `plugins/api.ts`; any new
   * method here MUST be forwarded there or it is silently dropped.
   */
  sendToOrchChannel?(orchId: string, text: string): Promise<{ messageId: string } | null>;
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
  /**
   * P4 — optional approval-reply router forwarded to the channel bot. When set,
   * the bot tries it FIRST on native replies; a consumed decision is resolved +
   * confirmed and NOT pushed to the inbox. See `modules/approvals/reply.ts`.
   */
  tryConsumeApprovalReply?: ApprovalReplyResolver;
  /**
   * P5 — optional approval-REACTION router, the sibling of `tryConsumeApprovalReply`.
   * When set, the bot calls it on `messageReactionAdd`: a ✅/♾️/❌ reaction on an
   * approval card resolves the matching pending approval through the shared core.
   * A reaction is NEVER pushed to the inbox, so a non-consumed result is a no-op.
   * See `modules/approvals/reaction.ts`.
   *
   * ⚠️ Like `tryConsumeApprovalReply`, this is forwarded through the sub
   * reconstruction in `connector-registry.ts` — a new method dropped there never
   * reaches the built-in bot.
   */
  tryConsumeApprovalReaction?: ApprovalReactionResolver;
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
// Notify — plugin custom notifications (api.notify.custom)
// ---------------------------------------------------------------------------

export type PluginNotificationLevel = NotificationLevel;

/**
 * Free-form notification a plugin sends via `api.notify.custom`. The embed
 * title is prefixed `[plugin:<name>]` by the façade — the plugin name is
 * injected, never supplied by the caller. `level` maps to the embed colour
 * (info → green, warn → yellow, critical → red); default `info`.
 */
export interface PluginCustomNotification {
  /** Non-empty, ≤ 200 chars after trim. */
  title: string;
  /** Non-empty, ≤ 4000 chars after trim. */
  message: string;
  /** Default `'info'`. */
  level?: PluginNotificationLevel;
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

  readonly notify: {
    send(input: NotificationInput): Promise<void>;
    /** Free-form alert embed titled `[plugin:<name>] …` — see `PluginCustomNotification`. */
    custom(input: PluginCustomNotification): Promise<void>;
  };

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

  /**
   * Run an arbitrary command on the HOST over SSH (capability `host-exec`).
   *
   * ⚠️ TRUST MODEL — this is the most powerful capability in the system: it is
   * arbitrary code execution on the host, as the SSH user. Grant it ONLY to
   * plugins you trust absolutely. It is available **only** under the `ssh`
   * agent transport (`SWARM_OS_AGENT_TRANSPORT=ssh`); the call rejects with a
   * clear error under the `local` transport (there is no host to reach).
   *
   * Semantics: `argv` is run directly (each element `shellQuote`d — no shell
   * word-splitting), no interactive PTY. A non-zero exit is a normal result
   * (`code` set); a timeout kills the ssh process and returns `timedOut: true`.
   * `cwd` container paths (`/workspace`, `/data`) are translated to their host
   * equivalents; anything else is treated as a host-native path.
   *
   * `exec` is for SHORT commands (bounded, foreground). For long-running work
   * that must OUTLIVE the call (and even a swarm-os restart) use the detached
   * job trio `spawnJob` / `jobStatus` / `killJob` (same `host-exec` capability).
   */
  readonly host: {
    exec(input: HostExecInput): Promise<HostExecResult>;
    /**
     * Launch `argv` as a DETACHED host job and return its `jobId`. The job runs
     * under `setsid` (its own session), so it survives the SSH channel closing
     * AND a swarm-os restart; its bookkeeping lives on the `/data` bind mount.
     * Poll it with `jobStatus`; stop it with `killJob`.
     */
    spawnJob(input: HostJobSpawnInput): Promise<HostJobRef>;
    /** Snapshot a job's liveness + captured output tails (`tailBytes` per stream). */
    jobStatus(input: { jobId: string; tailBytes?: number }): Promise<HostJobStatus>;
    /** Terminate a job's whole process group (SIGTERM, grace, SIGKILL). Idempotent. */
    killJob(input: { jobId: string }): Promise<void>;
  };
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export interface SwarmPlugin {
  activate(api: SwarmPluginApi): void | Promise<void>;
  /** Optional — the DisposableStore covers everything registered via the API. */
  deactivate?(): void | Promise<void>;
}

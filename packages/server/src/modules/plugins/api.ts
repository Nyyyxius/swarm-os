/**
 * `buildPluginApi` — materialises the `SwarmPluginApi` handed to a plugin's
 * `activate()`.
 *
 * J2 materialises the FULL surface minus connectors (J4): `log`, `zod`,
 * `config`, `storage.kv`, `events`, `schedule` (interval + cron), `teams`,
 * `roles`, `messaging`, `notify`, `mcp`, `http`, `settings`, `agentAssets`.
 *
 * Two cross-cutting guarantees hold on every method:
 *  - **Capability gating** — `requireCap` checks the granted set (already
 *    `manifest ∩ operator-granted`); a non-granted access throws
 *    `PluginCapabilityError`.
 *  - **Epoch token** — a value-returning method reached through a stale epoch
 *    (a tick still in flight after `disable()`) throws `PluginDisabledError`,
 *    which `guard()` swallows without charging the crash counter. Registered
 *    callbacks are additionally wrapped by the host's `guard()`.
 */

import express, { type Router } from 'express';
import { Cron } from 'croner';
import type { Logger } from 'pino';
import type { z } from 'zod';
import type { SwarmEvent, SwarmEventKind } from '../../events.js';
import type { PluginStore } from './store.js';
import type { Spawner } from '../spawner/index.js';
import type { Orchestrator, OrchestratorInit } from '../orchestrator/index.js';
import type { RoleStore } from '../roles/index.js';
import type { SettingsStore } from '../settings/index.js';
import type { Notifier } from '../notify/index.js';
import type { Config, EffortLevel, PermissionMode } from '../../config.js';
import type { PluginToolRegistry } from './mcp-registry.js';
import type { PluginHttpRegistry } from './http-registry.js';
import type { ConnectorRegistry } from './connector-registry.js';
import { parseConfigSchema } from './config-schema.js';
import {
  resolveAgentDefaults,
  resolveProviderId,
  type AgentDefaultsLayer,
} from '../providers/resolve.js';
import {
  sendMessage,
  broadcast,
  readInbox,
  pushToLeadInbox,
  broadcastToLeadsFromExternal,
  type MessagingDefaults,
} from '../orchestrator/messaging.js';
import {
  normalizeWorkspaceRelativeCwd,
  validateCwdUnderWorkspace,
} from '../../http/validation.js';
import {
  hostExec,
  spawnHostJob,
  hostJobStatus,
  killHostJob,
  HOST_EXEC_MAX_TIMEOUT_MS,
  HOST_EXEC_MAX_OUTPUT_BYTES,
  HOST_JOB_MAX_TAIL_BYTES,
} from '../orchestrator/ssh-exec.js';
import {
  type SwarmPluginApi,
  type PluginCapability,
  type DisposableStore,
  type TeamView,
  type PluginToolDef,
  type ChannelConnectorProvider,
  PluginDisabledError,
  PluginCapabilityError,
} from './api-types.js';

/** Generic guard wrapper supplied by the host, bound to a plugin + epoch. */
export type PluginGuard = <A extends unknown[]>(
  hook: string,
  fn: (...args: A) => unknown,
) => (...args: A) => unknown;

/** Minimal shape of the event bus the API needs (avoids importing the class). */
export interface EventBusLike {
  on(event: 'event', cb: (ev: SwarmEvent) => void): unknown;
  off(event: 'event', cb: (ev: SwarmEvent) => void): unknown;
  emitEvent(ev: Omit<SwarmEvent, 'ts'>): void;
}

export interface PluginApiDeps {
  store: PluginStore;
  eventBus: EventBusLike;
  log: Logger;
  zod: typeof z;
  /** manifest ∩ operator-granted capabilities. */
  granted: ReadonlySet<PluginCapability>;
  /** Crash-isolating wrapper bound to this plugin + activation epoch. */
  guard: PluginGuard;
  /** Live epoch of the plugin — compared against the captured `epoch`. */
  currentEpoch: () => number;
  /** Host-owned list of config-change subscribers for this activation. */
  onConfigChange: Array<(next: unknown) => void>;

  // ---- J2 deps (optional so J1 host paths / unit tests still construct) -----
  spawner?: Spawner;
  roleStore?: RoleStore;
  settingsStore?: SettingsStore;
  notifier?: Notifier;
  config?: Config;
  /** = () => scheduler.reload(); fired after every role mutation. */
  onRolesChanged?: () => void;
  toolRegistry?: PluginToolRegistry;
  httpRegistry?: PluginHttpRegistry;
  /** J4 — connector registry backing api.connectors.register. */
  connectorRegistry?: ConnectorRegistry;
  /** J4 — the manifest's `connectors[]` declarations (label + schema per type). */
  connectorDecls?: Array<{ type: string; label: string; schema?: unknown }>;
  /** TZ for schedule.cron (config.scheduleTimezone). */
  scheduleTimezone?: string;
  /** Transport-aware base path for this plugin's agentAssets (or null). */
  agentAssetsBasePath?: string | null;
}

/** Snapshot projection of an orchestrator — never exposes session_secret. */
function orchToTeamView(orch: Orchestrator): TeamView {
  return {
    id: orch.id,
    name: orch.name,
    role: orch.role,
    status: orch.status,
    leadSessionId: orch.leadSessionId,
    sessions: orch.listSessions().map((s) => {
      const v = s.toView();
      return { id: v.id, name: v.name, role: v.role, type: v.type, status: v.status };
    }),
  };
}

export function buildPluginApi(
  deps: PluginApiDeps,
  name: string,
  disposables: DisposableStore,
  epoch: number,
): SwarmPluginApi {
  const { store, eventBus, log, zod, granted, guard } = deps;

  const messagingDefaults: MessagingDefaults = {
    maxMessageSizeBytes: deps.config?.maxMessageSizeBytes ?? 16 * 1024,
    idleThresholdMs: deps.config?.idleThresholdMs ?? 2000,
  };

  /** Throw `PluginDisabledError` (benign) when reached through a stale epoch. */
  function ensureLive(): void {
    if (epoch !== deps.currentEpoch()) throw new PluginDisabledError(name);
  }

  function requireCap(cap: PluginCapability): void {
    if (!granted.has(cap)) {
      throw new PluginCapabilityError(
        `plugin '${name}' requires the '${cap}' capability (not granted)`,
      );
    }
  }

  /** Assert a J2 dependency was wired (production always wires them). */
  function need<T>(dep: T | undefined | null, what: string): T {
    if (dep == null) {
      throw new PluginCapabilityError(`api.${what} is not available in this build`);
    }
    return dep;
  }

  const from = `plugin:${name}`;

  // api.notify.custom input — trimmed, non-empty, bounded (Discord caps the
  // embed title at 256; the `[plugin:<name>]` prefix eats part of that budget).
  const customNotifySchema = zod.object({
    title: zod.string().trim().min(1).max(200),
    message: zod.string().trim().min(1).max(4000),
    level: zod.enum(['info', 'warn', 'critical']).default('info'),
  });

  // api.host.exec input — argv non-empty (each element a string); timeout and
  // output cap bounded (an over-limit value is REJECTED, not silently clamped).
  // Defaults for omitted timeout/output are applied by `hostExec`.
  const hostExecSchema = zod.object({
    argv: zod.array(zod.string()).min(1),
    cwd: zod.string().min(1).optional(),
    timeoutMs: zod.number().int().positive().max(HOST_EXEC_MAX_TIMEOUT_MS).optional(),
    maxOutputBytes: zod.number().int().positive().max(HOST_EXEC_MAX_OUTPUT_BYTES).optional(),
  });

  // api.host.spawnJob input — argv non-empty; cwd optional. No timeout/output
  // caps here: a detached job is unbounded by design (poll it via jobStatus).
  const hostJobSpawnSchema = zod.object({
    argv: zod.array(zod.string()).min(1),
    cwd: zod.string().min(1).optional(),
  });
  // A jobId is a server-minted UUID; `tailBytes` is bounded (over-limit rejected).
  const hostJobIdSchema = zod.object({ jobId: zod.string().min(1) });
  const hostJobStatusSchema = zod.object({
    jobId: zod.string().min(1),
    tailBytes: zod.number().int().positive().max(HOST_JOB_MAX_TAIL_BYTES).optional(),
  });

  const api: SwarmPluginApi = {
    pluginName: name,
    log,
    zod,

    config: {
      get<T = Record<string, unknown>>(): T {
        ensureLive();
        return store.getConfig(name) as T;
      },
      onChange(cb: (next: unknown) => void) {
        const guarded = guard('config.onChange', (next: unknown) => cb(next));
        deps.onConfigChange.push(guarded);
        return disposables.add({
          dispose: () => {
            const i = deps.onConfigChange.indexOf(guarded);
            if (i >= 0) deps.onConfigChange.splice(i, 1);
          },
        });
      },
    },

    storage: {
      kv: {
        get(k: string): string | null {
          requireCap('db-kv');
          ensureLive();
          return store.kvGet(name, k);
        },
        set(k: string, v: string): void {
          requireCap('db-kv');
          ensureLive();
          store.kvSet(name, k, v);
        },
        delete(k: string): void {
          requireCap('db-kv');
          ensureLive();
          store.kvDelete(name, k);
        },
        list(prefix?: string) {
          requireCap('db-kv');
          ensureLive();
          return store.kvList(name, prefix);
        },
      },
      defineTable(ddl: string): void {
        requireCap('db-tables');
        ensureLive();
        store.defineTable(name, ddl);
      },
      prepare<P extends object = object, R = unknown>(sql: string) {
        requireCap('db-tables');
        ensureLive();
        const stmt = store.prepareForPlugin<P, R>(name, sql);
        // Re-check the epoch on EVERY call: a statement a plugin holds across
        // disable() must become a benign PluginDisabledError, not a live handle
        // onto the shared DB after the plugin is torn down.
        return {
          run: (p?: P): void => {
            ensureLive();
            stmt.run(p);
          },
          get: (p?: P): R | undefined => {
            ensureLive();
            return stmt.get(p);
          },
          all: (p?: P): R[] => {
            ensureLive();
            return stmt.all(p);
          },
        };
      },
    },

    events: {
      on(kind: SwarmEventKind | '*', cb: (ev: SwarmEvent) => void) {
        requireCap('events');
        // Guard the plugin's handler; dispatch it OFF the synchronous
        // emitEvent path via setImmediate so a slow handler never blocks the
        // core send. The listener is removed at disable() by the disposable.
        const guarded = guard('events.on', (ev: SwarmEvent) => cb(ev));
        const listener = (ev: SwarmEvent): void => {
          if (kind !== '*' && ev.kind !== kind) return;
          setImmediate(() => {
            guarded(ev);
          });
        };
        eventBus.on('event', listener);
        return disposables.add({
          dispose: () => {
            eventBus.off('event', listener);
          },
        });
      },
      emit(subKind: string, payload?: unknown, opts?: { orchestratorId?: string; sessionId?: string }) {
        requireCap('events-emit');
        ensureLive();
        const kind = `plugin.${name}.${String(subKind)}` as SwarmEventKind;
        eventBus.emitEvent({
          kind,
          orchestratorId: opts?.orchestratorId,
          sessionId: opts?.sessionId,
          payload,
        });
      },
    },

    schedule: {
      cron(expr: string, cb: () => void | Promise<void>) {
        requireCap('schedule');
        const guarded = guard('schedule.cron', cb);
        let job: Cron;
        try {
          job = new Cron(expr, { timezone: deps.scheduleTimezone ?? 'UTC' }, () => {
            guarded();
          });
        } catch (err) {
          throw new Error(
            `invalid cron expression '${expr}': ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return disposables.add({
          dispose: () => {
            job.stop();
          },
        });
      },
      interval(ms: number, cb: () => void) {
        requireCap('schedule');
        const guarded = guard('schedule.interval', cb);
        const timer = setInterval(() => {
          guarded();
        }, ms);
        timer.unref?.();
        return disposables.add({
          dispose: () => {
            clearInterval(timer);
          },
        });
      },
    },

    teams: {
      list(): TeamView[] {
        requireCap('teams');
        ensureLive();
        return need(deps.spawner, 'teams')
          .list()
          .map(orchToTeamView);
      },
      get(id: string): TeamView | null {
        requireCap('teams');
        ensureLive();
        const orch = need(deps.spawner, 'teams').get(id);
        return orch ? orchToTeamView(orch) : null;
      },
      async create(spec) {
        requireCap('teams');
        ensureLive();
        const sp = need(deps.spawner, 'teams');
        const cfg = need(deps.config, 'teams');
        const role = spec.roleId && deps.roleStore ? deps.roleStore.get(spec.roleId) : null;
        const normalized = normalizeWorkspaceRelativeCwd(spec.cwd, cfg.workspaceRoot);
        const resolvedCwd = await validateCwdUnderWorkspace(normalized, cfg.workspaceRoot);
        // Fourth creation channel, same rule as the other three
        // (`providers/resolve.ts`). It used to read the role's MODEL while
        // ignoring the role's PROVIDER entirely, so a `defaultProvider: gemini`
        // role produced a CLAUDE team running a gemini model id.
        const layers: AgentDefaultsLayer[] = [
          {
            source: 'role',
            provider: role?.defaultProvider ?? null,
            model: role?.defaultModel ?? null,
            effort: (role?.defaultEffort as EffortLevel | null) ?? null,
            permissionMode: (role?.defaultPermissionMode as PermissionMode | null) ?? null,
          },
          {
            source: 'config',
            provider: cfg.defaultProvider,
            model: cfg.defaultModel,
            effort: cfg.defaultEffort,
            permissionMode: cfg.defaultPermissionMode,
          },
        ];
        const providerId = resolveProviderId(layers, cfg.defaultProvider);
        // Unknown id ⇒ leave it to `Orchestrator._resolveProvider`, which warns
        // and falls back rather than taking a team down. We only need SOME
        // adapter here to scope the defaults against.
        const adapter = sp.providerRegistry.get(providerId) ?? sp.providerRegistry.get(cfg.defaultProvider);
        const resolved = adapter
          ? resolveAgentDefaults({
              provider: adapter,
              layers,
              fallbackProvider: cfg.defaultProvider,
              context: { channel: 'plugin teams.create', team: spec.name },
            })
          : {
              model: role?.defaultModel ?? cfg.defaultModel,
              effort: (role?.defaultEffort as EffortLevel | null) ?? cfg.defaultEffort,
              permissionMode:
                (role?.defaultPermissionMode as PermissionMode | null) ??
                cfg.defaultPermissionMode,
            };
        const init: OrchestratorInit = {
          name: spec.name,
          role: role?.label ?? 'plugin',
          roleId: role?.id ?? null,
          defaultModel: resolved.model,
          defaultEffort: resolved.effort,
          defaultPermissionMode: resolved.permissionMode,
          defaultProvider: providerId,
          leadPreamble: role?.leadPreamble ?? null,
          workerPreamble: role?.workerPreamble ?? null,
          lead: {
            cwd: resolvedCwd,
            prompt: spec.prompt ?? role?.leadPrompt ?? '',
            preamble: role?.leadPreamble ?? null,
          },
        };
        const { orchestrator, lead } = sp.create(init);
        return { id: orchestrator.id, leadSessionId: lead.id };
      },
      async destroy(id: string, reason?: string): Promise<void> {
        requireCap('teams');
        ensureLive();
        need(deps.spawner, 'teams').destroy(id, reason ?? 'plugin');
      },
      async spawnWorker(orchId, spec) {
        requireCap('teams');
        ensureLive();
        const sp = need(deps.spawner, 'teams');
        const cfg = need(deps.config, 'teams');
        const orch = sp.get(orchId);
        if (!orch) throw new Error(`orchestrator ${orchId} not found`);
        let cwd: string | undefined;
        if (spec.cwd) {
          const normalized = normalizeWorkspaceRelativeCwd(spec.cwd, cfg.workspaceRoot);
          cwd = await validateCwdUnderWorkspace(normalized, cfg.workspaceRoot);
        }
        const worker = orch.addWorker({
          name: spec.name,
          role: spec.role ?? orch.role,
          prompt: spec.prompt,
          cwd,
        });
        return { sessionId: worker.id };
      },
      async killWorker(orchId: string, sessionId: string): Promise<void> {
        requireCap('teams');
        ensureLive();
        const orch = need(deps.spawner, 'teams').get(orchId);
        if (!orch) throw new Error(`orchestrator ${orchId} not found`);
        orch.killWorker(sessionId);
      },
    },

    roles: {
      list() {
        requireCap('roles');
        ensureLive();
        return need(deps.roleStore, 'roles').list();
      },
      get(id: string) {
        requireCap('roles');
        ensureLive();
        return need(deps.roleStore, 'roles').get(id);
      },
      create(init) {
        requireCap('roles');
        ensureLive();
        const role = need(deps.roleStore, 'roles').create(init);
        deps.onRolesChanged?.();
        return role;
      },
      update(id, patch) {
        requireCap('roles');
        ensureLive();
        const role = need(deps.roleStore, 'roles').update(id, patch);
        if (!role) throw new Error(`role ${id} not found`);
        deps.onRolesChanged?.();
        return role;
      },
      delete(id: string) {
        requireCap('roles');
        ensureLive();
        need(deps.roleStore, 'roles').delete(id);
        deps.onRolesChanged?.();
      },
    },

    messaging: {
      sendToSession(orchId, sessionId, content) {
        requireCap('messaging');
        ensureLive();
        const orch = need(deps.spawner, 'messaging').get(orchId);
        if (!orch) throw new Error(`orchestrator ${orchId} not found`);
        return sendMessage(
          { orchestrator: orch, mailbox: orch.mailbox, defaults: messagingDefaults },
          from,
          sessionId,
          content,
        );
      },
      sendToLead(orchId, content) {
        requireCap('messaging');
        ensureLive();
        const orch = need(deps.spawner, 'messaging').get(orchId);
        if (!orch) throw new Error(`orchestrator ${orchId} not found`);
        return pushToLeadInbox(orch, from, content, messagingDefaults);
      },
      broadcast(orchId, content) {
        requireCap('messaging');
        ensureLive();
        const orch = need(deps.spawner, 'messaging').get(orchId);
        if (!orch) throw new Error(`orchestrator ${orchId} not found`);
        return broadcast(
          { orchestrator: orch, mailbox: orch.mailbox, defaults: messagingDefaults },
          from,
          content,
        );
      },
      broadcastToLeads(content) {
        requireCap('messaging');
        ensureLive();
        return broadcastToLeadsFromExternal(
          need(deps.spawner, 'messaging'),
          from,
          content,
          messagingDefaults,
        );
      },
      readInbox(orchId, sessionId) {
        requireCap('messaging');
        ensureLive();
        const orch = need(deps.spawner, 'messaging').get(orchId);
        if (!orch) throw new Error(`orchestrator ${orchId} not found`);
        return readInbox(
          { orchestrator: orch, mailbox: orch.mailbox, defaults: messagingDefaults },
          sessionId,
        );
      },
    },

    mcp: {
      registerTool(def: PluginToolDef) {
        requireCap('mcp-tools');
        ensureLive();
        if (!def || typeof def.name !== 'string' || def.name.length === 0) {
          throw new Error('plugin tool def must have a non-empty name');
        }
        return disposables.add(need(deps.toolRegistry, 'mcp').register(name, def, guard));
      },
    },

    http: {
      createRouter(): Router {
        // Use the SERVER's express so the router mounts cleanly (no version skew).
        return express.Router();
      },
      registerRouter(router: Router) {
        requireCap('http-routes');
        ensureLive();
        return disposables.add(
          need(deps.httpRegistry, 'http').registerRouter(name, router, guard),
        );
      },
      registerPublicRouter(router: Router) {
        requireCap('http-public');
        ensureLive();
        return disposables.add(
          need(deps.httpRegistry, 'http').registerPublicRouter(name, router, guard),
        );
      },
    },

    notify: {
      async send(input) {
        requireCap('notify');
        ensureLive();
        await need(deps.notifier, 'notify').notify(input);
      },
      async custom(input) {
        requireCap('notify');
        ensureLive();
        // Validate BEFORE reaching the notifier — a bad input is the plugin's
        // error (rejected), never a swallowed webhook failure.
        const { title, message, level } = customNotifySchema.parse(input);
        await need(deps.notifier, 'notify').notifyCustom({
          pluginName: name,
          title,
          message,
          level,
        });
      },
    },

    settings: {
      instance() {
        requireCap('settings-read');
        ensureLive();
        return need(deps.settingsStore, 'settings').get();
      },
    },

    agentAssets: {
      get basePath(): string {
        requireCap('agent-assets');
        ensureLive();
        if (deps.agentAssetsBasePath == null) {
          throw new PluginCapabilityError(
            `api.agentAssets.basePath is unavailable — plugin '${name}' declares no agentAssets.dir`,
          );
        }
        return deps.agentAssetsBasePath;
      },
    },

    host: {
      async exec(input) {
        requireCap('host-exec');
        ensureLive();
        // Validate BEFORE reaching the host — a malformed input (empty argv,
        // out-of-bounds timeout/output) is the plugin's error (rejected), not a
        // silent no-op. `hostExec` gates the transport (rejects under `local`).
        const parsed = hostExecSchema.parse(input);
        return await hostExec(need(deps.config, 'host'), parsed);
      },
      async spawnJob(input) {
        requireCap('host-exec');
        ensureLive();
        const parsed = hostJobSpawnSchema.parse(input);
        // `name` is the manifest-constrained plugin name — a safe path segment,
        // never plugin-supplied input, so the jobdir path cannot be injected.
        return await spawnHostJob(need(deps.config, 'host'), name, parsed);
      },
      async jobStatus(input) {
        requireCap('host-exec');
        ensureLive();
        const parsed = hostJobStatusSchema.parse(input);
        return await hostJobStatus(need(deps.config, 'host'), name, parsed);
      },
      async killJob(input) {
        requireCap('host-exec');
        ensureLive();
        const parsed = hostJobIdSchema.parse(input);
        await killHostJob(need(deps.config, 'host'), name, parsed);
      },
    },

    connectors: {
      register(type: string, provider: ChannelConnectorProvider) {
        requireCap('connectors');
        ensureLive();
        if (!type || typeof type !== 'string') {
          throw new Error('connector type must be a non-empty string');
        }
        const registry = need(deps.connectorRegistry, 'connectors');
        // Label + schema come from the manifest's `connectors[]` declaration for
        // this type (drives the UI form + role config validation). A registration
        // without a matching decl still works, defaulting the label to the type.
        const decl = deps.connectorDecls?.find((d) => d.type === type);
        const schema = decl?.schema != null ? parseConfigSchema(decl.schema) : null;
        const label = decl?.label ?? type;
        // Crash-isolate every provider callback: a throw/rejection in the plugin's
        // connector is charged to the quarantine counter, never a fatal escape.
        const guarded: ChannelConnectorProvider = {
          subscribeOrch: (cfg, s) =>
            Promise.resolve(
              guard('connector.subscribeOrch', () => provider.subscribeOrch(cfg, s))(),
            ).then(() => undefined),
          unsubscribeOrch: (orchId) =>
            Promise.resolve(
              guard('connector.unsubscribeOrch', () => provider.unsubscribeOrch(orchId))(),
            ).then(() => undefined),
          stopAll: () =>
            Promise.resolve(guard('connector.stopAll', () => provider.stopAll())()).then(
              () => undefined,
            ),
        };
        return disposables.add(registry.register(type, guarded, { label, schema }));
      },
    },
  };

  return api;
}

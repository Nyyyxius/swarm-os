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
  type SwarmPluginApi,
  type PluginCapability,
  type DisposableStore,
  type TeamView,
  type PluginToolDef,
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
  /** TZ for schedule.cron (config.scheduleTimezone). */
  scheduleTimezone?: string;
  /** Transport-aware base path for this plugin's agentAssets (or null). */
  agentAssetsBasePath?: string | null;
}

/** Throwing stand-in for a group not materialised in this milestone. */
function unavailableGroup(group: string): unknown {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        return () => {
          throw new PluginCapabilityError(
            `api.${group}.${String(prop)} is not materialised in this build`,
          );
        };
      },
    },
  );
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
      defineTable(): void {
        throw new PluginCapabilityError(
          `api.storage.defineTable is not materialised in this build (db-tables)`,
        );
      },
      prepare() {
        throw new PluginCapabilityError(
          `api.storage.prepare is not materialised in this build (db-tables)`,
        );
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
        const init: OrchestratorInit = {
          name: spec.name,
          role: role?.label ?? 'plugin',
          roleId: role?.id ?? null,
          defaultModel: role?.defaultModel ?? cfg.defaultModel,
          defaultEffort: (role?.defaultEffort as EffortLevel | null) ?? cfg.defaultEffort,
          defaultPermissionMode:
            (role?.defaultPermissionMode as PermissionMode | null) ?? cfg.defaultPermissionMode,
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

    // ---- Not materialised until J4 (declared for author compile-compat) ----
    connectors: unavailableGroup('connectors') as SwarmPluginApi['connectors'],
  };

  return api;
}

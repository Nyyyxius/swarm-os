/**
 * `buildPluginApi` — materialises the `SwarmPluginApi` object handed to a
 * plugin's `activate()`.
 *
 * J1 materialises a REDUCED surface: `pluginName`, `log`, `zod`, `config.get`
 * / `config.onChange`, `storage.kv`, `events.on/emit`, `schedule.interval`.
 * The remaining groups are declared by the type but throw a clear
 * `PluginCapabilityError` until J2–J4 wire them.
 *
 * Two cross-cutting guarantees:
 *  - **Capability gating** — every materialised method checks `granted`
 *    (already `manifest ∩ operator-granted`); a non-granted access throws
 *    `PluginCapabilityError` with a legible message.
 *  - **Epoch token** — value-returning methods reached through a stale epoch
 *    (a tick still in flight after `disable()`) throw `PluginDisabledError`,
 *    which `guard()` swallows without charging the crash counter. Registered
 *    callbacks are additionally wrapped by the host's `guard()`.
 */

import type { Logger } from 'pino';
import type { z } from 'zod';
import type { SwarmEvent, SwarmEventKind } from '../../events.js';
import type { PluginStore } from './store.js';
import {
  type SwarmPluginApi,
  type PluginCapability,
  type DisposableStore,
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

export function buildPluginApi(
  deps: PluginApiDeps,
  name: string,
  disposables: DisposableStore,
  epoch: number,
): SwarmPluginApi {
  const { store, eventBus, log, zod, granted, guard } = deps;

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
      cron() {
        throw new PluginCapabilityError(
          `api.schedule.cron is not materialised in this build`,
        );
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

    // ---- Not materialised in J1 (declared for author compile-compat) ------
    teams: unavailableGroup('teams') as SwarmPluginApi['teams'],
    roles: unavailableGroup('roles') as SwarmPluginApi['roles'],
    messaging: unavailableGroup('messaging') as SwarmPluginApi['messaging'],
    mcp: unavailableGroup('mcp') as SwarmPluginApi['mcp'],
    http: unavailableGroup('http') as SwarmPluginApi['http'],
    notify: unavailableGroup('notify') as SwarmPluginApi['notify'],
    connectors: unavailableGroup('connectors') as SwarmPluginApi['connectors'],
    settings: unavailableGroup('settings') as SwarmPluginApi['settings'],
  };

  return api;
}

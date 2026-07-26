/**
 * PluginHost — lifecycle + crash-isolation for in-process plugins.
 *
 * Responsibilities:
 *  - enable / disable / reload / setPermissions / setConfig / uninstall / scan
 *  - activateEnabled() at boot, deactivateAll() at shutdown
 *  - guard(): wraps EVERY plugin callback (sync AND async) so a throw or a
 *    rejected promise is charged to a crash counter instead of killing the
 *    server (uncaughtException is FATAL here; unhandledRejection is log-only,
 *    so an un-caught async rejection would bypass quarantine entirely).
 *  - epoch tokens: a tick still in flight after disable() raises a benign
 *    PluginDisabledError (swallowed, uncounted) rather than a silent no-op.
 *  - quarantine: ≥5 crashes / 60 s → auto-disable + persisted exponential
 *    backoff; boot skips a plugin whose quarantine window is still open.
 *
 * Serialisation: a promise-lock per plugin name (via a `PluginLockRegistry`
 * that can be SHARED with the future PluginInstaller) makes enable/disable/
 * reload/uninstall mutually exclusive per name.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { z } from 'zod';
import { withModule } from '../../logger.js';
import type { SwarmEventBus } from '../../events.js';
import { PluginStore, type PluginRow } from './store.js';
import { loadManifest, HOST_API_VERSION, type PluginManifest, type UiPanel } from './manifest.js';
import { loadPluginModule } from './loader.js';
import { buildPluginApi, type PluginGuard } from './api.js';
import { withTimeout, isThenable, swapPluginDir } from './util.js';
import type { PluginToolRegistry } from './mcp-registry.js';
import type { PluginHttpRegistry } from './http-registry.js';
import type { ConnectorRegistry } from './connector-registry.js';
import {
  agentAssetsBasePath,
  copyAgentAssets,
  removeAgentAssets,
} from './agent-assets.js';
import type { Spawner } from '../spawner/index.js';
import type { RoleStore } from '../roles/index.js';
import type { SettingsStore } from '../settings/index.js';
import type { Config } from '../../config.js';
// Type-only, and it stays that way: `listOrigins()` below is the projection the
// update detector asks the wiring for. Nothing from `modules/updates` is
// imported at runtime, so the two modules still link in one direction only.
import type { PluginOrigin } from '../updates/plugins-check.js';
import {
  DisposableStore,
  PluginDisabledError,
  type SwarmPlugin,
  type PluginView,
  type PluginRuntimeStatus,
  type PluginCapability,
} from './api-types.js';

const log = withModule('plugins.host');

// Timeouts / thresholds (plan §PluginHost).
const ACTIVATE_TIMEOUT_MS = 10_000;
const DEACTIVATE_TIMEOUT_MS = 5_000;
const CRASH_LIMIT = 5;
const CRASH_WINDOW_MS = 60_000;
const QUARANTINE_BASE_MS = 30_000;
const QUARANTINE_CAP_MS = 60 * 60_000;

/** Sentinel `last_error` set by scan when a plugin's folder disappears. */
export const FOLDER_GONE = 'plugin folder disappeared';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PluginNotFoundError extends Error {
  constructor(name: string) {
    super(`plugin '${name}' not found`);
    this.name = 'PluginNotFoundError';
  }
}

/** Thrown by enable/reload on activation failure; carries the current view. */
export class PluginActivationError extends Error {
  constructor(
    message: string,
    readonly view: PluginView,
  ) {
    super(message);
    this.name = 'PluginActivationError';
  }
}

/** A validated staged folder handed to `PluginHost.commitInstall`. */
export interface CommitInstallInput {
  name: string;
  /** `.staging/<uuid>` — moved into `<pluginsDir>/<name>` under the lock. */
  stagingDir: string;
  sourceKind: string;
  sourceRef: string | null;
  /** git HEAD of the fetched source; null when the source has no commit. */
  sourceCommit: string | null;
  version: string;
  apiVersion: number;
  /** The new manifest's declared capabilities (for the new-capability gap). */
  manifestCaps: PluginCapability[];
}

export interface CommitInstallResult {
  view: PluginView;
  isUpgrade: boolean;
  /** Manifest capabilities not covered by the prior grant — need UI approval. */
  newCapabilities: PluginCapability[];
}

// ---------------------------------------------------------------------------
// Lock registry (shareable with the future installer)
// ---------------------------------------------------------------------------

/**
 * Serial promise-queue keyed by plugin name. `run` chains onto the previous
 * op for that key so mutations never overlap; the stored tail swallows errors
 * so one failed op doesn't wedge the queue (the caller still sees the real
 * rejection via the returned promise).
 */
export class PluginLockRegistry {
  private readonly chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const result = prev.then(() => fn());
    this.chains.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

interface ActiveInstance {
  epoch: number;
  disposables: DisposableStore;
  module: SwarmPlugin;
  onConfigChange: Array<(next: unknown) => void>;
}

export interface PluginHostDeps {
  store: PluginStore;
  eventBus: SwarmEventBus;
  /** `<dataDir>/plugins`. */
  pluginsDir: string;
  /** The server's zod instance (plugins must use api.zod for MCP schemas). */
  zod: typeof z;
  /**
   * Injected for J2's roles façade (mirrors startServer's onRolesChanged =
   * () => scheduler.reload()). Accepted now so the wiring is stable.
   */
  onRolesChanged?: () => void;

  // ---- J2 deps (optional so J1 host tests still construct the host) --------
  /** Spawner — backs the teams + messaging façades. */
  spawner?: Spawner;
  /** RoleStore — backs the roles façade. */
  roleStore?: RoleStore;
  /** SettingsStore — backs the settings façade. */
  settingsStore?: SettingsStore;
  /** Server config — cwd validation, workspaceRoot, TZ, messaging defaults. */
  config?: Config;
  /** MCP tool registry consulted per-request by McpServer.handle(). */
  toolRegistry?: PluginToolRegistry;
  /** HTTP router registry consulted per-request by the main.ts dispatchers. */
  httpRegistry?: PluginHttpRegistry;
  /** J4 — connector registry backing api.connectors.register + wireConnectors. */
  connectorRegistry?: ConnectorRegistry;
  /**
   * Broadcast an informative line to every active team's lead — used to signal
   * a plugin's MCP tool set changed (already-running sessions only see new
   * tools at restart; transport is stateless). Wired in index.ts to the
   * external-origin broadcast helper.
   */
  broadcastToLeads?: (from: string, content: string) => void;

  /** Shared lock registry (defaults to a private one). */
  locks?: PluginLockRegistry;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Override activate/deactivate timeouts (tests use short values). */
  timeouts?: { activateMs?: number; deactivateMs?: number };
  /** Override the ESM loader (tests inject fakes; defaults to loadPluginModule). */
  loadModule?: (pluginDir: string, main: string, version: string) => Promise<SwarmPlugin>;
}

export class PluginHost {
  private readonly store: PluginStore;
  private readonly eventBus: SwarmEventBus;
  private readonly pluginsDir: string;
  private readonly zod: typeof z;
  private readonly onRolesChanged?: () => void;
  private readonly spawner?: Spawner;
  private readonly roleStore?: RoleStore;
  private readonly settingsStore?: SettingsStore;
  private readonly config?: Config;
  private readonly toolRegistry?: PluginToolRegistry;
  private readonly httpRegistry?: PluginHttpRegistry;
  private readonly connectorRegistry?: ConnectorRegistry;
  private readonly broadcastToLeads?: (from: string, content: string) => void;
  private readonly locks: PluginLockRegistry;
  private readonly clock: () => number;
  private readonly activateTimeoutMs: number;
  private readonly deactivateTimeoutMs: number;
  private readonly loadModule: (
    pluginDir: string,
    main: string,
    version: string,
  ) => Promise<SwarmPlugin>;

  private readonly active = new Map<string, ActiveInstance>();
  private readonly epochs = new Map<string, number>();
  private readonly crashWindows = new Map<string, number[]>();
  /** Names in the live 'crashed' status (re-derives as 'quarantined' after reboot). */
  private readonly crashedNames = new Set<string>();

  constructor(deps: PluginHostDeps) {
    this.store = deps.store;
    this.eventBus = deps.eventBus;
    this.pluginsDir = deps.pluginsDir;
    this.zod = deps.zod;
    this.onRolesChanged = deps.onRolesChanged;
    this.spawner = deps.spawner;
    this.roleStore = deps.roleStore;
    this.settingsStore = deps.settingsStore;
    this.config = deps.config;
    this.toolRegistry = deps.toolRegistry;
    this.httpRegistry = deps.httpRegistry;
    this.connectorRegistry = deps.connectorRegistry;
    this.broadcastToLeads = deps.broadcastToLeads;
    this.locks = deps.locks ?? new PluginLockRegistry();
    this.clock = deps.now ?? Date.now;
    this.activateTimeoutMs = deps.timeouts?.activateMs ?? ACTIVATE_TIMEOUT_MS;
    this.deactivateTimeoutMs = deps.timeouts?.deactivateMs ?? DEACTIVATE_TIMEOUT_MS;
    this.loadModule = deps.loadModule ?? loadPluginModule;
  }

  /** Exposed so the future installer can share the same per-name lock. */
  get lockRegistry(): PluginLockRegistry {
    return this.locks;
  }

  private now(): number {
    return this.clock();
  }

  // ---- crash isolation ---------------------------------------------------

  /**
   * Wrap a plugin callback so throws (sync) AND rejections (async) are charged
   * to the crash counter instead of escaping. Bound to the plugin's activation
   * epoch: once the epoch moves on (disable/reload), the wrapped callback is a
   * benign no-op and any late error is not counted.
   */
  guard<A extends unknown[]>(
    name: string,
    hook: string,
    fn: (...args: A) => unknown,
  ): (...args: A) => unknown {
    const boundEpoch = this.epochs.get(name) ?? 0;
    return (...args: A): unknown => {
      // Stale epoch: the plugin was disabled/reloaded. Don't run the callback,
      // don't charge a crash — this is the benign "tick in flight" case.
      if ((this.epochs.get(name) ?? 0) !== boundEpoch) return undefined;
      try {
        const r = fn(...args);
        if (isThenable(r)) {
          return Promise.resolve(r).then(undefined, (err: unknown) =>
            this.onGuardError(name, hook, err, boundEpoch),
          );
        }
        return r;
      } catch (err) {
        this.onGuardError(name, hook, err, boundEpoch);
        return undefined;
      }
    };
  }

  private onGuardError(name: string, hook: string, err: unknown, boundEpoch: number): void {
    // ⚠️ Last line of defence: this runs inside guard()'s catch (sync path)
    // and as a promise rejection handler (async path). If IT throws — e.g. a
    // SQLite write error in store.patch on a full disk — the sync path would
    // escape into a timer (fatal uncaughtException) and the async path would
    // become an unhandled rejection (quarantine bypass). So the whole body is
    // wrapped: crash accounting may degrade, never escalate.
    try {
      // Benign: a stale-epoch façade call. Swallow, never count.
      if (err instanceof PluginDisabledError) return;
      // Raced a disable/reload between invocation and settle — don't count.
      if ((this.epochs.get(name) ?? 0) !== boundEpoch) return;

      const msg = err instanceof Error ? err.message : String(err);
      log.error({ event: 'plugins.crash', name, hook, error: msg });
      this.store.patch(name, { last_error: `[${hook}] ${msg}` });

      const now = this.now();
      const win = (this.crashWindows.get(name) ?? []).filter((t) => now - t <= CRASH_WINDOW_MS);
      win.push(now);
      this.crashWindows.set(name, win);

      if (win.length >= CRASH_LIMIT) {
        this.crashWindows.set(name, []);
        this.autoDisable(name, msg, boundEpoch).catch((e: unknown) => {
          log.error({
            event: 'plugins.auto_disable_failed',
            name,
            error: e instanceof Error ? e.message : String(e),
          });
        });
      }
      // A transient (sub-threshold) crash does NOT emit plugin.host.changed:
      // the status is unchanged (still 'enabled'), the UI's poll picks up
      // last_error, and — crucially — emitting here would feed a plugin
      // subscribed to '*' whose handler throws, cascading crashes back into
      // itself. Only the status-flipping auto-disable emits.
    } catch (accountingErr) {
      try {
        log.error({
          event: 'plugins.crash_accounting_failed',
          name,
          hook,
          error: accountingErr instanceof Error ? accountingErr.message : String(accountingErr),
        });
      } catch {
        /* nothing left that can safely run */
      }
    }
  }

  private async autoDisable(name: string, reason: string, crashEpoch: number): Promise<void> {
    await this.locks.run(name, async () => {
      const inst = this.active.get(name);
      // Bail if the plugin was torn down, or if the live instance is a NEWER
      // activation than the one that crashed (a reload/enable slipped in
      // between the crash count and this lock) — never punish a fresh
      // activation for its predecessor's crashes.
      if (!inst || inst.epoch !== crashEpoch) return;
      log.error({ event: 'plugins.auto_disable', name, reason });
      await this.deactivateInstance(name, inst);
      const row = this.store.get(name);
      const failCount = (row?.fail_count ?? 0) + 1;
      // enabled stays 1 (operator intent); runtime status is 'crashed' now and
      // re-derives as 'quarantined' after a reboot so boot skips the crash loop.
      this.store.patch(name, {
        fail_count: failCount,
        quarantined_until: this.quarantineUntil(failCount),
        last_error: `crash-loop (${CRASH_LIMIT} in ${CRASH_WINDOW_MS / 1000}s): ${reason}`,
      });
      this.crashedNames.add(name);
      this.emitChanged(name);
    });
  }

  // ---- activation core (must be called under the per-name lock) ----------

  private async activateInstance(
    name: string,
    manifest: PluginManifest,
    grantedCaps: PluginCapability[],
  ): Promise<void> {
    const existing = this.active.get(name);
    if (existing) await this.deactivateInstance(name, existing);

    const epoch = this.epochs.get(name) ?? 0;
    this.epochs.set(name, epoch);

    const disposables = new DisposableStore((err) =>
      log.warn({
        event: 'plugins.dispose_failed',
        name,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    const onConfigChange: Array<(next: unknown) => void> = [];
    const boundGuard: PluginGuard = <A extends unknown[]>(
      hook: string,
      fn: (...args: A) => unknown,
    ) => this.guard<A>(name, hook, fn);

    const assetsBasePath =
      this.config && manifest.agentAssets
        ? agentAssetsBasePath(this.config, name)
        : null;

    const api = buildPluginApi(
      {
        store: this.store,
        eventBus: this.eventBus,
        log: withModule(`plugin.${name}`),
        zod: this.zod,
        granted: new Set(grantedCaps),
        guard: boundGuard,
        currentEpoch: () => this.epochs.get(name) ?? 0,
        onConfigChange,
        // J2 façades.
        spawner: this.spawner,
        roleStore: this.roleStore,
        settingsStore: this.settingsStore,
        notifier: this.spawner?.notifier,
        config: this.config,
        onRolesChanged: this.onRolesChanged,
        toolRegistry: this.toolRegistry,
        httpRegistry: this.httpRegistry,
        connectorRegistry: this.connectorRegistry,
        connectorDecls: manifest.connectors,
        scheduleTimezone: this.config?.scheduleTimezone,
        agentAssetsBasePath: assetsBasePath,
      },
      name,
      disposables,
      epoch,
    );

    const pluginDir = path.join(this.pluginsDir, name);
    let mod: SwarmPlugin;
    try {
      mod = await this.loadModule(pluginDir, manifest.main, manifest.version);
      await withTimeout(
        Promise.resolve().then(() => mod.activate(api)),
        this.activateTimeoutMs,
        `activate(${name})`,
      );
    } catch (err) {
      // Partial activation — release whatever was registered, then rethrow.
      disposables.disposeAll();
      throw err;
    }
    this.active.set(name, { epoch, disposables, module: mod, onConfigChange });
    this.crashedNames.delete(name);
  }

  private async deactivateInstance(name: string, inst: ActiveInstance): Promise<void> {
    // Bump the epoch FIRST so any in-flight tick becomes a benign no-op.
    this.epochs.set(name, inst.epoch + 1);
    this.active.delete(name);
    inst.onConfigChange.length = 0;
    if (inst.module.deactivate) {
      try {
        await withTimeout(
          Promise.resolve().then(() => inst.module.deactivate?.()),
          this.deactivateTimeoutMs,
          `deactivate(${name})`,
        );
      } catch (err) {
        log.warn({
          event: 'plugins.deactivate_failed',
          name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Reverse-order teardown of everything acquired through the API.
    inst.disposables.disposeAll();
  }

  /**
   * Shared enable/reload body (assumes the per-name lock is held). Resolves the
   * granted set, activates, persists success — or records the failure and
   * throws `PluginActivationError`.
   */
  private async doEnable(
    name: string,
    row: PluginRow,
    requestedCaps?: string[],
  ): Promise<PluginView> {
    let manifest: PluginManifest;
    try {
      manifest = loadManifest(path.join(this.pluginsDir, name));
    } catch (err) {
      return this.recordActivationFailure(name, row, err);
    }
    if (manifest.apiVersion > HOST_API_VERSION) {
      return this.recordActivationFailure(
        name,
        row,
        new Error(`apiVersion ${manifest.apiVersion} exceeds host ${HOST_API_VERSION}`),
      );
    }

    const requested = requestedCaps ?? this.parseGranted(row) ?? manifest.capabilities;
    // Grant is always a subset of what the manifest declares.
    const grantedCaps = manifest.capabilities.filter((c) => requested.includes(c));
    this.store.patch(name, { granted_capabilities_json: JSON.stringify(grantedCaps) });

    try {
      await this.activateInstance(name, manifest, grantedCaps);
    } catch (err) {
      return this.recordActivationFailure(name, this.store.get(name) ?? row, err);
    }

    // Copy agentAssets into the workspace (best-effort — never fails enable).
    this.syncAgentAssets(name, manifest, grantedCaps);

    this.store.patch(name, {
      enabled: 1,
      fail_count: 0,
      quarantined_until: null,
      last_error: null,
    });
    this.crashedNames.delete(name);
    // Reset the in-memory crash window too: crashes of the PREVIOUS activation
    // must not count against this fresh one (else a fixed-and-reloaded plugin
    // could be auto-disabled after a single new crash).
    this.crashWindows.delete(name);
    this.emitChanged(name);
    // Signal leads if this plugin exposes MCP tools (already-running sessions
    // only pick them up at restart — transport is stateless).
    this.notifyToolSetChanged(name, true);
    return this.viewOf(name);
  }

  /**
   * Copy (or remove) a plugin's `agentAssets` dir into the workspace. Requires
   * the `agent-assets` capability to be granted AND a config to resolve the
   * workspace root. Best-effort: logged, never fatal to enable.
   */
  private syncAgentAssets(
    name: string,
    manifest: PluginManifest,
    grantedCaps: PluginCapability[],
  ): void {
    if (!this.config) return;
    if (!manifest.agentAssets || !grantedCaps.includes('agent-assets')) {
      // No (longer any) assets — clean up a prior copy.
      removeAgentAssets(this.config, name);
      return;
    }
    copyAgentAssets(
      this.config,
      path.join(this.pluginsDir, name),
      name,
      manifest.agentAssets.dir,
    );
  }

  /**
   * Notify every active team's lead that a plugin's MCP tool set changed. Only
   * fires when the plugin actually has registered tools (enable) or had them
   * (disable). No-op without a `broadcastToLeads` wiring.
   */
  private notifyToolSetChanged(name: string, enabled: boolean): void {
    if (!this.broadcastToLeads) return;
    if (!this.toolRegistry?.has(name)) return;
    const verb = enabled
      ? 'are now available'
      : 'have been removed';
    const msg =
      `[swarm-os] Plugin '${name}' MCP tools ${verb}. ` +
      `Restart or resume your session to refresh the available tools.`;
    try {
      this.broadcastToLeads(`plugin:${name}`, msg);
    } catch (err) {
      log.warn({
        event: 'plugins.tool_notify_failed',
        name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private recordActivationFailure(name: string, row: PluginRow, err: unknown): never {
    const msg = err instanceof Error ? err.message : String(err);
    const failCount = (row.fail_count ?? 0) + 1;
    // A one-shot activation failure surfaces as status 'error' (last_error).
    // We do NOT set quarantined_until here — quarantine is the RUNTIME
    // crash-loop cool-off (red-team I2, applied in autoDisable) — and we CLEAR
    // any prior window: an operator-initiated retry that fails must show the
    // fresh error, not stay masked as 'quarantined' by the previous crash-loop.
    this.store.patch(name, {
      last_error: msg,
      fail_count: failCount,
      quarantined_until: null,
    });
    this.crashedNames.delete(name);
    log.warn({ event: 'plugins.enable_failed', name, error: msg });
    const view = this.viewOf(name);
    this.emitChanged(name);
    throw new PluginActivationError(msg, view);
  }

  // ---- public lifecycle --------------------------------------------------

  async enable(name: string, grantedCapabilities?: string[]): Promise<PluginView> {
    return this.locks.run(name, async () => {
      const row = this.store.get(name);
      if (!row) throw new PluginNotFoundError(name);
      return this.doEnable(name, row, grantedCapabilities);
    });
  }

  async disable(name: string): Promise<PluginView> {
    return this.locks.run(name, async () => {
      const row = this.store.get(name);
      if (!row) throw new PluginNotFoundError(name);
      // Capture BEFORE teardown — disposables remove the tools from the registry.
      const hadTools = this.toolRegistry?.has(name) ?? false;
      const inst = this.active.get(name);
      if (inst) await this.deactivateInstance(name, inst);
      // Remove copied agentAssets from the workspace.
      if (this.config) removeAgentAssets(this.config, name);
      this.store.patch(name, { enabled: 0, quarantined_until: null, last_error: null });
      this.crashedNames.delete(name);
      this.crashWindows.delete(name);
      this.emitChanged(name);
      if (hadTools && this.broadcastToLeads) {
        try {
          this.broadcastToLeads(
            `plugin:${name}`,
            `[swarm-os] Plugin '${name}' MCP tools have been removed. ` +
              `Restart or resume your session to refresh the available tools.`,
          );
        } catch (err) {
          log.warn({
            event: 'plugins.tool_notify_failed',
            name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return this.viewOf(name);
    });
  }

  /** Hot restart (used after a permissions/config change on an active plugin). */
  async reload(name: string): Promise<PluginView> {
    return this.locks.run(name, async () => {
      const row = this.store.get(name);
      if (!row) throw new PluginNotFoundError(name);
      return this.doEnable(name, row);
    });
  }

  async setPermissions(name: string, caps: string[]): Promise<PluginView> {
    return this.locks.run(name, async () => {
      const row = this.store.get(name);
      if (!row) throw new PluginNotFoundError(name);
      if (this.active.has(name)) {
        // Hot-restart with the new grant.
        return this.doEnable(name, row, caps);
      }
      // Not active — persist the intersection with the declared capabilities.
      let declared: PluginCapability[] = [];
      try {
        declared = loadManifest(path.join(this.pluginsDir, name)).capabilities;
      } catch {
        declared = [];
      }
      const grantedCaps = declared.filter((c) => caps.includes(c));
      this.store.patch(name, { granted_capabilities_json: JSON.stringify(grantedCaps) });
      this.emitChanged(name);
      return this.viewOf(name);
    });
  }

  async setConfig(name: string, config: unknown): Promise<PluginView> {
    return this.locks.run(name, async () => {
      const row = this.store.get(name);
      if (!row) throw new PluginNotFoundError(name);
      this.store.patch(name, { config_json: JSON.stringify(config ?? {}) });
      const inst = this.active.get(name);
      if (inst) {
        if (inst.onConfigChange.length > 0) {
          // The plugin opted into live config updates — notify (already guarded).
          for (const cb of [...inst.onConfigChange]) cb(config);
        } else {
          // No subscriber — hot-restart so activate() re-reads config.get().
          return this.doEnable(name, this.store.get(name) ?? row);
        }
      }
      this.emitChanged(name);
      return this.viewOf(name);
    });
  }

  /**
   * Uninstall (red-team I-9): under the per-name lock — disable if active →
   * remove the copied agentAssets → `fs.rm` the plugin folder → drop the row.
   * `purge=true` additionally drops the plugin's kv, its `config_json` (on the
   * row) AND every private `plugin_<name'>_*` table/index/trigger in one
   * transaction (red-team I-6/I-7) so a later reinstall of the same name starts
   * clean. Without `purge`, kv + private tables are LEFT in place (preserved
   * for a re-drop of the same name).
   */
  async uninstall(name: string, purge = false): Promise<void> {
    return this.locks.run(name, async () => {
      const inst = this.active.get(name);
      if (inst) await this.deactivateInstance(name, inst);
      if (this.config) removeAgentAssets(this.config, name);
      const dir = path.join(this.pluginsDir, name);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        log.warn({
          event: 'plugins.uninstall_rm_failed',
          name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (purge) this.store.purgeAndDelete(name);
      else this.store.delete(name);
      this.crashedNames.delete(name);
      this.crashWindows.delete(name);
      this.eventBus.emitEvent({
        kind: 'plugin.host.changed',
        payload: { name, status: 'disabled', enabled: false },
      });
    });
  }

  /**
   * Commit a staged install/upgrade (called by the PluginInstaller AFTER it has
   * fetched + `npm install`ed + validated a plugin under `.staging/<uuid>`).
   *
   * Runs entirely under the per-name lock SHARED with the installer (red-team
   * I-8): a concurrent enable/disable/reload is serialised behind it, so it can
   * never `import()` a half-swapped tree. Sequence — tear down the running
   * instance (if any) → swap the folder on disk → persist the row → re-activate
   * an upgraded plugin that was running, granting ONLY the prior intersection
   * (new manifest capabilities stay ungranted; they are returned for the UI to
   * re-present for approval).
   */
  async commitInstall(input: CommitInstallInput): Promise<CommitInstallResult> {
    const { name, stagingDir } = input;
    return this.locks.run(name, async () => {
      const existing = this.store.get(name);
      const isUpgrade = !!existing;
      const wasActive = this.active.has(name);
      const prevGranted = existing ? (this.parseGranted(existing) ?? []) : [];

      // 1. Tear down the running instance BEFORE touching the disk.
      if (wasActive) {
        const inst = this.active.get(name);
        if (inst) await this.deactivateInstance(name, inst);
        if (this.config) removeAgentAssets(this.config, name);
      }

      // 2. Swap the code into place (same-device rename, EXDEV → copy fallback).
      swapPluginDir(this.pluginsDir, name, stagingDir);

      // 3. Persist the row.
      const now = new Date().toISOString();
      if (isUpgrade) {
        this.store.patch(name, {
          version: input.version,
          source_kind: input.sourceKind,
          source_ref: input.sourceRef,
          source_commit: input.sourceCommit,
          api_version: input.apiVersion,
        });
      } else {
        this.store.upsert({
          name,
          version: input.version,
          source_kind: input.sourceKind,
          source_ref: input.sourceRef,
          source_commit: input.sourceCommit,
          enabled: 0,
          config_json: null,
          granted_capabilities_json: null,
          api_version: input.apiVersion,
          fail_count: 0,
          quarantined_until: null,
          installed_at: now,
          updated_at: now,
          last_error: null,
        });
      }

      // Capabilities the new manifest wants that the prior grant didn't cover.
      const newCapabilities = input.manifestCaps.filter((c) => !prevGranted.includes(c));

      // 4. Re-activate an upgraded-and-running plugin with the PRIOR grant only
      //    (doEnable ∩'s it against the new manifest). A failure surfaces as a
      //    PluginActivationError (→ 422); the new code is already on disk and
      //    the row shows enabled + last_error.
      if (wasActive) {
        const fresh = this.store.get(name);
        if (fresh) await this.doEnable(name, fresh, prevGranted);
      } else {
        this.emitChanged(name);
      }
      return { view: this.viewOf(name), isUpgrade, newCapabilities };
    });
  }

  /**
   * Discover new folders under `<pluginsDir>` (skipping dotfiles like
   * `.staging`) and register them; mark rows whose folder vanished as
   * `error` + `enabled=0` WITHOUT deleting the row (preserves config for a
   * later re-drop).
   */
  async scan(): Promise<PluginView[]> {
    return this.locks.run('\0scan', async () => {
      const found = new Set<string>();
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(this.pluginsDir, { withFileTypes: true });
      } catch {
        entries = [];
      }
      const now = new Date().toISOString();
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        if (ent.name.startsWith('.')) continue; // .staging and friends
        const dir = path.join(this.pluginsDir, ent.name);
        let manifest: PluginManifest;
        try {
          manifest = loadManifest(dir);
        } catch (err) {
          log.warn({
            event: 'plugins.scan_invalid',
            dir: ent.name,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        if (manifest.name !== ent.name) {
          log.warn({
            event: 'plugins.scan_name_mismatch',
            dir: ent.name,
            manifestName: manifest.name,
          });
          continue;
        }
        found.add(manifest.name);
        const existing = this.store.get(manifest.name);
        if (existing) {
          this.store.patch(manifest.name, {
            version: manifest.version,
            api_version: manifest.apiVersion,
            // Clear a stale "folder disappeared" flag now that it's back.
            last_error: existing.last_error === FOLDER_GONE ? null : existing.last_error,
          });
        } else {
          this.store.upsert({
            name: manifest.name,
            version: manifest.version,
            source_kind: 'dir',
            source_ref: dir,
            // A folder that just appeared on disk has no traceable origin.
            source_commit: null,
            enabled: 0,
            config_json: null,
            granted_capabilities_json: null,
            api_version: manifest.apiVersion,
            fail_count: 0,
            quarantined_until: null,
            installed_at: now,
            updated_at: now,
            last_error: null,
          });
        }
      }
      // Rows whose folder disappeared → error + disabled (keep the row).
      for (const row of this.store.list()) {
        if (found.has(row.name)) continue;
        await this.locks.run(row.name, async () => {
          const inst = this.active.get(row.name);
          if (inst) await this.deactivateInstance(row.name, inst);
          this.store.patch(row.name, { enabled: 0, last_error: FOLDER_GONE });
          this.emitChanged(row.name);
        });
      }
      this.eventBus.emitEvent({
        kind: 'plugin.host.changed',
        payload: { name: '*', status: 'scan', enabled: false },
      });
      return this.list();
    });
  }

  // ---- boot / shutdown ---------------------------------------------------

  /**
   * Boot: activate every enabled plugin, each in its OWN try/catch (including
   * the import) so one corrupt plugin never aborts the boot chain — this MUST
   * NOT reject (the chain's `.catch` in index.ts is fatal). Plugins with an
   * open quarantine window are skipped.
   */
  async activateEnabled(): Promise<void> {
    // The no-reject contract is structural: the whole body is wrapped, not just
    // the per-plugin loop (store.listEnabled is no-throw by construction, but
    // the fatal boot .catch must not hinge on that staying true).
    try {
      const rows = this.store.listEnabled();
      const now = this.now();
      for (const row of rows) {
        try {
          if (row.quarantined_until && Date.parse(row.quarantined_until) > now) {
            log.warn({
              event: 'plugins.boot_skip_quarantined',
              name: row.name,
              until: row.quarantined_until,
            });
            continue;
          }
          await this.locks.run(row.name, async () => {
            const fresh = this.store.get(row.name) ?? row;
            await this.doEnable(row.name, fresh);
          });
        } catch (err) {
          // doEnable throws PluginActivationError on failure — swallow so boot
          // proceeds (already persisted status='error' + last_error).
          log.warn({
            event: 'plugins.boot_activate_failed',
            name: row.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      log.info({ event: 'plugins.boot_activated', active: this.active.size, enabled: rows.length });
    } catch (err) {
      log.error({
        event: 'plugins.boot_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Shutdown: tear every active plugin down (does NOT flip enabled). */
  async deactivateAll(): Promise<void> {
    const names = [...this.active.keys()];
    for (const name of names) {
      try {
        await this.locks.run(name, async () => {
          const inst = this.active.get(name);
          if (inst) await this.deactivateInstance(name, inst);
        });
      } catch (err) {
        log.warn({
          event: 'plugins.deactivate_all_failed',
          name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ---- views -------------------------------------------------------------

  list(): PluginView[] {
    return this.store.list().map((row) => this.viewOfRow(row));
  }

  viewOf(name: string): PluginView {
    const row = this.store.get(name);
    if (!row) throw new PluginNotFoundError(name);
    return this.viewOfRow(row);
  }

  /**
   * Installed plugins projected into the update detector's own narrow origin
   * type — `modules/updates/plugins-check.ts` declares `PluginOrigin` itself
   * precisely so detection never depends on the `plugins` table's storage
   * shape. Someone still has to translate, and this class is already the single
   * place in the codebase that turns a snake_case row into a public shape
   * (`viewOfRow`). Doing it in `index.ts` instead would teach the boot file the
   * column names of a table it doesn't own.
   *
   * NOT `list()`: `PluginView` deliberately has no `sourceRef`, and the re-fetch
   * address is exactly what a `git ls-remote` / npm probe needs.
   *
   * Disabled plugins are included. A disabled row is still listed in the UI with
   * its version, and "enable it before we'll tell you it's outdated" is the kind
   * of surprise this feature exists to remove.
   */
  listOrigins(): PluginOrigin[] {
    return this.store.list().map((row) => ({
      name: row.name,
      version: row.version,
      sourceKind: row.source_kind,
      sourceRef: row.source_ref,
      // `?? null` guards a row from a DB where the ALTER didn't land — and the
      // detector reads a null commit as `unknown`, never as `available`.
      sourceCommit: row.source_commit ?? null,
    }));
  }

  /** True when a plugin is currently activated (for tests / diagnostics). */
  isActive(name: string): boolean {
    return this.active.has(name);
  }

  /** Raw stored config for a plugin (unredacted) — used by the config route. */
  getRawConfig(name: string): Record<string, unknown> {
    return this.store.getConfig(name);
  }

  private viewOfRow(row: PluginRow): PluginView {
    let capabilities: PluginCapability[] = [];
    let displayName: string | undefined;
    let uiPanels: UiPanel[] = [];
    try {
      const m = loadManifest(path.join(this.pluginsDir, row.name));
      capabilities = m.capabilities;
      displayName = m.displayName;
      // Panels are surfaced ONLY for an enabled plugin: a disabled plugin's
      // `/plugin-api/<name>/*` routes are torn down (404), so a nav entry would
      // dead-link. `m.uiPanels` is always an array (schema default []).
      if (row.enabled === 1) uiPanels = m.uiPanels;
    } catch {
      /* folder gone / invalid manifest — fall back to empty capabilities */
    }
    return {
      name: row.name,
      version: row.version,
      displayName,
      status: this.statusOf(row),
      enabled: row.enabled === 1,
      sourceKind: row.source_kind,
      // `?? null` guards a row read back from a DB where the ALTER didn't land:
      // emit an explicit null rather than dropping the key from the JSON.
      sourceCommit: row.source_commit ?? null,
      apiVersion: row.api_version,
      capabilities,
      grantedCapabilities: this.parseGranted(row),
      failCount: row.fail_count,
      quarantinedUntil: row.quarantined_until,
      lastError: row.last_error,
      installedAt: row.installed_at,
      updatedAt: row.updated_at,
      uiPanels,
    };
  }

  private statusOf(row: PluginRow): PluginRuntimeStatus {
    if (this.active.has(row.name)) return 'enabled';
    if (this.crashedNames.has(row.name)) return 'crashed';
    // Quarantine status only applies to a plugin the operator LEFT enabled
    // (crash auto-disable keeps enabled=1). A FAILED enable keeps enabled=0
    // and still records a backoff, but must surface as 'error', not
    // 'quarantined' — boot skips disabled rows regardless.
    if (
      row.enabled === 1 &&
      row.quarantined_until &&
      Date.parse(row.quarantined_until) > this.now()
    ) {
      return 'quarantined';
    }
    if (row.last_error) return 'error';
    return row.enabled === 1 ? 'error' : 'disabled';
  }

  private parseGranted(row: PluginRow): string[] | null {
    if (!row.granted_capabilities_json) return null;
    try {
      const p = JSON.parse(row.granted_capabilities_json) as unknown;
      return Array.isArray(p) ? (p as string[]) : null;
    } catch {
      return null;
    }
  }

  private quarantineUntil(failCount: number): string {
    const backoff = Math.min(
      QUARANTINE_CAP_MS,
      QUARANTINE_BASE_MS * 2 ** Math.max(0, failCount - 1),
    );
    return new Date(this.now() + backoff).toISOString();
  }

  private emitChanged(name: string): void {
    const row = this.store.get(name);
    if (!row) return;
    const view = this.viewOfRow(row);
    this.eventBus.emitEvent({
      kind: 'plugin.host.changed',
      payload: { name, status: view.status, enabled: view.enabled },
    });
  }
}

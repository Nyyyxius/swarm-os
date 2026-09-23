/**
 * FeatureRegistry — lifecycle for the six built-in features that become
 * enable/disable/uninstall-able like plugins (docs/builtin-features.md).
 *
 * ⚠️ Owns its OWN table `builtin_features` via `CREATE TABLE IF NOT EXISTS`
 * on the RAW `Database` handle (`SwarmDb.db`, a public field) — the SAME model
 * `PluginStore` uses (see its module header: the table is NEITHER in schema.sql
 * NOR INLINE_SCHEMA, because the inline fallback is what actually runs in the
 * Docker image and a double source is a trap). Keeping the DDL here sidesteps it.
 *
 * This module is the SOCLE (Lot 1): the descriptors registered by `index.ts`
 * are no-ops and every feature seeds `enabled`, so the app behaves exactly as
 * before. Later lots (3-8) mount the HTTP gate, the MCP `if`s and the preamble
 * markers that consume `isEnabled()` / `snapshot()`.
 *
 * Discipline (like every store here): NEVER stop the boot. Table creation and
 * the initial load are wrapped in try/catch; a registry that fails to open
 * fails OPEN — `isEnabled()` returns true for an unknown state, so the whole
 * app behaves as if everything is enabled (24/7 > crash-loop).
 */

import type { Database as Db } from 'better-sqlite3';
import { withModule } from '../../logger.js';
import type { SwarmDb } from '../db/index.js';
import type { Config } from '../../config.js';
import type { SwarmEventBus, FeatureChangedPayload } from '../../events.js';
import { PluginLockRegistry } from '../plugins/host.js';

const log = withModule('features');

/** The six built-in features managed as plugins. */
export type FeatureName = 'ide' | 'codegraph' | 'board' | 'memory' | 'monitoring' | 'approvals';

/** Tri-state lifecycle. `uninstalled` = disabled + data purged. */
export type FeatureState = 'enabled' | 'disabled' | 'uninstalled';

/** Canonical order — also the seed order and the reverse-of-shutdown order. */
export const FEATURE_NAMES: readonly FeatureName[] = [
  'ide',
  'codegraph',
  'board',
  'memory',
  'monitoring',
  'approvals',
];

/**
 * A built-in feature's lifecycle hooks. `start` arms jobs/supervisors and must
 * be idempotent and never throw; `stop` disarms and DRAINS in-flight work
 * (awaitable); `purge` DELETEs rows + rm's files — NEVER a DROP TABLE (the
 * stores keep their prepared statements valid, so a reinstall finds the store
 * already present and empty). In Lot 1 all three are no-ops.
 */
export interface FeatureDescriptor {
  name: FeatureName;
  displayName: string;
  description: string;
  start(): void;
  stop(): Promise<void> | void;
  purge(): Promise<void> | void;
}

/** What `list()` publishes per feature — the row plus its human labels. */
export interface FeatureView {
  name: FeatureName;
  displayName: string;
  description: string;
  state: FeatureState;
  updatedAt: string;
}

/** Row shape of the `builtin_features` table. */
interface FeatureRow {
  name: string;
  state: string;
  updated_at: string;
}

export interface FeatureRegistryDeps {
  /** Handle owner — the registry creates its table on `db.db` (like PluginStore). */
  db: SwarmDb;
  /** Event bus — `feature.changed` is emitted here on every verb. */
  eventBus: SwarmEventBus;
  /** Only `codegraphEnabled` / `ideEnabled` are read — for the FIRST-boot seed. */
  config: Pick<Config, 'codegraphEnabled' | 'ideEnabled'>;
  /**
   * Per-name serial queue for the async verbs. Shared with the plugin host in
   * production; a fresh one is minted when omitted (unit tests).
   */
  locks?: PluginLockRegistry;
  /**
   * Best-effort broadcast to every live lead on a toggle ("restart/resume to
   * refresh your tools"). Wired from `index.ts` to `broadcastToLeadsFromExternal`
   * exactly like the plugin host. Omitted ⇒ no broadcast.
   */
  broadcastToLeads?: (from: string, content: string) => void;
}

export class FeatureRegistry {
  private readonly db: Db;
  private readonly eventBus: SwarmEventBus;
  private readonly config: Pick<Config, 'codegraphEnabled' | 'ideEnabled'>;
  private readonly locks: PluginLockRegistry;
  private readonly broadcastToLeads: ((from: string, content: string) => void) | null;

  /** Live state per feature — LE point de gating par requête (read by isEnabled). */
  private readonly states = new Map<FeatureName, FeatureState>();
  /** `updated_at` per feature, for `list()`. */
  private readonly updatedAt = new Map<FeatureName, string>();
  /** Descriptors, in registration order (Map preserves insertion order). */
  private readonly descriptors = new Map<FeatureName, FeatureDescriptor>();

  private getStmt: ReturnType<Db['prepare']> | null = null;
  private upsertStmt: ReturnType<Db['prepare']> | null = null;

  constructor(deps: FeatureRegistryDeps) {
    this.db = deps.db.db;
    this.eventBus = deps.eventBus;
    this.config = deps.config;
    this.locks = deps.locks ?? new PluginLockRegistry();
    this.broadcastToLeads = deps.broadcastToLeads ?? null;

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS builtin_features (
          name       TEXT PRIMARY KEY,
          state      TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      this.getStmt = this.db.prepare('SELECT name, state, updated_at FROM builtin_features WHERE name = ?');
      this.upsertStmt = this.db.prepare(
        `INSERT INTO builtin_features (name, state, updated_at) VALUES (@name, @state, @updated_at)
         ON CONFLICT(name) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      );
      this.seed();
    } catch (err) {
      // Never stop the boot: fail OPEN. The maps stay empty, so `isEnabled`
      // answers true everywhere and the app behaves as if all features are on.
      log.error({
        event: 'features.open_failed',
        error: err instanceof Error ? err.message : String(err),
        note: 'the built-in feature registry could not open — every feature is treated as ENABLED for this boot.',
      });
    }
  }

  // ---- seed & load -------------------------------------------------------

  /** The seed default an env var implies (only codegraph/ide carry one). */
  private envSeedState(name: FeatureName): FeatureState {
    if (name === 'codegraph') return this.config.codegraphEnabled ? 'enabled' : 'disabled';
    if (name === 'ide') return this.config.ideEnabled ? 'enabled' : 'disabled';
    return 'enabled';
  }

  /**
   * First boot (row absent): seed `enabled`, except codegraph/ide whose legacy
   * env var seeds `disabled` when false. Thereafter the DB governs — if an env
   * var now contradicts the persisted state, log `feature.seed_ignored` so the
   * operator knows the var became a mere seed default (D4).
   */
  private seed(): void {
    for (const name of FEATURE_NAMES) {
      const row = this.getStmt?.get(name) as FeatureRow | undefined;
      if (!row) {
        this.persistState(name, this.envSeedState(name));
        continue;
      }
      const state = (row.state as FeatureState) ?? 'enabled';
      this.states.set(name, state);
      this.updatedAt.set(name, row.updated_at);
      if ((name === 'codegraph' || name === 'ide')) {
        const env = this.envSeedState(name);
        if (env !== state) {
          log.warn({ event: 'feature.seed_ignored', feature: name, env, db: state });
        }
      }
    }
  }

  private persistState(name: FeatureName, state: FeatureState): void {
    const now = new Date().toISOString();
    try {
      this.upsertStmt?.run({ name, state, updated_at: now });
    } catch (err) {
      log.warn({ event: 'features.write_failed', feature: name, error: String(err) });
    }
    this.states.set(name, state);
    this.updatedAt.set(name, now);
  }

  // ---- registration ------------------------------------------------------

  register(desc: FeatureDescriptor): void {
    this.descriptors.set(desc.name, desc);
  }

  // ---- reads (synchronous) ----------------------------------------------

  /**
   * LE point de gating par requête. Fail-open: an unknown/unloaded state reads
   * as enabled (a registry that failed to open must not make the app 404).
   */
  isEnabled(name: FeatureName): boolean {
    const s = this.states.get(name);
    return s === undefined ? true : s === 'enabled';
  }

  stateOf(name: FeatureName): FeatureState {
    return this.states.get(name) ?? 'enabled';
  }

  /** One view per REGISTERED descriptor (name, labels, current state). */
  list(): FeatureView[] {
    const out: FeatureView[] = [];
    for (const desc of this.descriptors.values()) {
      out.push({
        name: desc.name,
        displayName: desc.displayName,
        description: desc.description,
        state: this.stateOf(desc.name),
        updatedAt: this.updatedAt.get(desc.name) ?? '',
      });
    }
    return out;
  }

  /** `true` = enabled, for every feature name — consumed by preamble stripping. */
  snapshot(): Record<FeatureName, boolean> {
    const snap = {} as Record<FeatureName, boolean>;
    for (const name of FEATURE_NAMES) snap[name] = this.isEnabled(name);
    return snap;
  }

  // ---- verbs (async, serialised per name) -------------------------------

  /**
   * Enable a feature. On `uninstalled` this is install+enable: purge defensively
   * (the state is already clean, so this is an idempotent guard) then start.
   */
  enable(name: FeatureName): Promise<void> {
    return this.locks.run(name, async () => {
      const desc = this.descriptors.get(name);
      const prev = this.states.get(name);
      if (prev === 'uninstalled') {
        await desc?.purge();
      }
      desc?.start();
      this.persistState(name, 'enabled');
      this.announce(name, 'enabled');
    });
  }

  disable(name: FeatureName): Promise<void> {
    return this.locks.run(name, async () => {
      const desc = this.descriptors.get(name);
      await desc?.stop();
      this.persistState(name, 'disabled');
      this.announce(name, 'disabled');
    });
  }

  uninstall(name: FeatureName): Promise<void> {
    return this.locks.run(name, async () => {
      const desc = this.descriptors.get(name);
      await desc?.stop();
      await desc?.purge();
      this.persistState(name, 'uninstalled');
      this.announce(name, 'uninstalled');
    });
  }

  private announce(name: FeatureName, state: FeatureState): void {
    try {
      this.eventBus.emitEvent({
        kind: 'feature.changed',
        payload: { name, state } satisfies FeatureChangedPayload,
      });
    } catch (err) {
      log.warn({ event: 'features.emit_failed', feature: name, error: String(err) });
    }
    if (this.broadcastToLeads) {
      try {
        this.broadcastToLeads(
          'system',
          `Built-in feature '${name}' is now ${state}. Restart or resume your session to refresh its tools.`,
        );
      } catch (err) {
        log.warn({ event: 'features.broadcast_failed', feature: name, error: String(err) });
      }
    }
  }

  // ---- boot / shutdown ---------------------------------------------------

  /** Arm every ENABLED feature's jobs. Never rejects — logs per failure. */
  startEnabled(): void {
    for (const desc of this.descriptors.values()) {
      if (!this.isEnabled(desc.name)) continue;
      try {
        desc.start();
      } catch (err) {
        log.error({
          event: 'features.start_failed',
          feature: desc.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Stop every feature (reverse registration order) at shutdown. */
  async stopAll(): Promise<void> {
    const names = [...this.descriptors.keys()].reverse();
    for (const name of names) {
      try {
        await this.descriptors.get(name)?.stop();
      } catch (err) {
        log.warn({
          event: 'features.stop_failed',
          feature: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

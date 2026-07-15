/**
 * PluginStore — persistence for the plugin registry.
 *
 * ⚠️ Owns its OWN tables via `CREATE TABLE IF NOT EXISTS` on the RAW
 * `Database` handle (`SwarmDb.db`, a public field) and prepares its own
 * statements — the same model `SwarmDb` uses for orch/session rows. We touch
 * NEITHER `schema.sql` NOR `INLINE_SCHEMA`: the inline fallback is the path
 * that actually runs in the Docker image (tsc doesn't copy `.sql`), so the
 * double source is a trap. Keeping the DDL here sidesteps it entirely.
 *
 * `status` is intentionally NOT a column: runtime status is derived by the
 * host from `enabled` + `quarantined_until` + `last_error` + the live active
 * set (a crashed-in-memory plugin re-derives as `quarantined` after a reboot,
 * which is accurate).
 */

import type { Database as Db } from 'better-sqlite3';
import { withModule } from '../../logger.js';
import type { SwarmDb } from '../db/index.js';

const log = withModule('plugins.store');

/** Row shape of the `plugins` table (SQLite stores booleans as 0/1 integers). */
export interface PluginRow {
  name: string;
  version: string;
  source_kind: string;
  source_ref: string | null;
  enabled: number;
  config_json: string | null;
  granted_capabilities_json: string | null;
  api_version: number;
  fail_count: number;
  quarantined_until: string | null;
  installed_at: string;
  updated_at: string;
  last_error: string | null;
}

interface KvRow {
  key: string;
  value: string;
}

export class PluginStore {
  private readonly db: Db;
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly listStmt;
  private readonly listEnabledStmt;
  private readonly deleteStmt;
  private readonly kvGetStmt;
  private readonly kvSetStmt;
  private readonly kvDeleteStmt;
  private readonly kvListStmt;
  private readonly kvListPrefixStmt;
  private readonly kvPurgeStmt;

  constructor(swarmDb: SwarmDb) {
    this.db = swarmDb.db;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plugins (
        name          TEXT PRIMARY KEY,
        version       TEXT NOT NULL,
        source_kind   TEXT NOT NULL,
        source_ref    TEXT,
        enabled       INTEGER NOT NULL DEFAULT 0,
        config_json   TEXT,
        granted_capabilities_json TEXT,
        api_version   INTEGER NOT NULL DEFAULT 1,
        fail_count    INTEGER NOT NULL DEFAULT 0,
        quarantined_until TEXT,
        installed_at  TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        last_error    TEXT
      );
      CREATE TABLE IF NOT EXISTS plugin_kv (
        plugin TEXT NOT NULL, key TEXT NOT NULL, value TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY (plugin, key)
      );
    `);

    this.upsertStmt = this.db.prepare<PluginRow>(`
      INSERT INTO plugins (
        name, version, source_kind, source_ref, enabled, config_json,
        granted_capabilities_json, api_version, fail_count, quarantined_until,
        installed_at, updated_at, last_error
      ) VALUES (
        @name, @version, @source_kind, @source_ref, @enabled, @config_json,
        @granted_capabilities_json, @api_version, @fail_count, @quarantined_until,
        @installed_at, @updated_at, @last_error
      )
      ON CONFLICT(name) DO UPDATE SET
        version = excluded.version,
        source_kind = excluded.source_kind,
        source_ref = excluded.source_ref,
        enabled = excluded.enabled,
        config_json = excluded.config_json,
        granted_capabilities_json = excluded.granted_capabilities_json,
        api_version = excluded.api_version,
        fail_count = excluded.fail_count,
        quarantined_until = excluded.quarantined_until,
        updated_at = excluded.updated_at,
        last_error = excluded.last_error
        -- installed_at intentionally NOT overwritten: preserved across re-scan
    `);

    this.getStmt = this.db.prepare<[string], PluginRow>(
      'SELECT * FROM plugins WHERE name = ?',
    );
    this.listStmt = this.db.prepare<[], PluginRow>(
      'SELECT * FROM plugins ORDER BY name ASC',
    );
    this.listEnabledStmt = this.db.prepare<[], PluginRow>(
      'SELECT * FROM plugins WHERE enabled = 1 ORDER BY name ASC',
    );
    this.deleteStmt = this.db.prepare<[string]>('DELETE FROM plugins WHERE name = ?');

    this.kvGetStmt = this.db.prepare<[string, string], KvRow>(
      'SELECT key, value FROM plugin_kv WHERE plugin = ? AND key = ?',
    );
    this.kvSetStmt = this.db.prepare<[string, string, string, string]>(
      `INSERT INTO plugin_kv (plugin, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(plugin, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    this.kvDeleteStmt = this.db.prepare<[string, string]>(
      'DELETE FROM plugin_kv WHERE plugin = ? AND key = ?',
    );
    this.kvListStmt = this.db.prepare<[string], KvRow>(
      'SELECT key, value FROM plugin_kv WHERE plugin = ? ORDER BY key ASC',
    );
    this.kvListPrefixStmt = this.db.prepare<[string, string], KvRow>(
      "SELECT key, value FROM plugin_kv WHERE plugin = ? AND key LIKE ? ESCAPE '\\' ORDER BY key ASC",
    );
    this.kvPurgeStmt = this.db.prepare<[string]>('DELETE FROM plugin_kv WHERE plugin = ?');
  }

  // ---- rows --------------------------------------------------------------

  get(name: string): PluginRow | null {
    try {
      return this.getStmt.get(name) ?? null;
    } catch (err) {
      log.warn({ event: 'plugins.read_failed', op: 'get', name, error: String(err) });
      return null;
    }
  }

  list(): PluginRow[] {
    try {
      return this.listStmt.all();
    } catch (err) {
      log.warn({ event: 'plugins.read_failed', op: 'list', error: String(err) });
      return [];
    }
  }

  listEnabled(): PluginRow[] {
    try {
      return this.listEnabledStmt.all();
    } catch (err) {
      log.warn({ event: 'plugins.read_failed', op: 'listEnabled', error: String(err) });
      return [];
    }
  }

  /** Full-row upsert. `installed_at` is preserved on conflict (see DDL). */
  upsert(row: PluginRow): void {
    try {
      this.upsertStmt.run(row);
    } catch (err) {
      log.warn({ event: 'plugins.write_failed', op: 'upsert', name: row.name, error: String(err) });
    }
  }

  delete(name: string): void {
    try {
      this.deleteStmt.run(name);
    } catch (err) {
      log.warn({ event: 'plugins.write_failed', op: 'delete', name, error: String(err) });
    }
  }

  /**
   * Read-modify-write helper. Applies `patch` over the current row and writes
   * it back, always bumping `updated_at`. Returns the written row, or null if
   * the plugin doesn't exist.
   */
  patch(name: string, patch: Partial<Omit<PluginRow, 'name' | 'installed_at'>>): PluginRow | null {
    const row = this.get(name);
    if (!row) return null;
    const next: PluginRow = {
      ...row,
      ...patch,
      updated_at: new Date().toISOString(),
    };
    this.upsert(next);
    return next;
  }

  // ---- config ------------------------------------------------------------

  /** Parsed config object (empty when unset or malformed). */
  getConfig(name: string): Record<string, unknown> {
    const row = this.get(name);
    if (!row?.config_json) return {};
    try {
      const parsed = JSON.parse(row.config_json) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (err) {
      log.warn({ event: 'plugins.config_parse_failed', name, error: String(err) });
    }
    return {};
  }

  // ---- kv (plugin_kv) ----------------------------------------------------

  kvGet(plugin: string, key: string): string | null {
    try {
      return this.kvGetStmt.get(plugin, key)?.value ?? null;
    } catch (err) {
      log.warn({ event: 'plugins.kv_read_failed', plugin, error: String(err) });
      return null;
    }
  }

  kvSet(plugin: string, key: string, value: string): void {
    try {
      this.kvSetStmt.run(plugin, key, value, new Date().toISOString());
    } catch (err) {
      log.warn({ event: 'plugins.kv_write_failed', plugin, error: String(err) });
    }
  }

  kvDelete(plugin: string, key: string): void {
    try {
      this.kvDeleteStmt.run(plugin, key);
    } catch (err) {
      log.warn({ event: 'plugins.kv_write_failed', plugin, error: String(err) });
    }
  }

  kvList(plugin: string, prefix?: string): Array<{ key: string; value: string }> {
    try {
      if (prefix != null && prefix.length > 0) {
        // Escape LIKE wildcards so a prefix is matched literally.
        const escaped = prefix.replace(/([\\%_])/g, '\\$1');
        return this.kvListPrefixStmt.all(plugin, `${escaped}%`);
      }
      return this.kvListStmt.all(plugin);
    } catch (err) {
      log.warn({ event: 'plugins.kv_read_failed', plugin, error: String(err) });
      return [];
    }
  }

  /** Purge every kv entry for a plugin (uninstall `?purge=true`). */
  purgeKv(plugin: string): void {
    try {
      this.kvPurgeStmt.run(plugin);
    } catch (err) {
      log.warn({ event: 'plugins.kv_write_failed', op: 'purge', plugin, error: String(err) });
    }
  }

  /**
   * Enumerate the private tables/indexes/triggers a plugin owns —
   * `plugin_<name'>_%` where `name'` = name with `-`→`_` (a bare tiret is an
   * invalid SQL identifier, so `defineTable` mandates the underscore form).
   * The `_` in the prefix is a LIKE wildcard, so it is escaped to match
   * literally (else `plugin_x_` would also match `plugin_xY`).
   */
  private pluginObjectNames(plugin: string): Array<{ type: string; name: string }> {
    const namePrime = plugin.replace(/-/g, '_');
    const prefix = `plugin_${namePrime}_`;
    const like = `${prefix.replace(/([\\%_])/g, '\\$1')}%`;
    return this.db
      .prepare<[string], { type: string; name: string }>(
        "SELECT type, name FROM sqlite_master WHERE type IN ('table','index','trigger') AND name LIKE ? ESCAPE '\\'",
      )
      .all(like);
  }

  /**
   * Hard purge for `DELETE /plugins/:name?purge=true` (red-team I-6/I-7): in ONE
   * transaction drop the plugin's `plugin_<name'>_*` tables/indexes/triggers,
   * wipe `plugin_kv`, and delete the registry row (which carries `config_json`).
   * Atomic so a crash can't leave a half-purged name that a later reinstall of
   * the same name would silently inherit.
   */
  purgeAndDelete(plugin: string): void {
    try {
      const objects = this.pluginObjectNames(plugin);
      // Drop order: triggers → indexes → tables (a table drop cascades its own
      // indexes/triggers, but standalone ones are dropped explicitly first).
      const rank: Record<string, number> = { trigger: 0, index: 1, table: 2 };
      objects.sort((a, b) => (rank[a.type] ?? 9) - (rank[b.type] ?? 9));
      const tx = this.db.transaction(() => {
        for (const o of objects) {
          const kw = o.type === 'trigger' ? 'TRIGGER' : o.type === 'index' ? 'INDEX' : 'TABLE';
          this.db.exec(`DROP ${kw} IF EXISTS "${o.name.replace(/"/g, '""')}"`);
        }
        this.kvPurgeStmt.run(plugin);
        this.deleteStmt.run(plugin);
      });
      tx();
    } catch (err) {
      log.warn({ event: 'plugins.purge_and_delete_failed', plugin, error: String(err) });
    }
  }
}

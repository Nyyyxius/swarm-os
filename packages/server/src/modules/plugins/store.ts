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
import { PluginStorageError } from './api-types.js';

const log = withModule('plugins.store');

/** Safe projection of a prepared statement handed to a plugin — never the raw
 *  better-sqlite3 `Statement` (which would expose the shared `Database`). */
export interface PluginPreparedStatement<P extends object = object, R = unknown> {
  run(p?: P): void;
  get(p?: P): R | undefined;
  all(p?: P): R[];
}

/** Verbs a plugin may `prepare()` — DML + CTEs only. Everything else (DDL,
 *  PRAGMA, ATTACH/DETACH, VACUUM, BEGIN/COMMIT/…) is refused: DDL goes through
 *  `defineTable`, the rest have no legitimate plugin use and could escape the
 *  prefix boundary. `.prepare()` already enforces a single statement, so these
 *  verbs can only ever appear as the STATEMENT HEAD. */
const PREPARE_ALLOWED_VERBS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'WITH']);

/** SQLite internal schema objects — always off-limits to a plugin (they don't
 *  carry a `plugin_<name'>_` prefix and some aren't listed in `sqlite_master`). */
const SQLITE_INTERNAL_TABLES = [
  'sqlite_master',
  'sqlite_schema',
  'sqlite_temp_master',
  'sqlite_temp_schema',
  'sqlite_sequence',
  'sqlite_stat1',
  'sqlite_stat4',
];

/**
 * Strip comments and single-quoted string literals from SQL so a subsequent
 * identifier scan can't be fooled by a table name that only appears inside a
 * literal/comment. String literals collapse to a space (keeps tokens apart);
 * quoted IDENTIFIERS (`"…"`, `` `…` ``, `[…]`) are preserved for scanning.
 */
function stripSqlNoise(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (c === '-' && c2 === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Lowercased set of every identifier a (noise-stripped) SQL string mentions —
 *  bare words AND quoted identifiers. Used to test membership against the set of
 *  forbidden table names (a real table reference always names the table). */
function referencedIdentifiers(strippedSql: string): Set<string> {
  const ids = new Set<string>();
  for (const m of strippedSql.matchAll(/"((?:[^"]|"")*)"|`((?:[^`]|``)*)`|\[([^\]]*)\]/g)) {
    const inner = (m[1] ?? m[2] ?? m[3] ?? '').replace(/""/g, '"').replace(/``/g, '`');
    ids.add(inner.toLowerCase());
  }
  for (const m of strippedSql.matchAll(/[A-Za-z_][A-Za-z0-9_$]*/g)) {
    ids.add(m[0].toLowerCase());
  }
  return ids;
}

/** Row shape of the `plugins` table (SQLite stores booleans as 0/1 integers). */
export interface PluginRow {
  name: string;
  version: string;
  source_kind: string;
  source_ref: string | null;
  /**
   * Git HEAD the plugin was fetched from — the ORIGIN, not the address
   * (`source_ref` stays the re-fetch address). Null for npm/dir/upload sources,
   * for a git clone whose `rev-parse` failed, and for every row installed before
   * the column existed. Required-but-nullable on purpose: better-sqlite3 throws
   * on a MISSING named parameter and `upsert` swallows that throw into a warn,
   * so an optional field would turn a forgotten construction site into a
   * silently dropped write. Let the compiler catch it instead.
   */
  source_commit: string | null;
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
        source_commit TEXT,
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

    // MUST run between the DDL above and the prepares below: a statement naming
    // `@source_commit` cannot compile against a pre-migration schema.
    this.applyMigrations();

    this.upsertStmt = this.db.prepare<PluginRow>(`
      INSERT INTO plugins (
        name, version, source_kind, source_ref, source_commit, enabled, config_json,
        granted_capabilities_json, api_version, fail_count, quarantined_until,
        installed_at, updated_at, last_error
      ) VALUES (
        @name, @version, @source_kind, @source_ref, @source_commit, @enabled, @config_json,
        @granted_capabilities_json, @api_version, @fail_count, @quarantined_until,
        @installed_at, @updated_at, @last_error
      )
      ON CONFLICT(name) DO UPDATE SET
        version = excluded.version,
        source_kind = excluded.source_kind,
        source_ref = excluded.source_ref,
        source_commit = excluded.source_commit,
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

  /**
   * Idempotent column-additions for upgrades — same shape as
   * `SwarmDb.applyMigrations()`. `CREATE TABLE IF NOT EXISTS` skips an EXISTING
   * table WHOLESALE, so a column added to the DDL above never lands on a DB that
   * already has the table: only an explicit `ALTER TABLE` does. The
   * duplicate-column error is swallowed so this is safe to run on every boot;
   * anything else is logged, and the prepares that follow then fail loudly on
   * the missing column — the honest outcome for a broken schema.
   *
   * As with the DDL above, this deliberately does NOT go in `schema.sql`: that
   * file isn't shipped in the image (see the module header).
   */
  private applyMigrations(): void {
    const additions: Array<{ table: string; column: string; ddl: string }> = [
      // Origin tracking — the git HEAD a plugin was fetched from, so a later
      // pass can tell whether the remote has moved.
      { table: 'plugins', column: 'source_commit', ddl: 'ALTER TABLE plugins ADD COLUMN source_commit TEXT' },
    ];
    for (const a of additions) {
      try {
        this.db.exec(a.ddl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/duplicate column name/i.test(msg)) {
          log.warn({ event: 'plugins.migration_failed', table: a.table, column: a.column, error: msg });
        }
      }
    }
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

  // ---- db-tables (private plugin_<name'>_* tables) -----------------------

  /**
   * Set of existing table/view names a plugin MAY NOT reference — everything
   * outside its `plugin_<name'>_` prefix, plus SQLite's internal schema tables.
   * Computed live from `sqlite_master` so a table added later (core migration,
   * another plugin) is covered without a restart.
   */
  private forbiddenTableNames(prefix: string): Set<string> {
    const set = new Set<string>(SQLITE_INTERNAL_TABLES);
    const rows = this.db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view')",
      )
      .all();
    for (const r of rows) {
      const n = r.name.toLowerCase();
      if (!n.startsWith(prefix)) set.add(n);
    }
    return set;
  }

  /**
   * Reject a statement that references ANY table outside `prefix`. Since a real
   * table reference always names the table literally (SQLite has no way to reach
   * a base table without spelling its name), scanning the noise-stripped SQL for
   * a forbidden name is a robust upper bound: it catches `… FROM roles`,
   * `INSERT INTO roles …`, `CREATE TABLE plugin_x_y AS SELECT … FROM roles`, and
   * a trigger body touching a core table. Limits (documented): it is
   * conservative — an identifier that merely COLLIDES with a forbidden table
   * name (e.g. a column literally named `roles`) is rejected too; and the
   * `plugin_a_` prefix is a textual prefix of `plugin_a_b_` (plugin `a-b`), the
   * same ambiguity the uninstall purge carries.
   */
  private assertOnlyPrefixedTables(sql: string, prefix: string): void {
    const forbidden = this.forbiddenTableNames(prefix);
    if (forbidden.size === 0) return;
    const ids = referencedIdentifiers(stripSqlNoise(sql));
    for (const name of forbidden) {
      if (ids.has(name)) {
        throw new PluginStorageError(
          `statement references table '${name}', which is outside the plugin's '${prefix}' prefix`,
        );
      }
    }
  }

  /**
   * `api.storage.defineTable(ddl)` — create a private `plugin_<name'>_*` object.
   *
   * Accepts exactly one `CREATE TABLE` / `CREATE [UNIQUE] INDEX` / `CREATE
   * TRIGGER` statement (the object types the uninstall purge knows how to drop),
   * and enforces:
   *  - mono-statement — via `.prepare()` (not `.exec()`): a trailing
   *    `; DROP TABLE roles` throws "more than one statement";
   *  - no reference to a table outside the prefix (blocks `AS SELECT … FROM
   *    roles` read-copies and triggers wired onto core tables);
   *  - every object the statement actually creates lives under the prefix — both
   *    its NAME and the table it attaches to (`tbl_name`), verified against a
   *    `sqlite_master` diff inside a transaction that ROLLS BACK on violation.
   *
   * Idempotent: a `CREATE … IF NOT EXISTS` that creates nothing commits as a
   * no-op. `ATTACH` is refused (not a `CREATE`) — an anti-accident guard, not a
   * security boundary (plugins are trusted in-process code; documented).
   */
  defineTable(plugin: string, ddl: string): void {
    if (typeof ddl !== 'string' || ddl.trim().length === 0) {
      throw new PluginStorageError('defineTable requires a non-empty CREATE statement');
    }
    const sql = ddl.trim();
    if (!/^CREATE\s+(TABLE|(UNIQUE\s+)?INDEX|TRIGGER)\b/i.test(sql)) {
      throw new PluginStorageError(
        "defineTable only accepts a 'CREATE TABLE' / 'CREATE [UNIQUE] INDEX' / 'CREATE TRIGGER' " +
          'statement (no VIEW / VIRTUAL / TEMP / PRAGMA / ATTACH / DROP / ALTER)',
      );
    }
    const prefix = PluginStore.tablePrefix(plugin);
    this.assertOnlyPrefixedTables(sql, prefix);

    const before = new Set(
      this.db.prepare<[], { name: string }>('SELECT name FROM sqlite_master').all().map((r) => r.name),
    );
    const tx = this.db.transaction(() => {
      this.db.prepare(sql).run();
      const created = this.db
        .prepare<[], { type: string; name: string; tbl_name: string }>(
          'SELECT type, name, tbl_name FROM sqlite_master',
        )
        .all()
        .filter((o) => !before.has(o.name));
      for (const o of created) {
        if (o.type !== 'table' && o.type !== 'index' && o.type !== 'trigger') {
          throw new PluginStorageError(
            `defineTable created an unsupported object type '${o.type}' ('${o.name}')`,
          );
        }
        const nm = o.name.toLowerCase();
        const tbl = o.tbl_name.toLowerCase();
        // Every created object must attach to a table under the plugin's prefix.
        // Its own name must be prefixed too — except a `sqlite_autoindex_*`,
        // which SQLite creates IMPLICITLY for a UNIQUE/PRIMARY KEY on the (now
        // verified-prefixed) table. `sqlite_` is a reserved name a plugin cannot
        // forge (`CREATE TABLE sqlite_x` is rejected outright), so allowing it
        // when `tbl_name` is prefixed is safe.
        if (!tbl.startsWith(prefix) || (!nm.startsWith(prefix) && !nm.startsWith('sqlite_'))) {
          throw new PluginStorageError(
            `defineTable object '${o.name}' (on '${o.tbl_name}') must start with '${prefix}'`,
          );
        }
      }
    });
    tx();
  }

  /**
   * `api.storage.prepare(sql)` — compile a single DML statement over the
   * plugin's private tables and return a safe `{ run, get, all }` projection
   * (never the raw better-sqlite3 `Statement`).
   *
   * Guards: the leading verb must be SELECT/INSERT/UPDATE/DELETE/REPLACE/WITH
   * (rejects PRAGMA/ATTACH/DETACH/VACUUM/DDL/transaction control — and
   * `.prepare()` guarantees a single statement so those verbs can't be chained
   * on); PRAGMA/ATTACH/DETACH/VACUUM are also refused anywhere (a
   * `pragma_table_info(...)` table-valued function would otherwise slip past the
   * head check); and no table outside the plugin's prefix may be referenced.
   * `.prepare()` additionally fails fast if a referenced table doesn't exist.
   */
  prepareForPlugin<P extends object = object, R = unknown>(
    plugin: string,
    sql: string,
  ): PluginPreparedStatement<P, R> {
    if (typeof sql !== 'string' || sql.trim().length === 0) {
      throw new PluginStorageError('prepare requires a non-empty SQL statement');
    }
    const trimmed = sql.trim();
    const verb = /^([A-Za-z]+)/.exec(trimmed)?.[1]?.toUpperCase() ?? '';
    if (!PREPARE_ALLOWED_VERBS.has(verb)) {
      throw new PluginStorageError(
        `prepare only accepts SELECT/INSERT/UPDATE/DELETE/REPLACE/WITH statements (got '${verb || '?'}') ` +
          '— DDL, PRAGMA, ATTACH/DETACH, VACUUM and explicit transactions are refused',
      );
    }
    const stripped = stripSqlNoise(trimmed).toLowerCase();
    if (/\bpragma/.test(stripped) || /\battach\b/.test(stripped) || /\bdetach\b/.test(stripped) || /\bvacuum\b/.test(stripped)) {
      throw new PluginStorageError('prepare: PRAGMA / ATTACH / DETACH / VACUUM are not allowed');
    }
    const prefix = PluginStore.tablePrefix(plugin);
    this.assertOnlyPrefixedTables(trimmed, prefix);

    const stmt = this.db.prepare(trimmed);
    return {
      run: (p?: P): void => {
        if (p === undefined) stmt.run();
        else stmt.run(p);
      },
      get: (p?: P): R | undefined =>
        (p === undefined ? stmt.get() : stmt.get(p)) as R | undefined,
      all: (p?: P): R[] => (p === undefined ? stmt.all() : stmt.all(p)) as R[],
    };
  }

  /**
   * The private-object prefix a plugin owns: `plugin_<name'>_` where `name'` =
   * name with `-`→`_` (a bare tiret is an invalid SQL identifier, so a table
   * `plugin_slack-bridge_x` would be a syntax error). This is the SINGLE source
   * of truth for the prefix — `pluginObjectNames` (uninstall purge),
   * `defineTable` and `prepare` all derive from it, so a table created by
   * `defineTable` is exactly the one the purge later drops.
   */
  static tablePrefix(plugin: string): string {
    return `plugin_${plugin.replace(/-/g, '_')}_`;
  }

  /**
   * Enumerate the private tables/indexes/triggers a plugin owns —
   * `plugin_<name'>_%`. The `_` in the prefix is a LIKE wildcard, so it is
   * escaped to match literally (else `plugin_x_` would also match `plugin_xY`).
   */
  private pluginObjectNames(plugin: string): Array<{ type: string; name: string }> {
    const prefix = PluginStore.tablePrefix(plugin);
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

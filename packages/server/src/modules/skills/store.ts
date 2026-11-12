/**
 * SkillStore — persistence for the skill registry (docs/internal/skills/plan-skills-importables.md §3.1).
 *
 * ⚠️ Owns the `skills` table via `CREATE TABLE IF NOT EXISTS` on the RAW
 * `Database` handle (`SwarmDb.db`) — the SAME self-contained model `PluginStore`
 * uses, and for the same reason: a module-owned table declared in BOTH
 * `schema.sql` AND `INLINE_SCHEMA` is a double-source trap (the `.sql` file is
 * not shipped in the image; the inline copy is the path that runs). Keeping the
 * DDL here is the single source of truth. `roles.skills_json` is different — it
 * is a column on the CORE `roles` table, so it follows the 3-places convention
 * in `db/index.ts`.
 *
 * A skill is DATA (§0): nothing here executes skill code.
 */

import type { Database as Db } from 'better-sqlite3';
import { withModule } from '../../logger.js';
import type { SwarmDb } from '../db/index.js';

const log = withModule('skills.store');

/** Trust levels (docs/internal/skills/plan-skills-importables.md §9). `community` is the default. */
export const SKILL_TRUST_LEVELS = ['first-party', 'verified', 'community', 'local'] as const;
export type SkillTrust = (typeof SKILL_TRUST_LEVELS)[number];

/** Row shape of the `skills` table (SQLite stores booleans as 0/1 integers). */
export interface SkillRow {
  name: string;
  version: string;
  display_name: string | null;
  description: string | null;
  /** dir | upload (Lot 1a); git | npm | market added later. */
  source_kind: string;
  /** Re-fetch address (git encodes url#ref#subdir); null for upload. */
  source_ref: string | null;
  /** git HEAD the skill was fetched from; null otherwise. */
  source_commit: string | null;
  /** sha256 of the imported tree (provenance). */
  checksum: string | null;
  trust: string;
  /** JSON `{ plugins?: string[]; capabilities?: string[] }`. */
  requires_json: string | null;
  /** 1 when the skill ships an `assets/` dir (review gate for executables). */
  assets_present: number;
  /** 1 once an operator has explicitly reviewed a risky skill (Lot 3 gate). */
  reviewed: number;
  /** ISO timestamp of the last review; null while never reviewed. */
  reviewed_at: string | null;
  /** Cached SKILL.md body — read on every spawn, so kept in-row to avoid IO. */
  body_md: string;
  /** JSON of the parsed frontmatter (triggers, etc.). */
  frontmatter_json: string | null;
  installed_at: string;
  updated_at: string;
  last_error: string | null;
}

/** Scope of an activation. Role scope lives in `roles.skills_json`, not here. */
export type SkillScopeType = 'orch' | 'session';

/** Row of the `skill_activations` table (orch/session-scoped activations). */
export interface SkillActivationRow {
  id: string;
  skill_name: string;
  scope_type: SkillScopeType;
  scope_id: string;
  mode: string;
  enabled: number;
  created_at: string;
}

export class SkillStore {
  private readonly db: Db;
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly listStmt;
  private readonly deleteStmt;
  private readonly upsertActivationStmt;
  private readonly deleteActivationStmt;
  private readonly listActivationsStmt;
  private readonly listActivationsForSkillStmt;
  private readonly deleteActivationsForSkillStmt;
  private readonly deleteActivationsForScopeStmt;

  constructor(swarmDb: SwarmDb) {
    this.db = swarmDb.db;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        name             TEXT PRIMARY KEY,
        version          TEXT NOT NULL,
        display_name     TEXT,
        description      TEXT,
        source_kind      TEXT NOT NULL,
        source_ref       TEXT,
        source_commit    TEXT,
        checksum         TEXT,
        trust            TEXT NOT NULL DEFAULT 'community',
        requires_json    TEXT,
        assets_present   INTEGER NOT NULL DEFAULT 0,
        reviewed         INTEGER NOT NULL DEFAULT 0,
        reviewed_at      TEXT,
        body_md          TEXT NOT NULL DEFAULT '',
        frontmatter_json TEXT,
        installed_at     TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        last_error       TEXT
      );
      CREATE TABLE IF NOT EXISTS skill_activations (
        id          TEXT PRIMARY KEY,
        skill_name  TEXT NOT NULL,
        scope_type  TEXT NOT NULL,        -- 'orch' | 'session' (role lives in roles.skills_json)
        scope_id    TEXT NOT NULL,        -- orchestrator.id | session.id
        mode        TEXT NOT NULL DEFAULT 'inject',
        enabled     INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL,
        UNIQUE(skill_name, scope_type, scope_id)
      );
      CREATE INDEX IF NOT EXISTS idx_skill_activations_scope
        ON skill_activations(scope_type, scope_id);
    `);

    // MUST run between the DDL above and the prepares below (a statement naming a
    // migrated column cannot compile against a pre-migration schema).
    this.applyMigrations();

    this.upsertStmt = this.db.prepare<SkillRow>(`
      INSERT INTO skills (
        name, version, display_name, description, source_kind, source_ref,
        source_commit, checksum, trust, requires_json, assets_present, reviewed,
        reviewed_at, body_md, frontmatter_json, installed_at, updated_at, last_error
      ) VALUES (
        @name, @version, @display_name, @description, @source_kind, @source_ref,
        @source_commit, @checksum, @trust, @requires_json, @assets_present, @reviewed,
        @reviewed_at, @body_md, @frontmatter_json, @installed_at, @updated_at, @last_error
      )
      ON CONFLICT(name) DO UPDATE SET
        version = excluded.version,
        display_name = excluded.display_name,
        description = excluded.description,
        source_kind = excluded.source_kind,
        source_ref = excluded.source_ref,
        source_commit = excluded.source_commit,
        checksum = excluded.checksum,
        trust = excluded.trust,
        requires_json = excluded.requires_json,
        assets_present = excluded.assets_present,
        reviewed = excluded.reviewed,
        reviewed_at = excluded.reviewed_at,
        body_md = excluded.body_md,
        frontmatter_json = excluded.frontmatter_json,
        updated_at = excluded.updated_at,
        last_error = excluded.last_error
        -- installed_at intentionally NOT overwritten: preserved across re-import
    `);

    this.getStmt = this.db.prepare<[string], SkillRow>('SELECT * FROM skills WHERE name = ?');
    this.listStmt = this.db.prepare<[], SkillRow>('SELECT * FROM skills ORDER BY name ASC');
    this.deleteStmt = this.db.prepare<[string]>('DELETE FROM skills WHERE name = ?');

    this.upsertActivationStmt = this.db.prepare<SkillActivationRow>(`
      INSERT INTO skill_activations (id, skill_name, scope_type, scope_id, mode, enabled, created_at)
      VALUES (@id, @skill_name, @scope_type, @scope_id, @mode, @enabled, @created_at)
      ON CONFLICT(skill_name, scope_type, scope_id) DO UPDATE SET
        mode = excluded.mode,
        enabled = excluded.enabled
    `);
    this.deleteActivationStmt = this.db.prepare<[string, string, string]>(
      'DELETE FROM skill_activations WHERE skill_name = ? AND scope_type = ? AND scope_id = ?',
    );
    this.listActivationsStmt = this.db.prepare<[string, string], SkillActivationRow>(
      'SELECT * FROM skill_activations WHERE scope_type = ? AND scope_id = ? ORDER BY created_at ASC',
    );
    this.listActivationsForSkillStmt = this.db.prepare<[string], SkillActivationRow>(
      'SELECT * FROM skill_activations WHERE skill_name = ? ORDER BY scope_type, created_at ASC',
    );
    this.deleteActivationsForSkillStmt = this.db.prepare<[string]>(
      'DELETE FROM skill_activations WHERE skill_name = ?',
    );
    this.deleteActivationsForScopeStmt = this.db.prepare<[string, string]>(
      'DELETE FROM skill_activations WHERE scope_type = ? AND scope_id = ?',
    );
  }

  /** Idempotent additive column migrations — same swallow-if-duplicate pattern. */
  private applyMigrations(): void {
    const additions: Array<{ column: string; ddl: string }> = [
      // Lot 3 review gate. Existing rows (pre-Lot 3) default to un-reviewed —
      // fail-safe: a risky skill installed before the gate must be reviewed
      // before it can be (re)activated.
      { column: 'reviewed', ddl: `ALTER TABLE skills ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0` },
      { column: 'reviewed_at', ddl: `ALTER TABLE skills ADD COLUMN reviewed_at TEXT` },
    ];
    for (const a of additions) {
      try {
        this.db.exec(a.ddl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/duplicate column name/i.test(msg)) {
          log.warn({ event: 'skills.migration_failed', column: a.column, error: msg });
        }
      }
    }
  }

  get(name: string): SkillRow | null {
    try {
      return this.getStmt.get(name) ?? null;
    } catch (err) {
      log.warn({ event: 'skills.read_failed', op: 'get', name, error: String(err) });
      return null;
    }
  }

  list(): SkillRow[] {
    try {
      return this.listStmt.all();
    } catch (err) {
      log.warn({ event: 'skills.read_failed', op: 'list', error: String(err) });
      return [];
    }
  }

  /** Full-row upsert. `installed_at` is preserved on conflict (see DDL). */
  upsert(row: SkillRow): void {
    try {
      this.upsertStmt.run(row);
    } catch (err) {
      log.warn({ event: 'skills.write_failed', op: 'upsert', name: row.name, error: String(err) });
    }
  }

  delete(name: string): void {
    try {
      this.deleteStmt.run(name);
    } catch (err) {
      log.warn({ event: 'skills.write_failed', op: 'delete', name, error: String(err) });
    }
  }

  /** Read-modify-write helper; always bumps `updated_at`. Null if absent. */
  patch(name: string, patch: Partial<Omit<SkillRow, 'name' | 'installed_at'>>): SkillRow | null {
    const row = this.get(name);
    if (!row) return null;
    const next: SkillRow = { ...row, ...patch, updated_at: new Date().toISOString() };
    this.upsert(next);
    return next;
  }

  // ---- activations (orch/session scopes) --------------------------------

  upsertActivation(row: SkillActivationRow): void {
    try {
      this.upsertActivationStmt.run(row);
    } catch (err) {
      log.warn({ event: 'skills.activation_write_failed', op: 'upsert', name: row.skill_name, error: String(err) });
    }
  }

  deleteActivation(skillName: string, scopeType: SkillScopeType, scopeId: string): void {
    try {
      this.deleteActivationStmt.run(skillName, scopeType, scopeId);
    } catch (err) {
      log.warn({ event: 'skills.activation_write_failed', op: 'delete', name: skillName, error: String(err) });
    }
  }

  listActivations(scopeType: SkillScopeType, scopeId: string): SkillActivationRow[] {
    try {
      return this.listActivationsStmt.all(scopeType, scopeId);
    } catch (err) {
      log.warn({ event: 'skills.activation_read_failed', scopeType, scopeId, error: String(err) });
      return [];
    }
  }

  /** Every orch/session activation of a skill (provenance for the management UI). */
  listActivationsForSkill(skillName: string): SkillActivationRow[] {
    try {
      return this.listActivationsForSkillStmt.all(skillName);
    } catch (err) {
      log.warn({ event: 'skills.activation_read_failed', op: 'for_skill', name: skillName, error: String(err) });
      return [];
    }
  }

  /** Cleanup: drop every activation of a skill (called on uninstall). */
  deleteActivationsForSkill(skillName: string): void {
    try {
      this.deleteActivationsForSkillStmt.run(skillName);
    } catch (err) {
      log.warn({ event: 'skills.activation_write_failed', op: 'purge_skill', name: skillName, error: String(err) });
    }
  }

  /** Cleanup: drop every activation for a scope (an orch/session that's gone). */
  deleteActivationsForScope(scopeType: SkillScopeType, scopeId: string): void {
    try {
      this.deleteActivationsForScopeStmt.run(scopeType, scopeId);
    } catch (err) {
      log.warn({ event: 'skills.activation_write_failed', op: 'purge_scope', scopeType, error: String(err) });
    }
  }
}

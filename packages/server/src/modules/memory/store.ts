/**
 * MemoryStore — the shared knowledge graph ("Obsidian-style" vault), GLOBAL to
 * one deployment (one instance = one memory shared by every team).
 *
 * Storage model (docs/memoire-partagee.md §4, option C — hybrid):
 *   - SOURCE OF TRUTH = markdown files at `<dataDir>/memory/<name>.md`, each
 *     with a YAML-ish frontmatter (name, description, type, metadata, created_by,
 *     team, created_at, updated_at, version) and a body carrying `[[wikilinks]]`.
 *     The vault stays portable / Obsidian-compatible / git-friendly and rides
 *     the `/data` hot backup.
 *   - MIRROR = a SQLite index (`memory_nodes`, `memory_edges`, FTS5 `memory_fts`)
 *     derived from the files, for O(1) graph rendering and FTS5 recall.
 *
 * ⚠️ Like `plugins/store.ts` and `updates/store.ts`, this class OWNS its tables
 * via `CREATE TABLE IF NOT EXISTS` on the raw `Database` handle (`SwarmDb.db`).
 * It deliberately touches NEITHER `schema.sql` NOR `INLINE_SCHEMA`: the inline
 * fallback is the path that runs in the Docker image (tsc doesn't copy `.sql`),
 * so the double source is a trap. Keeping the DDL here sidesteps it entirely.
 *
 * Robustness (docs §11): every method is wrapped in try/catch and logs on
 * failure — a broken write NEVER crashes the 24/7 server. The ONE exception is
 * an optimistic-lock version conflict, which is thrown as `MemoryConflictError`
 * so the caller (MCP tool / REST) can answer 409 instead of silently losing a
 * concurrent write.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Database as Db } from 'better-sqlite3';
import { withModule } from '../../logger.js';
import type { SwarmDb } from '../db/index.js';
import type { SwarmEventBus } from '../../events.js';
import {
  type EmbeddingProvider,
  type EmbeddingCapabilities,
  HashingEmbeddingProvider,
  cosineSimilarity,
  encodeVector,
  decodeVector,
} from './embeddings.js';

const log = withModule('memory.store');

// --- DTO contract (identical on the frontend — do NOT change without cause) ---

export type MemoryNoteType =
  | 'user'
  | 'feedback'
  | 'project'
  | 'reference'
  | 'entity'
  | 'decision';

export const MEMORY_NOTE_TYPES: readonly MemoryNoteType[] = [
  'user',
  'feedback',
  'project',
  'reference',
  'entity',
  'decision',
];

export interface MemoryNoteMeta {
  name: string;
  description: string;
  type: MemoryNoteType;
  team?: string;
  createdBy?: string;
  /** Epoch millis. */
  createdAt: number;
  /** Epoch millis. */
  updatedAt: number;
  version: number;
}

/** A directed edge leaving a note, with its relation label ('links' = plain). */
export interface MemoryOutEdge {
  to: string;
  relation: string;
}

/** A directed edge entering a note (back-link), with its relation label. */
export interface MemoryInEdge {
  from: string;
  relation: string;
}

export interface MemoryNote extends MemoryNoteMeta {
  body: string;
  /**
   * Plain, de-duplicated out-link targets (kept for backward-compat — the
   * frontend depends on this exact shape). Covers EVERY edge relation.
   */
  outLinks: string[];
  /** Plain, de-duplicated back-link sources (backward-compat). */
  inLinks: string[];
  /** Typed out-edges: one entry per (target, relation). ADDITIVE. */
  outEdges: MemoryOutEdge[];
  /** Typed in-edges (back-links): one entry per (source, relation). ADDITIVE. */
  inEdges: MemoryInEdge[];
}

export interface GraphNode {
  name: string;
  type: string;
  description?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  relation?: string;
}

export interface SearchHit {
  name: string;
  description: string;
  type: string;
  snippet: string;
  score: number;
  /**
   * Which engine surfaced this hit (Phase 5, additive/optional). `fts` = exact
   * full-text; `semantic` = embedding cosine. In `hybrid` mode a hit found by
   * both is tagged `fts` (the lexical match is the stronger signal to show);
   * hits only the embeddings found are tagged `semantic`.
   */
  via?: 'fts' | 'semantic';
}

/** Search entry point — `text` (FTS), `semantic` (embeddings), or `hybrid`. */
export type SearchMode = 'text' | 'semantic' | 'hybrid';

export interface MemoryGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// --- Errors -----------------------------------------------------------------

export class MemoryError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'MemoryError';
  }
}

/** Optimistic-lock failure — thrown (never swallowed) so callers return 409. */
export class MemoryConflictError extends MemoryError {
  constructor(
    public readonly currentVersion: number,
    public readonly expectedVersion: number,
  ) {
    super(
      `version conflict: expected ${expectedVersion} but current is ${currentVersion}`,
      'VERSION_CONFLICT',
    );
    this.name = 'MemoryConflictError';
  }
}

// --- Internal row + parse shapes --------------------------------------------

interface NodeRow {
  name: string;
  description: string;
  type: string;
  team: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  version: number;
  body: string;
  metadata: string | null;
}

interface VectorRow {
  name: string;
  dim: number;
  model: string;
  vector: Buffer;
  updated_at: number;
}

interface VectorJoinRow {
  name: string;
  description: string;
  type: string;
  body: string;
  vector: Buffer;
  dim: number;
}

interface ParsedNote {
  name: string;
  description: string;
  type: string;
  team: string | null;
  createdBy: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  version: number;
  metadata: Record<string, unknown>;
  body: string;
}

export interface UpsertNoteInput {
  name: string;
  description: string;
  type: string;
  body: string;
  /** Provenance is MANDATORY (docs §11) — who wrote it. */
  createdBy: string;
  /** Provenance — which orchestrator/team; `null` for operator/web writes. */
  team: string | null;
  /** Optimistic lock: when provided AND the note exists, must equal current version. */
  expectedVersion?: number | null;
  /** Optional structured metadata, round-tripped into the frontmatter. */
  metadata?: Record<string, unknown>;
}

/** Relation used for edges auto-derived from `[[wikilinks]]` in the body. */
const AUTO_RELATION = 'links';
/** Default relation for a manual `addLink` when none is supplied. */
const DEFAULT_LINK_RELATION = 'related';

/**
 * Edge provenance. `body` edges are DERIVED from the markdown (plain wikilinks
 * + typed Dataview fields) and are re-derived on every write / boot reindex, so
 * they are durable and portable. `manual` edges come from `addLink` (MCP
 * `memory.link`) and live ONLY in SQLite — they survive body re-derivation but
 * NOT a from-scratch reindex (documented escape hatch; prefer body-encoded
 * typed links for anything durable).
 */
const EDGE_ORIGIN_BODY = 'body';
const EDGE_ORIGIN_MANUAL = 'manual';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_NAME_LEN = 200;
const MAX_DEPTH = 4;

/** Extract `[[target]]` / `[[target|alias]]` link targets from a body. */
export function parseWikiLinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const raw = (m[1] ?? '').split('|')[0]?.trim() ?? '';
    if (raw) out.add(raw);
  }
  return [...out];
}

/** One typed link derived from the body: a `relation → target` edge. */
export interface TypedLink {
  relation: string;
  target: string;
}

/**
 * Typed-link syntax = **Dataview inline fields whose value is a `[[wikilink]]`**
 * — a well-specified, Obsidian/Dataview-compatible way to carry a *typed*
 * relation INSIDE the markdown body, so it survives a reindex (unlike a
 * SQLite-only `addLink`). Two forms are recognised:
 *
 *   1. Whole-line field:      `depends_on:: [[db-schema]]`
 *                             `related:: [[a]], [[b]]`   (several targets ok)
 *   2. Bracketed inline field: `… as noted [supersedes:: [[old-plan]]] here.`
 *                              (`(rel:: [[x]])` parens form too, single target)
 *
 * The relation key is `[A-Za-z][A-Za-z0-9_-]*`. A field whose value carries NO
 * wikilink (e.g. `rating:: 5`) is NOT a typed link and is ignored here. Plain
 * `[[wikilinks]]` stay relation='links' (see `AUTO_RELATION`).
 *
 * Regexes are built fresh per call so the shared `g`-flag `lastIndex` can never
 * leak between `matchAll`/`replace` uses (a 24/7 correctness footgun).
 */
const TYPED_LINE_SRC = String.raw`^[ \t]*([A-Za-z][A-Za-z0-9_-]*)[ \t]*::[ \t]*(.+?)[ \t]*$`;
const TYPED_INLINE_SRC = String.raw`[[(]\s*([A-Za-z][A-Za-z0-9_-]*)\s*::\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*[\])]`;
const WIKILINK_IN_VALUE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

export function parseTypedLinks(body: string): TypedLink[] {
  const out: TypedLink[] = [];
  const seen = new Set<string>();
  const push = (relation: string, rawTarget: string): void => {
    const rel = relation.trim();
    const target = rawTarget.trim();
    if (!rel || !target) return;
    const key = `${rel}\u0000${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ relation: rel, target });
  };
  // Bracketed inline fields (single wikilink value).
  for (const m of body.matchAll(new RegExp(TYPED_INLINE_SRC, 'g'))) {
    push(m[1] ?? '', m[2] ?? '');
  }
  // Whole-line fields; the value may hold several wikilinks.
  for (const m of body.matchAll(new RegExp(TYPED_LINE_SRC, 'gm'))) {
    const rel = m[1] ?? '';
    for (const w of (m[2] ?? '').matchAll(WIKILINK_IN_VALUE)) push(rel, w[1] ?? '');
  }
  return out;
}

/**
 * Blank out every typed-link field span so the remaining `[[wikilinks]]` can be
 * parsed as PLAIN links without double-counting a target that a typed field
 * already claimed. A whole-line field is only stripped when it actually carried
 * a wikilink (a real typed link), leaving prose / scalar fields untouched.
 */
export function stripTypedLinks(body: string): string {
  return body
    .replace(new RegExp(TYPED_INLINE_SRC, 'g'), ' ')
    .replace(new RegExp(TYPED_LINE_SRC, 'gm'), (line, _key: string, value: string) =>
      /\[\[[^\]]+\]\]/.test(value) ? ' ' : line,
    );
}

function isoToMillis(iso: string | undefined, fallback: number): number {
  if (!iso) return fallback;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : fallback;
}

/** Serialize one frontmatter scalar as JSON (valid YAML too) for safe round-trip. */
function fmScalar(v: string): string {
  return JSON.stringify(v);
}

/**
 * Parse a note's markdown (frontmatter + body). Tolerant: a missing/garbled
 * frontmatter yields sensible defaults so a hand-edited or partial file still
 * indexes. `name` falls back to the caller-supplied slug (the filename).
 */
export function parseNote(raw: string, fallbackName: string): ParsedNote {
  const now = Date.now();
  let fm = '';
  let body = raw;
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (m) {
    fm = m[1] ?? '';
    body = m[2] ?? '';
  }
  const fields: Record<string, unknown> = {};
  for (const line of fm.split(/\r?\n/)) {
    const lm = /^([A-Za-z_][A-Za-z0-9_]*):\s?(.*)$/.exec(line);
    if (!lm) continue;
    const key = lm[1]!;
    const rawVal = (lm[2] ?? '').trim();
    if (rawVal === '') {
      fields[key] = '';
      continue;
    }
    try {
      fields[key] = JSON.parse(rawVal) as unknown;
    } catch {
      fields[key] = rawVal;
    }
  }
  const asStr = (v: unknown): string | null =>
    typeof v === 'string' ? v : v == null ? null : String(v);
  const name = asStr(fields.name) || fallbackName;
  const description = asStr(fields.description) ?? '';
  const type = asStr(fields.type) ?? 'reference';
  const team = asStr(fields.team);
  const createdBy = asStr(fields.created_by);
  const createdAtMs = isoToMillis(asStr(fields.created_at) ?? undefined, now);
  const updatedAtMs = isoToMillis(asStr(fields.updated_at) ?? undefined, createdAtMs);
  const versionNum = Number(fields.version);
  const version = Number.isFinite(versionNum) && versionNum > 0 ? Math.floor(versionNum) : 1;
  const metadata =
    fields.metadata && typeof fields.metadata === 'object' && !Array.isArray(fields.metadata)
      ? (fields.metadata as Record<string, unknown>)
      : {};
  return {
    name,
    description,
    type,
    team,
    createdBy,
    createdAtMs,
    updatedAtMs,
    version,
    metadata,
    body: body.replace(/^\r?\n/, ''),
  };
}

/** Render a note back to `<frontmatter>\n<body>` markdown. */
export function serializeNote(p: {
  name: string;
  description: string;
  type: string;
  team: string | null;
  createdBy: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  version: number;
  metadata: Record<string, unknown>;
  body: string;
}): string {
  const lines = [
    '---',
    `name: ${fmScalar(p.name)}`,
    `description: ${fmScalar(p.description)}`,
    `type: ${fmScalar(p.type)}`,
    `metadata: ${JSON.stringify(p.metadata ?? {})}`,
    `created_by: ${p.createdBy == null ? 'null' : fmScalar(p.createdBy)}`,
    `team: ${p.team == null ? 'null' : fmScalar(p.team)}`,
    `created_at: ${fmScalar(new Date(p.createdAtMs).toISOString())}`,
    `updated_at: ${fmScalar(new Date(p.updatedAtMs).toISOString())}`,
    `version: ${p.version}`,
    '---',
    '',
  ];
  const body = p.body.endsWith('\n') ? p.body : `${p.body}\n`;
  return `${lines.join('\n')}${body}`;
}

export class MemoryStore {
  private readonly db: Db;
  private readonly vaultDir: string;
  private readonly eventBus: SwarmEventBus | null;
  private readonly embeddings: EmbeddingProvider;

  // Non-blocking embedding pipeline: upsert/reindex enqueue a name here and a
  // single background drainer computes + stores the vector. A note write NEVER
  // waits on (or fails because of) embedding — see `enqueueEmbed`.
  private readonly embedQueue = new Set<string>();
  private embedDraining: Promise<void> | null = null;

  private readonly getVectorStmt;
  private readonly upsertVectorStmt;
  private readonly deleteVectorStmt;
  private readonly listVectorsStmt;
  private readonly listVectorsByTypeStmt;
  private readonly missingVectorsStmt;

  private readonly getNodeStmt;
  private readonly upsertNodeStmt;
  private readonly deleteNodeStmt;
  private readonly listAllStmt;
  private readonly listByTypeStmt;
  private readonly ftsDeleteStmt;
  private readonly ftsInsertStmt;
  private readonly deleteBodyEdgesStmt;
  private readonly bodyEdgesStmt;
  private readonly insertEdgeStmt;
  private readonly distinctRelationsStmt;
  private readonly deleteEdgesForNodeStmt;
  private readonly outEdgesStmt;
  private readonly inEdgesStmt;
  private readonly allEdgesStmt;

  constructor(
    swarmDb: SwarmDb,
    opts: { dataDir: string; eventBus?: SwarmEventBus; embeddings?: EmbeddingProvider },
  ) {
    this.db = swarmDb.db;
    this.vaultDir = path.join(opts.dataDir, 'memory');
    this.eventBus = opts.eventBus ?? null;
    // Default to the safe local (deterministic, offline) provider so semantic
    // search works out of the box and the server never depends on network.
    this.embeddings = opts.embeddings ?? new HashingEmbeddingProvider();

    try {
      fs.mkdirSync(this.vaultDir, { recursive: true });
    } catch (err) {
      log.warn({ event: 'memory.vault_mkdir_failed', error: String(err) });
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_nodes (
        name        TEXT PRIMARY KEY,
        description TEXT NOT NULL DEFAULT '',
        type        TEXT NOT NULL,
        team        TEXT,
        created_by  TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        version     INTEGER NOT NULL DEFAULT 1,
        body        TEXT NOT NULL DEFAULT '',
        metadata    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_type ON memory_nodes(type);
      CREATE TABLE IF NOT EXISTS memory_edges (
        src      TEXT NOT NULL,
        dst      TEXT NOT NULL,
        relation TEXT NOT NULL DEFAULT '${AUTO_RELATION}',
        origin   TEXT NOT NULL DEFAULT '${EDGE_ORIGIN_BODY}',
        PRIMARY KEY (src, dst, relation)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_edges_dst ON memory_edges(dst);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(name, description, body);
      -- Phase 5 semantic index. Vectors are DERIVED from the notes (name +
      -- description + body) and live ONLY here — never written into the .md
      -- source of truth. model/dim let a provider change re-derive stale
      -- vectors on the next boot. Same ownership pattern as the tables above.
      CREATE TABLE IF NOT EXISTS memory_vectors (
        name       TEXT PRIMARY KEY,
        dim        INTEGER NOT NULL,
        model      TEXT NOT NULL,
        vector     BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    // Idempotent migration for instances whose `memory_edges` predates the
    // `origin` column (CREATE TABLE IF NOT EXISTS skips an existing table
    // wholesale — same pattern as SwarmDb.applyMigrations / UpdateStore).
    this.applyEdgeOriginMigration();

    this.getNodeStmt = this.db.prepare<[string], NodeRow>(
      'SELECT * FROM memory_nodes WHERE name = ?',
    );
    this.upsertNodeStmt = this.db.prepare<NodeRow>(`
      INSERT INTO memory_nodes (
        name, description, type, team, created_by, created_at, updated_at, version, body, metadata
      ) VALUES (
        @name, @description, @type, @team, @created_by, @created_at, @updated_at, @version, @body, @metadata
      )
      ON CONFLICT(name) DO UPDATE SET
        description = excluded.description,
        type = excluded.type,
        team = excluded.team,
        created_by = excluded.created_by,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        version = excluded.version,
        body = excluded.body,
        metadata = excluded.metadata
    `);
    this.deleteNodeStmt = this.db.prepare<[string]>('DELETE FROM memory_nodes WHERE name = ?');
    this.listAllStmt = this.db.prepare<[], NodeRow>(
      'SELECT * FROM memory_nodes ORDER BY updated_at DESC',
    );
    this.listByTypeStmt = this.db.prepare<[string], NodeRow>(
      'SELECT * FROM memory_nodes WHERE type = ? ORDER BY updated_at DESC',
    );
    this.ftsDeleteStmt = this.db.prepare<[string]>('DELETE FROM memory_fts WHERE name = ?');
    this.ftsInsertStmt = this.db.prepare<[string, string, string]>(
      'INSERT INTO memory_fts (name, description, body) VALUES (?, ?, ?)',
    );
    this.deleteBodyEdgesStmt = this.db.prepare<[string]>(
      `DELETE FROM memory_edges WHERE src = ? AND origin = '${EDGE_ORIGIN_BODY}'`,
    );
    this.bodyEdgesStmt = this.db.prepare<[string], { dst: string; relation: string }>(
      `SELECT dst, relation FROM memory_edges WHERE src = ? AND origin = '${EDGE_ORIGIN_BODY}'`,
    );
    this.insertEdgeStmt = this.db.prepare<[string, string, string, string]>(
      'INSERT OR IGNORE INTO memory_edges (src, dst, relation, origin) VALUES (?, ?, ?, ?)',
    );
    this.distinctRelationsStmt = this.db.prepare<[], { relation: string }>(
      'SELECT DISTINCT relation FROM memory_edges ORDER BY relation ASC',
    );
    this.deleteEdgesForNodeStmt = this.db.prepare<[string, string]>(
      'DELETE FROM memory_edges WHERE src = ? OR dst = ?',
    );
    this.outEdgesStmt = this.db.prepare<[string], { dst: string; relation: string }>(
      'SELECT dst, relation FROM memory_edges WHERE src = ? ORDER BY dst ASC',
    );
    this.inEdgesStmt = this.db.prepare<[string], { src: string; relation: string }>(
      'SELECT src, relation FROM memory_edges WHERE dst = ? ORDER BY src ASC',
    );
    this.allEdgesStmt = this.db.prepare<[], { src: string; dst: string; relation: string }>(
      'SELECT src, dst, relation FROM memory_edges',
    );

    this.getVectorStmt = this.db.prepare<[string], VectorRow>(
      'SELECT name, dim, model, vector, updated_at FROM memory_vectors WHERE name = ?',
    );
    this.upsertVectorStmt = this.db.prepare<{
      name: string;
      dim: number;
      model: string;
      vector: Buffer;
      updated_at: number;
    }>(`
      INSERT INTO memory_vectors (name, dim, model, vector, updated_at)
      VALUES (@name, @dim, @model, @vector, @updated_at)
      ON CONFLICT(name) DO UPDATE SET
        dim = excluded.dim, model = excluded.model,
        vector = excluded.vector, updated_at = excluded.updated_at
    `);
    this.deleteVectorStmt = this.db.prepare<[string]>('DELETE FROM memory_vectors WHERE name = ?');
    this.listVectorsStmt = this.db.prepare<[], VectorJoinRow>(`
      SELECT n.name AS name, n.description AS description, n.type AS type, n.body AS body,
             v.vector AS vector, v.dim AS dim
      FROM memory_vectors v JOIN memory_nodes n ON n.name = v.name
    `);
    this.listVectorsByTypeStmt = this.db.prepare<[string], VectorJoinRow>(`
      SELECT n.name AS name, n.description AS description, n.type AS type, n.body AS body,
             v.vector AS vector, v.dim AS dim
      FROM memory_vectors v JOIN memory_nodes n ON n.name = v.name
      WHERE n.type = ?
    `);
    // Nodes with no vector, or a vector from a different model/dim (stale) —
    // re-embedded lazily so vectors stay re-derivable from the notes.
    this.missingVectorsStmt = this.db.prepare<[string, number], { name: string }>(`
      SELECT n.name AS name
      FROM memory_nodes n LEFT JOIN memory_vectors v ON v.name = n.name
      WHERE v.name IS NULL OR v.model != ? OR v.dim != ?
    `);

    this.reindexVault();
    this.backfillEmbeddings();
  }

  // --- helpers --------------------------------------------------------------

  private assertValidName(name: string): void {
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LEN) {
      throw new MemoryError(`invalid note name (1-${MAX_NAME_LEN} chars)`, 'INVALID_NAME');
    }
    if (name.includes('..') || name.includes('/') || name.includes('\\') || !NAME_RE.test(name)) {
      throw new MemoryError(
        `invalid note name '${name}': use [A-Za-z0-9._-], kebab-case slug, no path separators`,
        'INVALID_NAME',
      );
    }
  }

  private normalizeType(type: string): MemoryNoteType {
    return (MEMORY_NOTE_TYPES as readonly string[]).includes(type)
      ? (type as MemoryNoteType)
      : 'reference';
  }

  private fileFor(name: string): string {
    const full = path.join(this.vaultDir, `${name}.md`);
    // Defence in depth: the resolved path must stay inside the vault.
    const rel = path.relative(this.vaultDir, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new MemoryError(`refusing to write outside the vault: ${name}`, 'INVALID_NAME');
    }
    return full;
  }

  private rowToMeta(row: NodeRow): MemoryNoteMeta {
    return {
      name: row.name,
      description: row.description,
      type: this.normalizeType(row.type),
      ...(row.team ? { team: row.team } : {}),
      ...(row.created_by ? { createdBy: row.created_by } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version,
    };
  }

  private emit(kind: 'memory.node_created' | 'memory.node_updated' | 'memory.node_deleted', name: string, type: string): void {
    try {
      this.eventBus?.emitEvent({ kind, payload: { name, type } });
    } catch (err) {
      log.warn({ event: 'memory.emit_failed', kind, error: String(err) });
    }
  }

  private emitEdge(from: string, to: string): void {
    try {
      this.eventBus?.emitEvent({ kind: 'memory.edge_created', payload: { from, to } });
    } catch (err) {
      log.warn({ event: 'memory.emit_failed', kind: 'memory.edge_created', error: String(err) });
    }
  }

  /**
   * Add the `origin` column to a pre-existing `memory_edges`. The duplicate
   * -column error is the normal outcome from the second boot on and is
   * swallowed; anything else is logged (never thrown — a migration hiccup must
   * not crash the 24/7 server).
   */
  private applyEdgeOriginMigration(): void {
    try {
      this.db.exec(
        `ALTER TABLE memory_edges ADD COLUMN origin TEXT NOT NULL DEFAULT '${EDGE_ORIGIN_BODY}'`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name/i.test(msg)) {
        log.warn({ event: 'memory.edge_origin_migration_failed', error: msg });
      }
    }
  }

  /**
   * Rebuild `memory_fts` + all BODY-derived edges for one node from its body:
   * typed edges from Dataview inline fields (`relation:: [[target]]`) plus plain
   * `links` edges from the remaining `[[wikilinks]]`. Body edges are wiped and
   * re-derived every time, so they survive a reindex; `manual` (addLink) edges
   * are left untouched.
   */
  private indexDerived(name: string, description: string, body: string, emitEdges: boolean): void {
    this.ftsDeleteStmt.run(name);
    this.ftsInsertStmt.run(name, description, body);

    // Snapshot existing body edges so we only fire events for genuinely new ones.
    const existing = new Set(this.bodyEdgesStmt.all(name).map((e) => `${e.dst} ${e.relation}`));
    this.deleteBodyEdgesStmt.run(name);

    const inserted = new Set<string>();
    const addEdge = (target: string, relation: string): void => {
      if (!target || target === name) return; // no self-loops
      const key = `${target} ${relation}`;
      if (inserted.has(key)) return;
      inserted.add(key);
      this.insertEdgeStmt.run(name, target, relation, EDGE_ORIGIN_BODY);
      if (emitEdges && !existing.has(key)) this.emitEdge(name, target);
    };

    // Typed links first (they claim their targets); then plain wikilinks from
    // the body with the typed-field spans stripped, so a typed target isn't also
    // counted as a plain `links` edge.
    for (const t of parseTypedLinks(body)) addEdge(t.target, t.relation);
    for (const target of parseWikiLinks(stripTypedLinks(body))) addEdge(target, AUTO_RELATION);
  }

  // --- boot reindex ---------------------------------------------------------

  /** Index every `.md` in the vault that the SQLite mirror doesn't know yet. */
  private reindexVault(): void {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.vaultDir).filter((f) => f.endsWith('.md'));
    } catch (err) {
      log.warn({ event: 'memory.reindex_readdir_failed', error: String(err) });
      return;
    }
    let indexed = 0;
    for (const file of files) {
      const name = file.slice(0, -3);
      try {
        if (!NAME_RE.test(name)) continue;
        if (this.getNodeStmt.get(name)) continue; // already mirrored
        const raw = fs.readFileSync(path.join(this.vaultDir, file), 'utf8');
        const p = parseNote(raw, name);
        const type = this.normalizeType(p.type);
        this.db.transaction(() => {
          this.upsertNodeStmt.run({
            name,
            description: p.description,
            type,
            team: p.team,
            created_by: p.createdBy,
            created_at: p.createdAtMs,
            updated_at: p.updatedAtMs,
            version: p.version,
            body: p.body,
            metadata: JSON.stringify(p.metadata ?? {}),
          });
          this.indexDerived(name, p.description, p.body, false);
        })();
        indexed++;
      } catch (err) {
        log.warn({ event: 'memory.reindex_file_failed', file, error: String(err) });
      }
    }
    if (indexed > 0) log.info({ event: 'memory.reindexed', indexed, scanned: files.length });
  }

  // --- public API -----------------------------------------------------------

  /**
   * Create or update a note. Writes the file AND the index atomically (index in
   * a transaction; the file is written first so a crash leaves a readable vault
   * that the next boot reindexes). Bumps `version`, re-derives edges from
   * `[[links]]`. Optimistic lock: when `expectedVersion` is supplied and the
   * note exists, a mismatch throws `MemoryConflictError`.
   */
  upsertNote(input: UpsertNoteInput): { name: string; version: number } {
    this.assertValidName(input.name);
    const type = this.normalizeType(input.type);
    const existing = this.getNodeStmt.get(input.name) ?? null;

    if (
      existing &&
      input.expectedVersion != null &&
      input.expectedVersion !== existing.version
    ) {
      throw new MemoryConflictError(existing.version, input.expectedVersion);
    }

    const now = Date.now();
    const createdAtMs = existing ? existing.created_at : now;
    const version = existing ? existing.version + 1 : 1;
    const description = input.description ?? '';
    const body = input.body ?? '';
    const metadata =
      input.metadata ??
      (existing?.metadata ? (safeParseObj(existing.metadata) ?? {}) : {});

    const file = this.fileFor(input.name);
    const content = serializeNote({
      name: input.name,
      description,
      type,
      team: input.team ?? null,
      createdBy: input.createdBy ?? null,
      createdAtMs,
      updatedAtMs: now,
      version,
      metadata,
      body,
    });

    // File is the source of truth: write it first.
    fs.writeFileSync(file, content, 'utf8');

    this.db.transaction(() => {
      this.upsertNodeStmt.run({
        name: input.name,
        description,
        type,
        team: input.team ?? null,
        created_by: input.createdBy ?? null,
        created_at: createdAtMs,
        updated_at: now,
        version,
        body,
        metadata: JSON.stringify(metadata),
      });
      this.indexDerived(input.name, description, body, true);
    })();

    this.emit(existing ? 'memory.node_updated' : 'memory.node_created', input.name, type);
    // Embedding is computed OUT of band — the write already succeeded and must
    // not wait on (or be failed by) the embedding provider.
    this.enqueueEmbed(input.name);
    return { name: input.name, version };
  }

  /** Full note (meta + body + neighbours). `null` when absent. */
  readNote(name: string): MemoryNote | null {
    try {
      const row = this.getNodeStmt.get(name);
      if (!row) return null;
      const outRows = this.outEdgesStmt.all(name);
      const inRows = this.inEdgesStmt.all(name);
      const outLinks = [...new Set(outRows.map((e) => e.dst))];
      const inLinks = [...new Set(inRows.map((e) => e.src))];
      const outEdges = outRows.map((e) => ({ to: e.dst, relation: e.relation }));
      const inEdges = inRows.map((e) => ({ from: e.src, relation: e.relation }));
      return { ...this.rowToMeta(row), body: row.body, outLinks, inLinks, outEdges, inEdges };
    } catch (err) {
      log.warn({ event: 'memory.read_failed', name, error: String(err) });
      return null;
    }
  }

  /** FTS5-ranked search. `type` optionally narrows; `limit` defaults to 20. */
  search(query: string, type?: string | null, limit = 20): SearchHit[] {
    const tokens = (query ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (tokens.length === 0) return [];
    const match = tokens.map((t) => `${t}*`).join(' ');
    const cap = Math.max(1, Math.min(100, Math.floor(limit) || 20));
    try {
      const typeClause = type ? 'AND n.type = @type' : '';
      const stmt = this.db.prepare<
        { match: string; type?: string; limit: number },
        { name: string; description: string; type: string; snippet: string; score: number }
      >(`
        SELECT n.name AS name, n.description AS description, n.type AS type,
               snippet(memory_fts, 2, '[', ']', '…', 12) AS snippet,
               bm25(memory_fts) AS score
        FROM memory_fts
        JOIN memory_nodes n ON n.name = memory_fts.name
        WHERE memory_fts MATCH @match ${typeClause}
        ORDER BY bm25(memory_fts) ASC
        LIMIT @limit
      `);
      const rows = stmt.all({ match, ...(type ? { type } : {}), limit: cap });
      // bm25 is negative (more negative = more relevant); expose a positive,
      // higher-is-better relevance so `SearchHit.score` reads intuitively.
      return rows.map((r) => ({
        name: r.name,
        description: r.description,
        type: r.type,
        snippet: r.snippet,
        score: Math.round(-r.score * 1000) / 1000,
      }));
    } catch (err) {
      log.warn({ event: 'memory.search_failed', error: String(err) });
      return [];
    }
  }

  /** Note metadata list, optionally filtered by `type` and/or name `prefix`. */
  list(type?: string | null, prefix?: string | null): MemoryNoteMeta[] {
    try {
      const rows = type ? this.listByTypeStmt.all(type) : this.listAllStmt.all();
      const filtered =
        prefix && prefix.length > 0 ? rows.filter((r) => r.name.startsWith(prefix)) : rows;
      return filtered.map((r) => this.rowToMeta(r));
    } catch (err) {
      log.warn({ event: 'memory.list_failed', error: String(err) });
      return [];
    }
  }

  /** The whole graph (every node + edge) — backs `GET /api/memory/graph`. */
  graph(): MemoryGraph {
    try {
      const nodes: GraphNode[] = this.listAllStmt.all().map((r) => ({
        name: r.name,
        type: this.normalizeType(r.type),
        description: r.description,
      }));
      const edges: GraphEdge[] = this.allEdgesStmt.all().map((e) => ({
        from: e.src,
        to: e.dst,
        ...(e.relation && e.relation !== AUTO_RELATION ? { relation: e.relation } : {}),
      }));
      return { nodes, edges };
    } catch (err) {
      log.warn({ event: 'memory.graph_failed', error: String(err) });
      return { nodes: [], edges: [] };
    }
  }

  /** Sub-graph around `name` out to `depth` hops (both directions). */
  neighbors(name: string, depth = 1): MemoryGraph {
    const d = Math.max(1, Math.min(MAX_DEPTH, Math.floor(depth) || 1));
    try {
      const seen = new Set<string>([name]);
      let frontier = [name];
      const edges: GraphEdge[] = [];
      const edgeKey = new Set<string>();
      for (let hop = 0; hop < d; hop++) {
        const next: string[] = [];
        for (const node of frontier) {
          const collect = (from: string, to: string, relation: string): void => {
            const key = `${from} ${to} ${relation}`;
            if (edgeKey.has(key)) return;
            edgeKey.add(key);
            edges.push({ from, to, ...(relation !== AUTO_RELATION ? { relation } : {}) });
          };
          for (const e of this.outEdgesStmt.all(node)) {
            collect(node, e.dst, e.relation);
            if (!seen.has(e.dst)) {
              seen.add(e.dst);
              next.push(e.dst);
            }
          }
          for (const e of this.inEdgesStmt.all(node)) {
            collect(e.src, node, e.relation);
            if (!seen.has(e.src)) {
              seen.add(e.src);
              next.push(e.src);
            }
          }
        }
        frontier = next;
        if (frontier.length === 0) break;
      }
      const nodes: GraphNode[] = [];
      for (const n of seen) {
        const row = this.getNodeStmt.get(n);
        if (row) nodes.push({ name: row.name, type: this.normalizeType(row.type), description: row.description });
        else nodes.push({ name: n, type: 'reference' }); // dangling link target
      }
      return { nodes, edges };
    } catch (err) {
      log.warn({ event: 'memory.neighbors_failed', name, error: String(err) });
      return { nodes: [], edges: [] };
    }
  }

  /**
   * Add a MANUAL typed edge between two notes (MCP `memory.link`). Stored with
   * `origin='manual'` so a body re-derivation does not wipe it — but it lives
   * only in SQLite (not re-derivable from any file), so a from-scratch reindex
   * drops it. For a durable typed relation, encode it in the body as
   * `relation:: [[target]]` instead. Returns false on failure (logged).
   */
  addLink(from: string, to: string, relation?: string | null): boolean {
    try {
      if (!from || !to) throw new MemoryError('from and to are required', 'INVALID_LINK');
      const rel = relation && relation.length > 0 ? relation : DEFAULT_LINK_RELATION;
      this.insertEdgeStmt.run(from, to, rel, EDGE_ORIGIN_MANUAL);
      this.emitEdge(from, to);
      return true;
    } catch (err) {
      log.warn({ event: 'memory.add_link_failed', from, to, error: String(err) });
      return false;
    }
  }

  /** Distinct relation labels currently present on any edge. Empty on failure. */
  listRelations(): string[] {
    try {
      return this.distinctRelationsStmt.all().map((r) => r.relation);
    } catch (err) {
      log.warn({ event: 'memory.list_relations_failed', error: String(err) });
      return [];
    }
  }

  /** Delete a note: its file, its index row, its FTS entry, and all its edges. */
  deleteNote(name: string): boolean {
    try {
      const row = this.getNodeStmt.get(name);
      const type = row ? this.normalizeType(row.type) : 'reference';
      this.db.transaction(() => {
        this.deleteNodeStmt.run(name);
        this.ftsDeleteStmt.run(name);
        this.deleteEdgesForNodeStmt.run(name, name);
        this.deleteVectorStmt.run(name);
      })();
      this.embedQueue.delete(name);
      try {
        fs.rmSync(this.fileFor(name), { force: true });
      } catch (err) {
        log.warn({ event: 'memory.delete_file_failed', name, error: String(err) });
      }
      if (row) this.emit('memory.node_deleted', name, type);
      return row != null;
    } catch (err) {
      log.warn({ event: 'memory.delete_failed', name, error: String(err) });
      return false;
    }
  }

  // --- semantic search (Phase 5) --------------------------------------------

  /** What the active embedding provider offers — backs `/api/memory/capabilities`. */
  embeddingInfo(): EmbeddingCapabilities {
    return this.embeddings.capabilities();
  }

  /** True when semantic search is usable (provider is not `none`). */
  private get semanticEnabled(): boolean {
    return this.embeddings.kind !== 'none';
  }

  /** Enqueue a note for background (re)embedding. Non-blocking, never throws. */
  private enqueueEmbed(name: string): void {
    if (!this.semanticEnabled) return;
    this.embedQueue.add(name);
    this.kickEmbedDrain();
  }

  /** Enqueue every node lacking an up-to-date vector (stale model/dim or none). */
  private backfillEmbeddings(): void {
    if (!this.semanticEnabled) return;
    try {
      const rows = this.missingVectorsStmt.all(this.embeddings.model, this.embeddings.dim);
      for (const r of rows) this.embedQueue.add(r.name);
      if (rows.length > 0) this.kickEmbedDrain();
    } catch (err) {
      log.warn({ event: 'memory.embed_backfill_failed', error: String(err) });
    }
  }

  /** Start the single background drainer if one is not already running. */
  private kickEmbedDrain(): void {
    if (this.embedDraining) return;
    this.embedDraining = this.drainEmbedQueue().finally(() => {
      this.embedDraining = null;
    });
  }

  /** Process the queue one note at a time. Each failure is isolated + logged. */
  private async drainEmbedQueue(): Promise<void> {
    while (this.embedQueue.size > 0) {
      const name = this.embedQueue.values().next().value as string;
      this.embedQueue.delete(name);
      await this.embedNode(name);
    }
  }

  /** Compute + persist one note's vector. Never throws (logs on failure). */
  private async embedNode(name: string): Promise<void> {
    try {
      if (!this.semanticEnabled) return;
      const row = this.getNodeStmt.get(name);
      if (!row) return; // deleted meanwhile
      const text = `${row.name}\n${row.description}\n${row.body}`;
      const vec = await this.embeddings.embedOne(text);
      if (!vec || vec.length === 0) return; // failed — leave prior/absent vector
      this.upsertVectorStmt.run({
        name,
        dim: vec.length,
        model: this.embeddings.model,
        vector: encodeVector(vec),
        updated_at: Date.now(),
      });
    } catch (err) {
      log.warn({ event: 'memory.embed_node_failed', name, error: String(err) });
    }
  }

  /**
   * Wait for the background embedding queue to settle. FOR TESTS and for callers
   * that want vectors present before searching; production search does not need
   * it (it just ranks whatever vectors exist so far).
   */
  async flushEmbeddings(): Promise<void> {
    while (this.embedDraining) await this.embedDraining;
  }

  /** A short snippet from the body around the first query token (else the head). */
  private snippetFor(body: string, tokens: string[]): string {
    const text = (body ?? '').replace(/\s+/g, ' ').trim();
    if (text.length === 0) return '';
    const lower = text.toLowerCase();
    let at = -1;
    for (const t of tokens) {
      const i = lower.indexOf(t);
      if (i >= 0 && (at < 0 || i < at)) at = i;
    }
    const start = at < 0 ? 0 : Math.max(0, at - 30);
    const slice = text.slice(start, start + 160);
    return (start > 0 ? '…' : '') + slice + (start + 160 < text.length ? '…' : '');
  }

  /**
   * Embedding-ranked search: embed the query, rank candidate vectors by cosine.
   * Returns `[]` (never throws) when semantic is unavailable, the query is
   * empty, or the query cannot be embedded — the caller then falls back to FTS.
   */
  async searchSemantic(
    query: string,
    opts: { limit?: number; type?: string | null } = {},
  ): Promise<SearchHit[]> {
    try {
      if (!this.semanticEnabled) return [];
      const q = (query ?? '').trim();
      if (q.length === 0) return [];
      const cap = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 20) || 20));
      const qv = await this.embeddings.embedOne(q);
      if (!qv || qv.length === 0) return [];

      const tokens = q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
      const rows = opts.type
        ? this.listVectorsByTypeStmt.all(opts.type)
        : this.listVectorsStmt.all();

      const scored: Array<{ row: VectorJoinRow; sim: number }> = [];
      for (const row of rows) {
        if (row.dim !== qv.length) continue; // skip vectors from another model
        const sim = cosineSimilarity(qv, decodeVector(row.vector));
        if (sim > 0) scored.push({ row, sim });
      }
      scored.sort((a, b) => b.sim - a.sim);
      return scored.slice(0, cap).map(({ row, sim }) => ({
        name: row.name,
        description: row.description,
        type: row.type,
        snippet: this.snippetFor(row.body, tokens),
        score: Math.round(sim * 1000) / 1000,
        via: 'semantic' as const,
      }));
    } catch (err) {
      log.warn({ event: 'memory.search_semantic_failed', error: String(err) });
      return [];
    }
  }

  /**
   * Hybrid search: fuse the FTS and semantic rankings with Reciprocal Rank
   * Fusion (RRF, k=60). A note surfaced by BOTH is boosted and tagged `fts`
   * (the exact match is the stronger signal); a note only embeddings found is
   * tagged `semantic`. Degrades to plain FTS when semantic is unavailable.
   */
  async searchHybrid(
    query: string,
    opts: { limit?: number; type?: string | null } = {},
  ): Promise<SearchHit[]> {
    const cap = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 20) || 20));
    const pool = Math.max(cap, 20);
    const ftsHits = this.search(query, opts.type ?? null, pool);
    if (!this.semanticEnabled) {
      return ftsHits.slice(0, cap).map((h) => ({ ...h, via: 'fts' as const }));
    }
    const semHits = await this.searchSemantic(query, { limit: pool, type: opts.type ?? null });

    const K = 60;
    interface Fused {
      hit: SearchHit;
      rrf: number;
      via: 'fts' | 'semantic';
    }
    const acc = new Map<string, Fused>();
    ftsHits.forEach((h, i) => {
      acc.set(h.name, { hit: h, rrf: 1 / (K + i + 1), via: 'fts' });
    });
    semHits.forEach((h, i) => {
      const cur = acc.get(h.name);
      const add = 1 / (K + i + 1);
      if (cur) {
        cur.rrf += add; // present in both — boost, keep `fts` tag + its snippet
      } else {
        acc.set(h.name, { hit: h, rrf: add, via: 'semantic' });
      }
    });

    return [...acc.values()]
      .sort((a, b) => b.rrf - a.rrf)
      .slice(0, cap)
      .map(({ hit, rrf, via }) => ({
        name: hit.name,
        description: hit.description,
        type: hit.type,
        snippet: hit.snippet,
        score: Math.round(rrf * 100000) / 100000,
        via,
      }));
  }

  /** Unified entry: dispatch by mode. `text` is sync-fast; the others await. */
  async runSearch(
    query: string,
    opts: { mode?: SearchMode; limit?: number; type?: string | null } = {},
  ): Promise<SearchHit[]> {
    const mode = opts.mode ?? 'text';
    if (mode === 'semantic') {
      const hits = await this.searchSemantic(query, { limit: opts.limit, type: opts.type ?? null });
      // Graceful fallback: if semantic yields nothing usable, return FTS so the
      // caller/UI is never left empty-handed by an unconfigured backend.
      if (hits.length > 0 || this.semanticEnabled) return hits;
      return this.search(query, opts.type ?? null, opts.limit ?? 20).map((h) => ({
        ...h,
        via: 'fts' as const,
      }));
    }
    if (mode === 'hybrid') {
      return this.searchHybrid(query, { limit: opts.limit, type: opts.type ?? null });
    }
    return this.search(query, opts.type ?? null, opts.limit ?? 20).map((h) => ({
      ...h,
      via: 'fts' as const,
    }));
  }
}

function safeParseObj(json: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

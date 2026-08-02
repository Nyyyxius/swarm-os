/**
 * Read-side of the code graph: node search over a scope's `graph.json`.
 *
 * There is no `graphify query` verb (P0 correction b), so `codegraph.search`
 * is implemented here — a plain, dependency-free substring search over the
 * NetworkX node-link `graph.json` graphify already produced. It returns the
 * matching nodes with their `file:line`, which is exactly the compressed,
 * cited answer an agent wants instead of grepping/reading whole files.
 *
 * Never throws: a missing/corrupt graph.json comes back as `{ ok:false, reason }`.
 */

import * as fs from 'node:fs';
import { withModule } from '../../logger.js';

const log = withModule('codegraph.query');

export interface GraphNodeHit {
  /** graphify node id, e.g. `a_greet`. */
  id: string;
  /** Human label, e.g. `greet()`. */
  label: string;
  /** Source file relative to the scope root, or null. */
  file: string | null;
  /** 1-based line parsed from `source_location` (`"L3"` → 3), or null. */
  line: number | null;
  /** graphify `file_type` (`code` / `document`), or null. */
  fileType: string | null;
  /** Community label the node belongs to, or null. */
  community: string | null;
}

interface RawNode {
  id?: unknown;
  label?: unknown;
  norm_label?: unknown;
  source_file?: unknown;
  source_location?: unknown;
  file_type?: unknown;
  community_name?: unknown;
}

/** Parse a graphify `source_location` (`"L3"`, `"L3-L9"`) to a 1-based line. */
export function parseLine(loc: unknown): number | null {
  if (typeof loc !== 'string') return null;
  const m = /(\d+)/.exec(loc);
  return m ? Number(m[1]) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Read + parse a scope's graph.json. Returns null on any failure. */
export function readGraphJson(graphPath: string): { nodes: RawNode[]; links: unknown[] } | null {
  try {
    const g = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
    if (!g || typeof g !== 'object') return null;
    const nodes = Array.isArray(g.nodes) ? (g.nodes as RawNode[]) : [];
    const links = Array.isArray(g.links) ? (g.links as unknown[]) : [];
    return { nodes, links };
  } catch (err) {
    log.debug({ event: 'codegraph.graph_read_failed', graphPath, error: String(err) });
    return null;
  }
}

export type SearchResult =
  | { ok: true; results: GraphNodeHit[] }
  | { ok: false; reason: string };

/**
 * Rank nodes by how well they match `query` (case-insensitive):
 *   exact id/label == 100 · prefix == 50 · substring == 20 · file-name hit == +5.
 * Ties break by shorter label then alphabetical, so the tightest match wins.
 */
export function searchNodes(graphPath: string, query: string, limit: number): SearchResult {
  const graph = readGraphJson(graphPath);
  if (!graph) return { ok: false, reason: `graph.json not readable at ${graphPath}` };

  const q = query.trim().toLowerCase();
  if (q.length === 0) return { ok: false, reason: 'query must be non-empty' };

  const scored: Array<{ score: number; hit: GraphNodeHit }> = [];
  for (const n of graph.nodes) {
    const id = str(n.id);
    const label = str(n.label);
    if (!id && !label) continue;
    const idL = (id ?? '').toLowerCase();
    const labelL = (label ?? '').toLowerCase();
    // Compare labels both with and without a trailing `()` so `greet` matches `greet()`.
    const labelBare = labelL.replace(/\(\)$/, '');
    const norm = str(n.norm_label)?.toLowerCase() ?? '';
    const file = str(n.source_file);
    const fileL = (file ?? '').toLowerCase();

    let score = 0;
    if (idL === q || labelL === q || labelBare === q || norm === q) score = 100;
    else if (idL.startsWith(q) || labelL.startsWith(q) || labelBare.startsWith(q)) score = 50;
    else if (idL.includes(q) || labelL.includes(q) || norm.includes(q)) score = 20;
    if (score === 0 && fileL.includes(q)) score = 5;
    else if (score > 0 && fileL.includes(q)) score += 5;
    if (score === 0) continue;

    scored.push({
      score,
      hit: {
        id: id ?? label ?? '',
        label: label ?? id ?? '',
        file,
        line: parseLine(n.source_location),
        fileType: str(n.file_type),
        community: str(n.community_name),
      },
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.hit.label.length !== b.hit.label.length) return a.hit.label.length - b.hit.label.length;
    return a.hit.label < b.hit.label ? -1 : a.hit.label > b.hit.label ? 1 : 0;
  });

  return { ok: true, results: scored.slice(0, Math.max(1, limit)).map((s) => s.hit) };
}

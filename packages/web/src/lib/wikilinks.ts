// packages/web/src/lib/wikilinks.ts
//
// Pure parsing of Obsidian-style `[[wikilink]]` targets out of a note body.
// This is the client-side twin of what the server derives into `outLinks`;
// the web view uses it to render the graph optimistically before a fresh
// `/api/memory/graph` lands, and to preview a note's links while editing.
//
// Kept pure + colocated-tested (house convention) — no React, no DOM.

const WIKILINK_RE = /\[\[([^\][]+?)\]\]/g;

/**
 * Extract the ordered, de-duplicated list of note names referenced by
 * `[[name]]` / `[[name|alias]]` links in `body`.
 *
 * - The target is the part BEFORE a `|` (the alias is display-only).
 * - Whitespace around the target is trimmed.
 * - Empty targets (`[[]]`, `[[ ]]`) are ignored.
 * - Order of first appearance is preserved; later duplicates are dropped.
 */
export function parseWikilinks(body: string): string[] {
  if (!body) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(WIKILINK_RE)) {
    const raw = m[1] ?? '';
    const target = (raw.split('|')[0] ?? '').trim();
    if (!target) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}

/** Relation-key shape accepted by the server's typed-link parser. */
const RELATION_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Normalise a free-text relation label into a valid Dataview inline-field key:
 * lower-cased, spaces/slashes → `_`, illegal chars dropped, must start with a
 * letter. Returns `''` when nothing usable remains (caller should reject).
 * Mirrors the server's `[A-Za-z][A-Za-z0-9_-]*` contract so a UI-built line
 * round-trips into a typed edge.
 */
export function normalizeRelation(raw: string): string {
  const cleaned = (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s/]+/g, '_')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[^a-z]+/, '');
  return RELATION_KEY_RE.test(cleaned) ? cleaned : '';
}

/**
 * Build the durable typed-link line the server understands — a Dataview inline
 * field `relation:: [[target]]`. Returns `null` for an invalid relation/target
 * so the caller can surface an error instead of writing a no-op line.
 */
export function typedLinkLine(relation: string, target: string): string | null {
  const rel = normalizeRelation(relation);
  const to = (target ?? '').trim();
  if (!rel || !to) return null;
  return `${rel}:: [[${to}]]`;
}

/**
 * Append a typed-link line to a note body, keeping exactly one blank line before
 * it and avoiding a duplicate identical line. Returns the body unchanged when
 * the relation/target are invalid.
 */
export function appendTypedLink(body: string, relation: string, target: string): string {
  const line = typedLinkLine(relation, target);
  if (!line) return body;
  const base = body ?? '';
  if (base.split(/\r?\n/).some((l) => l.trim() === line)) return base;
  const trimmed = base.replace(/\s+$/, '');
  return trimmed.length === 0 ? `${line}\n` : `${trimmed}\n\n${line}\n`;
}

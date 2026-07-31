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

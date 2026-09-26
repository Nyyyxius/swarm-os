// Tool lists per role: parsing and display.
//
// A role carries four nullable lists (`leadTools`, `workerTools`,
// `leadMcpTools`, `workerMcpTools` — see `RoleView` in `api/client.ts`), edited
// as free-text fields. One parser for every surface that edits them (the
// dialog and the Roles page), so a list never parses one way here and another
// way there.
//
// Two states per list:
//
//   - `null` = no override, ALL tools (today's behaviour). An empty field
//     means exactly that, and is the only way back to it;
//   - a non-empty array = the override. The server answers 400 on `[]`, so
//     this module never produces one.

/**
 * Parse a tool-list field. Names are separated by new lines and/or commas;
 * each one is trimmed, blanks are dropped, duplicates removed (first
 * occurrence kept, order preserved). Spaces INSIDE a name are kept: they are
 * not a separator. Nothing left → `null` (all tools), never `[]`.
 */
export function parseToolList(text: string): string[] | null {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\n,]/)) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out.length > 0 ? out : null;
}

/**
 * Field value for a stored list: one name per line. `null` / absent (server
 * predating the feature) / `[]` → empty field, i.e. "all tools".
 */
export function toolListFieldValue(list: readonly string[] | null | undefined): string {
  return list && list.length > 0 ? list.join('\n') : '';
}

/** Read-only line for a stored list: `Tous` when there is no override. */
export function toolListSummary(list: readonly string[] | null | undefined): string {
  return list && list.length > 0 ? list.join(', ') : 'Tous';
}

/** The four tool lists of a role, as `RoleView` carries them. */
export interface RoleToolLists {
  leadTools?: string[] | null;
  workerTools?: string[] | null;
  leadMcpTools?: string[] | null;
  workerMcpTools?: string[] | null;
}

/** True when at least one of the four lists is an override (non-empty). */
export function hasToolRestrictions(role: RoleToolLists): boolean {
  return [role.leadTools, role.workerTools, role.leadMcpTools, role.workerMcpTools].some(
    (l) => l != null && l.length > 0,
  );
}

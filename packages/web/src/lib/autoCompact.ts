// packages/web/src/lib/autoCompact.ts
//
// Auto-compact threshold (docs/auto-compact.md, Lot 2) — the pure half of the
// per-role field, shared by the TWO forms that edit it: the AUTO-COMPACT
// section of `RolesPage` and the legacy `RoleDialog`. One module, exactly like
// `lib/budget.ts`, because a threshold that parses one way in the overlay and
// another way in the dialog is how a role ends up silently un-compacted.
//
// Since v0.10.1 a role carries TWO such fields, parsed by the same functions:
// `autoCompactPct` (the lead) and `workerAutoCompactPct` (the workers, whose
// instance default is 0 = off — docs/auto-compact.md §8.2).
//
// One nullable integer, three states (§3.3 of the plan):
//
//   - `null` / absent — inherit the instance default. The default itself is
//     NOT hardcoded in a component: `GET /roles` carries it as
//     `defaults.autoCompactPct`, and `DEFAULT_AUTO_COMPACT_PCT` below is only
//     the fallback for a server predating the feature.
//   - `0` — disabled for this role. Deliberately distinct from `null`: it is
//     the per-role circuit breaker, not "inherit".
//   - `1..100` — the share of the agent's context window that arms `/compact`.
//
// Non-integers and out-of-range values are REJECTED rather than coerced: the
// server answers 400 on `"35"` and `3.5` (§3.3), and a client that rounded
// them would report a threshold that was never stored.

/** Fallback default when `GET /roles` carries no `defaults` (older server). */
export const DEFAULT_AUTO_COMPACT_PCT = 35;

/**
 * Same fallback for the WORKERS' threshold (docs/auto-compact.md §8.2,
 * v0.10.1): `0`, i.e. workers are not auto-compacted unless the instance
 * (`SWARM_OS_WORKER_AUTO_COMPACT_PCT`) or the role says so. A server predating
 * v0.10.1 carries no `defaults.workerAutoCompactPct` — and on such a server
 * workers DID follow the lead's threshold; the form cannot know that, and it
 * only matters until the server is upgraded, so the fallback states the new
 * contract rather than the old one.
 */
export const DEFAULT_WORKER_AUTO_COMPACT_PCT = 0;

/** The one error sentence, so the dialog and the overlay say the same thing. */
export const AUTO_COMPACT_ERROR =
  'Le seuil doit être un entier entre 0 et 100 (vide = valeur de l’instance, 0 = désactivé).';

/**
 * Parse the AUTO-COMPACT (%) field.
 *
 * Empty (or blank) is a legitimate value — it means "inherit the instance
 * default" — and is the ONLY way to go back to inheriting, hence
 * `{ ok: true, value: null }` rather than an error. A trailing `%` is accepted
 * because it is what an operator re-typing the read-only line actually types.
 */
export function parseAutoCompactPct(
  raw: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
  const trimmed = raw.trim().replace(/\s*%$/, '').trim();
  if (trimmed === '') return { ok: true, value: null };
  // Digits only: rejects `3.5`, `-5`, `1e2` and `35abc` the same way the
  // server does, instead of letting `Number()` round or coerce them.
  if (!/^\d{1,3}$/.test(trimmed)) return { ok: false, error: AUTO_COMPACT_ERROR };
  const n = Number(trimmed);
  if (n > 100) return { ok: false, error: AUTO_COMPACT_ERROR };
  return { ok: true, value: n };
}

/**
 * The stored threshold as a form value: `'35'`, `'0'` for disabled, `''` for
 * inherit. `0` must NOT collapse to `''` — that would turn a role the operator
 * deliberately took out of auto-compact back into an inheriting one on the
 * next save.
 */
export function autoCompactFieldValue(pct: number | null | undefined): string {
  return typeof pct === 'number' && Number.isInteger(pct) && pct >= 0 && pct <= 100
    ? String(pct)
    : '';
}

/**
 * The RolesPage read-only line, in the register of `autoCleanupSummary` and
 * `budgetSummary`: `Hérite (35 %)` / `Désactivé` / `50 %`.
 *
 * `defaultPct` is the instance value the role would inherit — it is shown
 * inside the parentheses so the operator never has to go read an env var to
 * know what "inherit" is worth today.
 */
export function autoCompactSummary(
  pct: number | null | undefined,
  defaultPct: number = DEFAULT_AUTO_COMPACT_PCT,
): string {
  if (typeof pct !== 'number' || !Number.isInteger(pct) || pct < 0 || pct > 100) {
    return defaultPct > 0 ? `Hérite (${defaultPct} %)` : 'Hérite (désactivé)';
  }
  return pct === 0 ? 'Désactivé' : `${pct} %`;
}

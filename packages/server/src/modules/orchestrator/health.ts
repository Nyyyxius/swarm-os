/**
 * S7 — aggregated `health` field for an `OrchestratorView`.
 *
 * The new desktop UI (TopBar / LeftPanel / MapView, cf.
 * `prototypes/app.jsx:48-66`) displays a per-team `HEALTHY / DEGRADED /
 * OFFLINE` pill that depends on a single derived signal mixing orch
 * status, lead status, worker statuses and `lastError`. Rather than
 * duplicating the verdict on the client we expose it as a derived field
 * of `OrchestratorView`, recomputed on every `toView()` serialization.
 *
 * Pure function — no `Date.now()`, no bus access, no DOM. Easy to test
 * with a literal `HealthInput`.
 */
import type { OrchestratorStatus, OrchestratorView } from './index.js';

export type OrchestratorHealth = 'ok' | 'warn' | 'bad' | 'stopped';

/**
 * Minimal input shape — a structural subset of `OrchestratorView`. Callers
 * can pass `view` directly OR build a literal in tests; the typing is wide
 * enough on purpose so the helper can be re-used from `rowToOrchView`
 * without forcing a full `OrchestratorView` round-trip.
 */
export type HealthInput = Pick<
  OrchestratorView,
  'status' | 'leadSessionId' | 'lastError' | 'sessions'
>;

/**
 * Aggregation rules (cf. `docs/internal/ui-redesign/update_system/07_health_agrege.md` §5):
 *
 *   1. Orch `stopped` or `stopping`         → `'stopped'`
 *   2. Orch `failed`                         → `'bad'`
 *   3. Lead `failed`                         → `'bad'`
 *   4. Lead `waiting` OR `lastError != null` OR any worker `failed`
 *                                            → `'warn'`
 *   5. Otherwise                             → `'ok'`
 *
 * Priority order is `bad > warn > ok`; the rules above are tested in
 * sequence which gives them that priority naturally.
 *
 * Notes:
 *
 * - Worker `waiting` / `starting` / `paused` (S5) / `exited` / `killed` /
 *   `interrupted` do NOT escalate the health. `waiting` on the lead is
 *   the operator-visible signal (cf. S3); a worker waiting on its lead
 *   is legitimate and silent at the team level. `paused` is a voluntary
 *   operator action and must not look like an anomaly.
 * - Orch `starting` with no lead yet falls through to `'ok'`. The window
 *   is short (sub-second); if the spawn fails it transitions to
 *   `failed` immediately and the rule above catches it.
 */
export function computeOrchestratorHealth(v: HealthInput): OrchestratorHealth {
  const orchStatus: OrchestratorStatus = v.status;

  // 1. Teardown / terminal states.
  if (orchStatus === 'stopped' || orchStatus === 'stopping') return 'stopped';
  if (orchStatus === 'failed') return 'bad';

  // 2. Resolve the lead (may still be missing during `starting`).
  const lead = v.leadSessionId
    ? (v.sessions.find((s) => s.id === v.leadSessionId) ?? null)
    : null;

  // 3. Lead failed → bad, regardless of everything else.
  if (lead?.status === 'failed') return 'bad';

  // 4. Warn conditions (any one of them is enough).
  if (lead?.status === 'waiting') return 'warn';
  if (v.lastError != null) return 'warn';
  const workers = v.sessions.filter((s) => s.type === 'worker');
  if (workers.some((s) => s.status === 'failed')) return 'warn';

  // 5. Default — running team with no escalation signal.
  return 'ok';
}

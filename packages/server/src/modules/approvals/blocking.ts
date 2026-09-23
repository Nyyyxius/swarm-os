/**
 * Approvals 409 guard (docs/builtin-features.md D9) — enumerate the LIVE teams
 * that could still block on a human, so `POST /features/approvals/disable` and
 * `DELETE /features/approvals` can refuse (409) and NAME them.
 *
 * Why a guard at all: disabling approvals removes the only REMOTE path to unblock
 * a waiting agent (the legacy `session.waiting` webhook is one-way). So the
 * operator must first switch the concerned roles/teams to a bypass mode (or stop
 * them), or knowingly confirm when none is concerned.
 *
 * Criterion of "blocking" — deliberately the EXACT predicate the hook path uses
 * to CREATE an approval, so "blocking" == "could actually request an approval":
 * a live team (`spawner.listActive()`) is blocking iff it has at least one
 * NON-TERMINAL session whose `(provider, permissionMode)` arms the guard under
 * the team's role approval settings, i.e.
 * `shouldArmApproval(session.provider, session.permissionMode, role.approval)`
 * is `true`. This means:
 *   - a bypass/non-prompting session never counts (codex/gemini/opencode, or
 *     claude in `bypassPermissions`/`dontAsk`/`auto`) — it can't prompt, so it
 *     can't block on needs-human;
 *   - a role that turned the guard off (`approval.enabled === false`) or armed
 *     no mode (`armingModes: []`) never counts either — same predicate;
 *   - the check is PER-SESSION, not per-role-default: a team whose default is
 *     bypass but which spawned a session with an overriding prompting mode is
 *     still (correctly) flagged.
 *
 * Fail-open on any internal error: a broken enumeration reports no blocking team
 * (the disable proceeds), matching the 24/7 fail-open stance (a registry failure
 * behaves as enabled). The 409 is a "confirm first" guard, not a hard lock.
 */

import type { Spawner } from '../spawner/index.js';
import type { RoleStore } from '../roles/index.js';
import { shouldArmApproval } from './prompting.js';

/** Session statuses that can no longer prompt a human (never block). */
const TERMINAL_SESSION_STATUSES = new Set(['exited', 'killed', 'failed']);

/**
 * Names of the live teams that could still request an approval (see criterion
 * above), sorted + de-duplicated. `[]` when none — the disable may proceed.
 */
export function listBlockingApprovalTeams(spawner: Spawner, roleStore: RoleStore): string[] {
  const names = new Set<string>();
  try {
    for (const orch of spawner.listActive()) {
      // A role's approval override is already parsed onto `Role.approval`.
      const role = orch.roleId ? roleStore.get(orch.roleId) : null;
      const roleSettings = role?.approval ?? null;
      let sessions;
      try {
        sessions = orch.toView().sessions;
      } catch {
        continue; // one bad team must not hide the others
      }
      for (const s of sessions) {
        if (TERMINAL_SESSION_STATUSES.has(s.status)) continue;
        if (shouldArmApproval(s.provider, s.permissionMode, roleSettings)) {
          names.add(orch.name || orch.id);
          break;
        }
      }
    }
  } catch {
    // Fail-open: report none rather than block an operator action on an
    // enumeration bug (24/7 stance). The operator can always re-enable later.
    return [];
  }
  return Array.from(names).sort();
}

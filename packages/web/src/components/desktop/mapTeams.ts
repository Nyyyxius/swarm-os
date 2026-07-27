// packages/web/src/components/desktop/mapTeams.ts
//
// Step 6 (Phase B.6) — derive the `MapViewTeam[]` shape consumed by
// `MapView` from a snapshot of server-side `OrchestratorView[]`.
//
// Responsibilities:
//  - Filter live orchestrators that have a leadSessionId (a brand new
//    orch in `status === 'starting'` may briefly have null lead — skip
//    until the next poll surfaces it).
//  - Compute the orbital angle of each lead from its index in the snapshot
//    (`(i / N) * 2π - π/2`, starting at 12 o'clock then clockwise).
//  - Apply `enrichWithIdle` to downgrade `running → idle` after 30 s of
//    silence; pass other statuses through untouched.
//  - Inject per-session inbox counts (from `peekInbox` poll) so each Node
//    can render its `INBOX N` badge without a second pass.
//
// We intentionally derive angles client-side: the server never stores them
// (creation order is the only ordering signal). Consequence: when an orch
// terminates, the surviving ones redistribute around the circle. CSS
// `transition: transform 600ms ease` on `.node` makes that re-layout
// visually smooth.

import { enrichWithIdle } from '../../lib/sessionStatus';
import { shapeForRole } from '../../lib/roleShape';
import type { OrchestratorView, SessionView } from '../../api/client';
import type { MapViewTeam } from './MapView';
import type { NodeAgent } from './Node';

const TAU = Math.PI * 2;

/**
 * Convert a raw `SessionView` into a `NodeAgent` suitable for the MapView.
 * Only the `running → idle` override is applied here; all other statuses
 * pass through untouched so the `Node` ring/dot/label can pick the
 * appropriate variant (waiting, starting, failed, paused, exited, …).
 */
export function toNodeAgent(
  s: SessionView,
  now: number,
  inboxCount: number,
): NodeAgent {
  const v = enrichWithIdle(s, now);
  const status = v.visual === 'idle' ? 'idle' : s.status;
  return {
    id: s.id,
    name: s.name,
    role: s.role,
    shape: shapeForRole(s.role),
    status,
    inbox: inboxCount,
    // Multi-provider Lot 3 — carried straight through so the node can tag it.
    provider: s.provider,
  };
}

/**
 * Build `MapViewTeam[]` from a snapshot of orchestrators. Angles are
 * computed from the count N so leads sit on a regular orbit around the
 * central hub:
 *
 *     angle_i = (i / N) * 2π - π/2
 *
 * (start at 12 o'clock — i = 0 → top, then clockwise).
 *
 * Orchestrators without a `leadSessionId` (transient post-create) are
 * skipped — MapView cannot lay them out without a lead Node. They will
 * appear on the next poll once the server fills in `leadSessionId`.
 *
 * Recently-ended orchestrators (`endedAt != null`) are surfaced in the
 * LeftPanel "RECENTLY ENDED" section, NOT the map — we filter them here
 * to keep the orbit visually focused on live teams.
 */
export function toMapViewTeams(
  orchestrators: readonly OrchestratorView[],
  now: number,
  inboxCounts: ReadonlyMap<string, number>,
): MapViewTeam[] {
  const live = orchestrators.filter(
    (o) =>
      o.endedAt == null
      && o.leadSessionId != null
      && o.sessions.length > 0,
  );
  const N = Math.max(1, live.length);
  const out: MapViewTeam[] = [];
  live.forEach((o, i) => {
    const leadSession = o.sessions.find((s) => s.id === o.leadSessionId);
    if (!leadSession) return;
    const workers = o.sessions.filter((s) => s.type === 'worker');
    const angle = (i / N) * TAU - Math.PI / 2;
    out.push({
      id: o.id,
      angle,
      status: o.status,
      lead: toNodeAgent(leadSession, now, inboxCounts.get(leadSession.id) ?? 0),
      workers: workers.map((w) =>
        toNodeAgent(w, now, inboxCounts.get(w.id) ?? 0),
      ),
    });
  });
  return out;
}

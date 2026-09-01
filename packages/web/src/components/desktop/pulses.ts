// packages/web/src/components/desktop/pulses.ts
//
// Step 6 (Phase B.6) — pulses pipeline:
//  - `deriveKind(ev)` : classifies a `mailbox.message` event into one of
//    `intra | cross | human | broadcast`. The order of checks matters
//    (broadcast first, then cross-team via `fromOrchestratorId`, then
//    human, then default intra). Early-return semantics.
//  - `pushPulse(prev, next, nextId)` : append a pulse to the ring buffer,
//    respecting a 200 ms (same-from-to-kind) dedupe window AND a 32-item
//    cap (oldest dropped). Returns the previous array reference when the
//    pulse is deduplicated, so React skips the re-render.
//
// Animation lifetime: each pulse plays its CSS `pulse-travel` once
// (1.4 s or 1.8 s for broadcast). Forwards keeps it at offset 100% (so
// invisibly off-node), then a `setTimeout(1500)` in DesktopShell trims
// the array to free DOM nodes.

import type { MailboxMessageEvent } from '../../hooks/useEvents';
import type { MapPulse } from './MapView';

export const PULSE_CAP = 32;
export const PULSE_DEDUPE_MS = 200;

/**
 * Classify a mailbox.message into one of the 4 visual kinds the MapView
 * knows how to animate. Order is significant — early-returns implement
 * the precedence specified in `docs/ui-redesign-desktop.md §3.3`.
 */
export function deriveKind(ev: MailboxMessageEvent): MapPulse['kind'] {
  // 1) Broadcast (operator → all leads OR lead → all workers via
  //    `team.broadcast`). The server fan-outs into N frames, each with
  //    `to === 'broadcast'` — we still emit N pulses, one per recipient.
  if (ev.to === 'broadcast') return 'broadcast';
  // 1.5) Plugin-origin message (`from='plugin:<name>'`, J2). Classify as a
  //    non-'intra' kind so SwarmController maps its source to '__center__'
  //    (an intra kind would look for a session position that doesn't exist).
  if (typeof ev.from === 'string' && ev.from.startsWith('plugin:')) return 'human';
  // 1.6) Cron-origin message (`from='cron:<name>'`, docs/crons-agents.md). Same
  //    reasoning as `plugin:` above: the sender has no node on the map, so an
  //    'intra' kind would look up `positions['cron:daily']` and drop the pulse.
  if (typeof ev.from === 'string' && ev.from.startsWith('cron:')) return 'human';
  // 2) Cross-team: comes from another orchestrator's lead via
  //    `swarm.send_to_lead`. We detect it by comparing the source orch
  //    id to the destination orch id.
  if (
    ev.fromOrchestratorId !== undefined
    && ev.fromOrchestratorId !== ev.orchestratorId
  ) return 'cross';
  // 3) Operator-initiated broadcast / direct message
  //    (`POST /orchestrators/:id/broadcast`).
  if (ev.from === 'human') return 'human';
  // 4) Intra-team peer-to-peer (`team.send_message`).
  return 'intra';
}

/**
 * Append a pulse to the buffer with dedupe + cap. Walks backwards from
 * the tail (bursts cluster at the tail) and exits the dedupe scan as
 * soon as it falls out of the 200 ms sliding window.
 *
 * Returns the original `prev` reference unchanged when the pulse is
 * deduplicated — letting React skip the re-render.
 */
export function pushPulse(
  prev: readonly MapPulse[],
  next: Omit<MapPulse, 'id'> & { ts: number },
  nextId: () => number,
): MapPulse[] {
  const now = next.ts;
  for (let i = prev.length - 1; i >= 0; i--) {
    const p = prev[i] as (MapPulse & { ts?: number }) | undefined;
    if (!p) break;
    const pts = p.ts ?? 0;
    if (now - pts > PULSE_DEDUPE_MS) break;
    if (p.from === next.from && p.to === next.to && p.kind === next.kind) {
      return prev as MapPulse[]; // duplicate dropped — same reference
    }
  }
  const out: MapPulse[] = [
    ...prev,
    {
      id: nextId(),
      from: next.from,
      to: next.to,
      kind: next.kind,
      ts: now,
    },
  ];
  return out.length > PULSE_CAP ? out.slice(out.length - PULSE_CAP) : out;
}

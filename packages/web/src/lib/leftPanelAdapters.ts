// packages/web/src/lib/leftPanelAdapters.ts
//
// Phase B.5 — pure adapters + hooks that feed the desktop `LeftPanel`
// from the canonical `OrchestratorView[]` and the `/metrics/*` endpoints.
//
// All transforms are pure (tested directly in
// `leftPanelAdapters.test.ts`). The hooks live here too so the component
// stays declarative — see `components/desktop/LeftPanel.tsx`.

import { useEffect, useRef, useState } from 'react';
import {
  api,
  type MessagesMetricsSnapshot,
  type OrchestratorView,
} from '../api/client';
import {
  useGlobalMessageStats,
  type GlobalMessageStats,
} from './messageStats';
import type {
  LeftPanelEnded,
  LeftPanelTeam,
} from '../components/desktop/LeftPanel';

// ---------------------------------------------------------------------------
// Tag derivation (ONLINE / STARTING / OFFLINE)
// ---------------------------------------------------------------------------

export type OnlineTag = 'ONLINE' | 'STARTING' | 'OFFLINE';

/**
 * Build the `ONLINE | STARTING | OFFLINE` tag (cf. plan global §3.2) from
 * `(orch.status, orch.health)`.
 *
 * Rules:
 *   - `health === 'stopped'` OR `status ∈ {stopped, failed, stopping}` → OFFLINE
 *   - `status === 'starting'`                                          → STARTING
 *   - otherwise                                                        → ONLINE
 */
export function deriveTag(orch: OrchestratorView): OnlineTag {
  if (
    orch.health === 'stopped' ||
    orch.status === 'stopped' ||
    orch.status === 'failed' ||
    orch.status === 'stopping'
  ) {
    return 'OFFLINE';
  }
  if (orch.status === 'starting') return 'STARTING';
  return 'ONLINE';
}

// ---------------------------------------------------------------------------
// `purpose` derivation
// ---------------------------------------------------------------------------

/**
 * Short purpose (≤ 16 chars upper-case) used for the PER-TEAM TRAFFIC line.
 * `OrchestratorView` has no `purpose` field today; we fall back on the
 * `role` label which is the closest semantic identifier. Empty role →
 * em-dash. Long role → truncated with an ellipsis (so the meta row stays
 * one line).
 */
export function derivePurpose(orch: OrchestratorView): string {
  const raw = (orch.role || '—').toUpperCase();
  return raw.length > 16 ? raw.slice(0, 15) + '…' : raw;
}

// ---------------------------------------------------------------------------
// `OrchestratorView` → `LeftPanelTeam` / `LeftPanelEnded`
// ---------------------------------------------------------------------------

/**
 * Transform an **active** `OrchestratorView` into a `LeftPanelTeam`.
 * `spark` is looked up in the S9 `per_orchestrator` map; if absent (orch
 * just spawned, server has no `MessagesAggregator`, etc.) we return an
 * empty array and the `Sparkline` simply renders nothing.
 */
export function toLeftPanelTeam(
  orch: OrchestratorView,
  perOrchMetrics: Record<string, number[]> | null,
): LeftPanelTeam {
  return {
    id: orch.id,
    name: orch.name,
    purpose: derivePurpose(orch),
    msgCount: orch.msgCount ?? 0,
    status: orch.status,
    leadId: orch.leadSessionId ?? orch.id,
    workerCount: Math.max(0, orch.sessions.length - 1),
    spark: perOrchMetrics?.[orch.id] ?? [],
  };
}

/**
 * Transform a **terminated** `OrchestratorView` into a `LeftPanelEnded`.
 * Reason badge is:
 *   - `orch.stopReason` (lower-cased) when present (Phase 4);
 *   - `'failed'` when status==='failed' and no stopReason;
 *   - `'exited'` otherwise.
 */
export function toLeftPanelEnded(orch: OrchestratorView): LeftPanelEnded {
  const fallbackReason: string =
    orch.status === 'failed' ? 'failed' : 'exited';
  const rawReason = (orch.stopReason ?? fallbackReason).toLowerCase();
  return {
    id: orch.id,
    name: orch.name,
    purpose: derivePurpose(orch),
    endedAt: orch.endedAt ?? '',
    reason: rawReason,
    agentCount: orch.sessions.length,
  };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export function filterActive(
  orchestrators: readonly OrchestratorView[],
): OrchestratorView[] {
  return orchestrators.filter((o) => o.endedAt == null);
}

/**
 * Ended orchestrators, sorted desc on `endedAt`. Invalid/unparseable dates
 * end up at the tail (treated as `0` ms).
 */
export function filterEnded(
  orchestrators: readonly OrchestratorView[],
): OrchestratorView[] {
  return orchestrators
    .filter((o) => o.endedAt != null)
    .sort((a, b) => {
      const ta = Date.parse(a.endedAt ?? '');
      const tb = Date.parse(b.endedAt ?? '');
      return (
        (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0)
      );
    });
}

/**
 * Visual cap on the RECENTLY ENDED list. The proto v2 renders every ended
 * row; in prod we may accumulate hundreds over a long session, so cap at
 * 20 — beyond that the operator goes through a dedicated history page
 * (out of scope v1).
 */
export const ENDED_DISPLAY_CAP = 20;

// ---------------------------------------------------------------------------
// Sparkline colour for the PER-TEAM TRAFFIC row
// ---------------------------------------------------------------------------

/**
 * Muted ochre when offline (matches the proto's swatch + line colour for
 * stopped teams), otherwise the canonical amber.
 */
export function sparkColor(orch: OrchestratorView): string {
  const offline =
    orch.health === 'stopped' ||
    orch.status === 'stopped' ||
    orch.status === 'failed';
  return offline ? '#5a4d3f' : 'var(--amber)';
}

// ---------------------------------------------------------------------------
// MESSAGE FLOW source selection (S4 client vs S9 server)
// ---------------------------------------------------------------------------

export type MessageFlowSource = 's4-client' | 's9-server';

/**
 * Poll `/metrics/messages` every `intervalMs`. Tolerates transient errors
 * (401/404/500): on failure we keep the previous snapshot (or `null` if
 * none yet) so the UI never flickers to nothing. Exposed publicly so
 * `LeftPanel` can share a single instance for both the global big graph
 * (when `messageFlowSource === 's9-server'`) and the per-team sparklines.
 *
 * `enabled` exists for the always-mounted route overlays (`MonitoringPage`
 * & co.): React forbids calling the hook conditionally, so a page that
 * renders `null` while closed would otherwise keep polling forever in the
 * background. Same gate as `useApprovals(orchId, ms, open)`.
 */
export function useServerMessagesMetrics(
  intervalMs: number = 60_000,
  enabled: boolean = true,
): MessagesMetricsSnapshot | null {
  const [snap, setSnap] = useState<MessagesMetricsSnapshot | null>(null);
  const cancelledRef = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    cancelledRef.current = false;
    const fetchOnce = async () => {
      try {
        const s = await api.getMetricsMessages();
        if (!cancelledRef.current) setSnap(s);
      } catch {
        /* keep previous snap, transient errors OK */
      }
    };
    void fetchOnce();
    const t = setInterval(() => void fetchOnce(), intervalMs);
    return () => {
      cancelledRef.current = true;
      clearInterval(t);
    };
  }, [intervalMs, enabled]);
  return snap;
}

/**
 * Unified MESSAGE FLOW hook. Both source hooks are always mounted (React
 * hook rules); the consumer only reads from one. Acceptable cost — see
 * design doc §4.3 / §11.7 (in `LeftPanel` the same `useServerMessagesMetrics`
 * is also used to feed the per-team sparklines, but that's two separate
 * mounts; both poll independently).
 */
export function useMessageFlow(
  orchestrators: readonly OrchestratorView[],
  source: MessageFlowSource = 's4-client',
  enabled: boolean = true,
): GlobalMessageStats {
  const s4 = useGlobalMessageStats(orchestrators);
  const s9 = useServerMessagesMetrics(60_000, enabled);
  if (source === 's9-server' && s9) {
    return {
      total: s9.total,
      perMinute: s9.per_minute,
      history: s9.global,
    };
  }
  return s4;
}

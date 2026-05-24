// packages/web/src/components/desktop/DesktopShell.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TopBar, { type TopBarTeam, type TopBarInfo } from './TopBar';
import LeftPanel from './LeftPanel';
import MapView, { type MapPulse } from './MapView';
import RightPanel, {
  type RightPanelAgent, type RightPanelTeam, type MessageBubble,
  type RightPanelTab, type AgentAction,
} from './RightPanel';
import Toasts, { type WaitingToast } from './Toasts';
import EventsPip from './EventsPip';
import SettingsDrawer, { type AuthState } from './SettingsDrawer';
import type { ComposerAudience, ComposerMode } from './Composer';
import { useOrchestrators } from '../../hooks/useOrchestrators';
import { useRoles } from '../../hooks/useRoles';
import { useSession } from '../../hooks/useSession';
import { useEvents, type MailboxMessageEvent } from '../../hooks/useEvents';
import {
  api, getToken, HttpError,
  type HealthView, type InfoView, type MailMessageView,
  type OrchestratorView,
} from '../../api/client';
import { deriveTopBarPillStatus } from '../../lib/topBarStatus';
import { useNow } from '../../lib/useNow';
import { classifyBubble } from '../../lib/mailBubble';
import { toMapViewTeams } from './mapTeams';
import { deriveKind, pushPulse, PULSE_CAP } from './pulses';
import { buildRightPanelTeam, buildRightPanelAgent } from './rightPanelAdapters';
import { NewOrchestratorDialog } from '../NewOrchestratorDialog';
import BroadcastModal from './BroadcastModal';
import SpawnWorkerDialog from './SpawnWorkerDialog';
import EditConfigDialog from './EditConfigDialog';

/**
 * Step 19 — duration of `.flash-new` class application on a team-pill.
 * 100 ms longer than the CSS keyframe (1.6 s) so the class is removed
 * AFTER the animation completes; avoids a tail re-trigger on remount.
 * Source: prototypes/v2/app.jsx:480.
 */
const FLASH_MS = 1700;

/**
 * Phase A.2 — squelette. Ce composant assemble la grille desktop mais ne
 * câble aucune source de données. Les hooks viendront en Phase B :
 *   - Step 4 : TopBar  ← useOrchestrators + api.info + api.health
 *   - Step 5 : LeftPanel ← useGlobalMessageStats + api.getMetricsBus + filter ended
 *   - Step 6 : MapView  ← useOrchestrators + useEvents (pulses)
 *   - Step 7 : RightPanel ← useSession + Terminal + peekInbox + classifyBubble
 *   - Step 8 : Toasts/EventsPip ← useEvents waiting + connected
 *
 * Les 6 overlays (NewOrchestratorDialog/RolesPage/SettingsDrawer/Spawn/Edit/Broadcast)
 * ne sont pas montés en Step 2 ; on stocke leur état d'ouverture et on
 * laisse des placeholders pour Phase C (Steps 9-13).
 *
 * Step 3 (Phase A.3) — routing :
 *   - `routeOrchestratorId` (vient du hash `#/orchestrators/:id`) pré-sélectionne
 *     le `leadSessionId` de l'orchestrator demandé via `useOrchestrators`.
 *   - `onOpenOrchestrator` / `onCloseRightPanel` permettront à terme à la
 *     MapView/TopBar/RightPanel de synchroniser le hash. En step 3 ces
 *     handlers sont stockés pour usage futur (B.4+).
 */
export interface DesktopShellProps {
  /** Orchestrator id extrait de `#/orchestrators/:id`, ou null sur `#/`. */
  routeOrchestratorId: string | null;
  /** Sync le hash quand l'utilisateur choisit une autre team. */
  onOpenOrchestrator: (id: string) => void;
  /** Sync le hash vers `#/` quand l'utilisateur ferme le RightPanel. */
  onCloseRightPanel: () => void;
  /** Phase C — Step 10 : TopBar ROLES button → route `#/roles` (RolesPage
   *  v2 fullscreen overlay). When omitted, falls back to the legacy
   *  in-shell placeholder state for backwards-compat with callers that
   *  haven't been migrated yet. */
  onOpenRoles?: () => void;
}

export default function DesktopShell({
  routeOrchestratorId,
  onOpenOrchestrator,
  onCloseRightPanel,
  onOpenRoles,
}: DesktopShellProps) {
  // ── live orchestrators (Step 3 : résolution :id → leadSessionId ;
  //    Step 4 : alimente aussi la TopBar — un seul appel partagé pour
  //    éviter N polls 3 s en parallèle ; cf. risque 1 du spec). ──────────
  const { orchestrators, create: createOrchestrator } = useOrchestrators();

  // ── now (1 s tick) : drives `enrichWithIdle` so the running→idle
  //    transition feels prompt at a 30 s threshold (≤1 s of jitter).
  //    Cost: one re-derivation of mapTeams per second. ────────────────
  const now = useNow(1_000);

  // ── selection ──────────────────────────────────────────────────────────
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<RightPanelTab>('console');

  // ── Step 19 ── flashTeamIds : Set<string> of team-pills currently
  //    rendering `.flash-new`. Migrated from `string | null` (Step 4 stub)
  //    so bursts of creations (multi-tab / seed) all flash without the
  //    later writes clobbering earlier ones. Auto-cleared per id after
  //    FLASH_MS via `triggerFlash`. Two sources feed the set:
  //      1. WS event `orchestrator.created` (sub-second, primary)
  //      2. Diff on `useOrchestrators` snapshot (≤3 s, fallback when WS
  //         dropped between create + reconnect)
  //    Both go through `triggerFlash`, which dedupes (no-op when the id
  //    is already in the set). ──────────────────────────────────────────
  const [flashTeamIds, setFlashTeamIds] = useState<Set<string>>(() => new Set());

  const triggerFlash = useCallback((id: string) => {
    setFlashTeamIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    setTimeout(() => {
      setFlashTeamIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, FLASH_MS);
  }, []);

  // Step 19 — fallback source: diff `orchestrators` snapshot. The first
  //   snapshot only primes `prevOrchIdsRef`; otherwise every existing
  //   team would flash at mount. After bootSeen flips, any id present
  //   in `cur` but absent from `prev` triggers a flash (deduped against
  //   the WS path via `triggerFlash`).
  const prevOrchIdsRef = useRef<Set<string>>(new Set());
  const orchBootSeenRef = useRef(false);
  useEffect(() => {
    const cur = new Set(orchestrators.map((o) => o.id));
    if (!orchBootSeenRef.current) {
      prevOrchIdsRef.current = cur;
      // Flip on the first observed snapshot (even empty) so a fresh
      // server with zero orchs still arms the diff for subsequent
      // creations. The previous "wait for non-empty" gate would miss
      // the first-ever creation on an empty server.
      orchBootSeenRef.current = true;
      return;
    }
    for (const id of cur) {
      if (!prevOrchIdsRef.current.has(id)) triggerFlash(id);
    }
    prevOrchIdsRef.current = cur;
  }, [orchestrators, triggerFlash]);

  // Pré-sélection du lead à partir du hash `#/orchestrators/:id`.
  // Cas particuliers (§3.2 du spec) :
  //  - route `#/` → on désélectionne (fermeture du RightPanel).
  //  - orchestrator pas encore arrivé dans le poll 3 s → leadSessionId
  //    undefined, on ne touche pas à la sélection courante ; le prochain
  //    poll déclenchera l'effet et résoudra la pré-sélection.
  //
  // Why: orchestrators polls every 3 s; without `prevRouteRef`, every poll
  // would re-run this effect with an unchanged route and clobber a worker
  // selection (snap back to lead) or a no-route click (snap to null). We
  // distinguish "route actually changed" from "orchestrators polled" and
  // preserve any selection that already belongs to the routed orch.
  const prevRouteRef = useRef<string | null>(routeOrchestratorId);
  useEffect(() => {
    const prev = prevRouteRef.current;
    const routeChanged = prev !== routeOrchestratorId;
    prevRouteRef.current = routeOrchestratorId;

    if (!routeOrchestratorId) {
      if (routeChanged) setSelectedSessionId(null);
      return;
    }
    const orch = orchestrators.find((o) => o.id === routeOrchestratorId);
    if (!orch) return;
    if (
      selectedSessionId &&
      orch.sessions.some((s) => s.id === selectedSessionId)
    ) {
      return;
    }
    if (orch.leadSessionId) {
      setSelectedSessionId(orch.leadSessionId);
    }
  }, [routeOrchestratorId, orchestrators, selectedSessionId]);

  // ── overlays (Phase C) ─────────────────────────────────────────────────
  // Step 9 : `showNew` is wired ; Step 10 lifts `setShowRoles` to App.tsx
  // (hash routing) ; Step 11 wires `settingsOpen` to <SettingsDrawer> ;
  // Step 12 wires `broadcastOpen` to <BroadcastModal>. The remaining
  // setters (spawn / edit) stay placeholders until Step 13.
  const [showNew, setShowNew] = useState(false);
  const [, setShowRoles] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Step 13 — both modales are gated on `OrchestratorView | null` (not
  // `RightPanelTeam`) because they read raw server fields
  // (`defaultModel`, `defaultEffort`, `defaultPermissionMode`, `name`),
  // and the SpawnWorkerDialog also needs the roles snapshot for the
  // ROLE dropdown. The RightPanel callbacks pass a `RightPanelTeam`
  // (id-keyed); we resolve it to the live OrchestratorView below.
  const [spawnFor, setSpawnFor] = useState<OrchestratorView | null>(null);
  const [editConfigFor, setEditConfigFor] = useState<OrchestratorView | null>(null);
  const [broadcastOpen, setBroadcastOpen] = useState(false);

  // ── Phase C.11 — auth state lifted from App.tsx ───────────────────────
  // The shell owns `health`, `authState` and `probeAuth` now that the
  // `<SettingsDrawer>` lives here. `info` already lived here (Step 4).
  // Auto-open the drawer when the token is missing or rejected — same UX
  // contract as the legacy inline banner, just in a drawer surface.
  const [health, setHealth] = useState<HealthView | null>(null);
  const [authState, setAuthState] = useState<AuthState>('unknown');

  const probeAuth = useCallback(async () => {
    if (!getToken()) {
      setAuthState('missing');
      return;
    }
    try {
      await api.listOrchestrators();
      setAuthState('ok');
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) setAuthState('invalid');
      else setAuthState('ok'); // network/server errors: don't pin as auth issue
    }
  }, []);

  useEffect(() => {
    void api.health().then(setHealth).catch(() => undefined);
    void probeAuth();
  }, [probeAuth]);

  // Refresh `health.sessions_active` periodically so the SETTINGS drawer
  // SESSIONS cell stays fresh (same 3 s cadence as `useOrchestrators`).
  useEffect(() => {
    const t = setInterval(() => {
      void api.health().then(setHealth).catch(() => undefined);
    }, 3_000);
    return () => clearInterval(t);
  }, []);

  // Auto-open the settings drawer when auth is missing/invalid. This fires
  // on every transition of authState (not on every render) and the drawer
  // stays user-closable; the next probe re-opens it if still bad.
  useEffect(() => {
    if (authState === 'missing' || authState === 'invalid') setSettingsOpen(true);
  }, [authState]);

  // ── Step 6 (Phase B.6) ── INBOX BADGES (poll peekInbox every 3 s) ────
  // Mirror `orchestrators` in a ref so the polling effect can run with a
  // stable interval and not be re-scheduled every snapshot change (which
  // would effectively double the poll rate). See spec §6.1 ─────────────
  const orchRef = useRef(orchestrators);
  useEffect(() => { orchRef.current = orchestrators; }, [orchestrators]);
  const [inboxCounts, setInboxCounts] = useState<Map<string, number>>(() => new Map());

  useEffect(() => {
    let cancelled = false;
    async function pollAll() {
      const snapshot = orchRef.current;
      const tasks: Array<Promise<[string, number] | null>> = [];
      for (const o of snapshot) {
        if (o.endedAt != null) continue;
        for (const s of o.sessions) {
          if (
            s.status === 'exited' || s.status === 'killed'
            || s.status === 'failed' || s.status === 'interrupted'
          ) continue;
          tasks.push(
            api.peekInbox(o.id, s.id)
              .then((r) => [s.id, r.count] as [string, number])
              .catch(() => null),
          );
        }
      }
      if (tasks.length === 0) {
        if (!cancelled) setInboxCounts((prev) => (prev.size === 0 ? prev : new Map()));
        return;
      }
      const results = await Promise.all(tasks);
      if (cancelled) return;
      const next = new Map<string, number>();
      for (const r of results) if (r) next.set(r[0], r[1]);
      setInboxCounts(next);
    }
    void pollAll();
    const id = setInterval(() => void pollAll(), 3_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // ── Step 6 ── SPAWN ANIMATION (diff polling: detect new session ids
  //    between snapshots, mark them spawning for 700 ms). We prime the
  //    `knownIds` ref on the first non-empty snapshot so initial load
  //    doesn't flash every existing session. See spec §7. ──────────────
  const [spawningIds, setSpawningIds] = useState<ReadonlySet<string>>(() => new Set());
  const knownIdsRef = useRef<Set<string>>(new Set());
  const primedRef = useRef(false);

  useEffect(() => {
    const cur = new Set<string>();
    for (const o of orchestrators) {
      for (const s of o.sessions) cur.add(s.id);
    }
    if (!primedRef.current) {
      // First snapshot — just record what we've seen, no animation.
      knownIdsRef.current = cur;
      if (cur.size > 0) primedRef.current = true;
      return;
    }
    const fresh: string[] = [];
    for (const id of cur) {
      if (!knownIdsRef.current.has(id)) fresh.push(id);
    }
    knownIdsRef.current = cur;
    if (fresh.length === 0) return;
    setSpawningIds((prev) => {
      const next = new Set(prev);
      for (const id of fresh) next.add(id);
      return next;
    });
    const t = setTimeout(() => {
      setSpawningIds((prev) => {
        const next = new Set(prev);
        for (const id of fresh) next.delete(id);
        return next;
      });
    }, 700);
    return () => clearTimeout(t);
  }, [orchestrators]);

  // ── Step 6 ── PULSES (mailbox.message → MapPulse, dedupe + cap) ──────
  // We use the callback form of `useEvents` so the pulses pipeline lives
  // here (one re-render per pulse instead of refreshing every consumer
  // of the hook). The callback identity is stable across renders via a
  // `useCallback`, and the underlying useEvents pattern uses a ref so
  // no WS tear-down occurs. ─────────────────────────────────────────
  const [pulses, setPulses] = useState<MapPulse[]>([]);
  const pulseIdRef = useRef(1);

  const handleMailboxMessage = useCallback((ev: MailboxMessageEvent) => {
    const kind = deriveKind(ev);
    const from = kind === 'intra' ? ev.from : '__center__';
    const to = ev.sessionId;
    setPulses((prev) =>
      pushPulse(
        prev,
        { from, to, kind, ts: Date.now() },
        () => pulseIdRef.current++,
      ),
    );
  }, []);

  // Step 19 — primary source: WS `orchestrator.created` event. Stable
  //   callback identity (depends only on `triggerFlash` which is itself
  //   memoised) so the useEvents WS connection isn't torn down on
  //   parent re-renders. The diff fallback below covers WS-down cases.
  const handleOrchestratorCreated = useCallback(
    (ev: { orchestratorId: string }) => {
      triggerFlash(ev.orchestratorId);
    },
    [triggerFlash],
  );

  const handleSessionCreated = useCallback((ev: { sessionId: string }) => {
    // Sub-second spawn anim path: when the WS event lands we mark
    // immediately; the polling diff above is a fallback for sessions
    // born via MCP (`team.spawn_worker`) that don't emit on the bus.
    setSpawningIds((prev) => {
      if (prev.has(ev.sessionId)) return prev;
      const next = new Set(prev);
      next.add(ev.sessionId);
      return next;
    });
    const id = ev.sessionId;
    setTimeout(() => {
      setSpawningIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 700);
  }, []);

  // ── Step 8 ── waiting + connected come from the SAME useEvents call as
  //    the pulses pipeline above; the spec is explicit that only ONE
  //    useEvents() may exist across the app to avoid double WS
  //    connections (cf. commit 584d9ec). `clear` is unused: the proto v2
  //    has no "clear all" button — toasts are dismissed individually or
  //    expire after 30 s via the hook's internal timer.
  const {
    connected: eventsConnected,
    waiting,
    dismiss,
  } = useEvents({
    onMailboxMessage: handleMailboxMessage,
    onSessionCreated: handleSessionCreated,
    onOrchestratorCreated: handleOrchestratorCreated,
  });

  // Cleanup of pulses: trim to the last PULSE_CAP after 1.5 s so the
  // forwards-filled CSS animations don't accumulate DOM nodes.
  useEffect(() => {
    if (pulses.length === 0) return;
    const t = setTimeout(() => {
      setPulses((p) => p.slice(Math.max(0, p.length - PULSE_CAP)));
    }, 1500);
    return () => clearTimeout(t);
  }, [pulses]);

  // ── Step 6 ── DERIVED MapViewTeam[] ─────────────────────────────────
  // Re-built every second (`now` tick) so `enrichWithIdle` flips
  // running→idle within 1 s of crossing the 30 s threshold. The
  // downstream `useMemo` chain inside MapView (positions / edges) only
  // rebuilds when `teams` reference changes — i.e. only when something
  // genuinely changes in the derivation (status, count, role, inbox).
  const mapViewTeams = useMemo(
    () => toMapViewTeams(orchestrators, now, inboxCounts),
    [orchestrators, now, inboxCounts],
  );

  // ── info (api.info() one-shot + refresh 60 s ; cf. §2.2). On rafraîchit
  //    seulement le sub-line (project_name / version / started_at) — pas
  //    d'effet sur le re-render des autres panes (info ne change qu'au
  //    restart serveur). ────────────────────────────────────────────────
  const [info, setInfo] = useState<InfoView | null>(null);
  useEffect(() => {
    let alive = true;
    const fetchInfo = () => {
      void api.info()
        .then((i) => { if (alive) setInfo(i); })
        .catch(() => { /* silent — token-free endpoint, retried next tick */ });
    };
    fetchInfo();
    const t = setInterval(fetchInfo, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // ── TopBar teams (Step 4) : filtrer ended (endedAt != null) pour ne
  //    pas polluer la TopBar avec les history rows (cf. risque 3). ─────
  const topBarTeams: readonly TopBarTeam[] = useMemo(
    () => orchestrators
      .filter((o) => o.endedAt == null)
      .map<TopBarTeam>((o) => {
        const pill = deriveTopBarPillStatus(o);
        return {
          id: o.id,
          name: o.name,
          purpose: o.role,
          // edge case : si leadSessionId est null (transitoire post-create),
          // le clic sera no-op via le handler (cf. handleSelectTeam).
          leadId: o.leadSessionId ?? '',
          workerCount: Math.max(0, o.sessions.length - 1),
          msgCount: o.msgCount,
          status: o.status,
          health: o.health,
          hasWaiting: pill === 'WAITING',
        };
      }),
    [orchestrators],
  );

  // ── topBarInfo : pass-through `startedAt` brut (la TopBar formate à
  //    chaque tick local 1 s ; cf. §6 du spec). ───────────────────────
  const topBarInfo: TopBarInfo = useMemo(
    () => ({
      projectName: info?.project_name ?? '—',
      version: info?.version ?? '—',
      startedAt: info?.started_at ?? null,
    }),
    [info],
  );

  // ── derived ────────────────────────────────────────────────────────────
  // N AGENTS : somme client des sessions (cf. §2.1 du spec, option 2).
  // Évite un appel `api.health()` supplémentaire et reste cohérent avec
  // les pills (mêmes données, même tick 3 s).
  const totalAgents = useMemo(
    () => orchestrators
      .filter((o) => o.endedAt == null)
      .reduce((s, o) => s + o.sessions.length, 0),
    [orchestrators],
  );

  // ── selectedTeamId dérivé du selectedSessionId (lifté Step 3). Sert à
  //    la TopBar pour appliquer la classe `.active` sur la pill active. ─
  const selectedTeamId = useMemo<string | null>(
    () => {
      if (!selectedSessionId) return null;
      const found = orchestrators.find((o) =>
        o.sessions.some((s) => s.id === selectedSessionId),
      );
      return found?.id ?? null;
    },
    [orchestrators, selectedSessionId],
  );

  // ── Step 7 ── selected agent / team / messages for RightPanel ────────
  // useSession polls `/sessions/:id` every 2 s so the head/cfg/meta data
  // stays fresh independent of the 3 s orchestrators poll. `roles` is
  // needed for `leadPrompt` (canonical) + `connectors` (Discord chip).
  const { roles } = useRoles();
  const { session: selectedSession } = useSession(selectedSessionId);

  // Live counters fed by Terminal.tsx callbacks. Reset on session change.
  const [logLines, setLogLines] = useState(0);
  const [writer, setWriter] = useState<boolean | undefined>(undefined);
  const [inboxMessages, setInboxMessages] = useState<readonly MailMessageView[]>([]);

  useEffect(() => {
    setLogLines(0);
    setWriter(undefined);
    setInboxMessages([]);
  }, [selectedSessionId]);

  const onTerminalDataFrame = useCallback(() => {
    setLogLines((n) => n + 1);
  }, []);
  const onTerminalRoleChange = useCallback((r: 'writer' | 'reader') => {
    setWriter(r === 'writer');
  }, []);

  // ── selectedOrch / selectedRole / isLead — derived from the polls ────
  const selectedOrch = useMemo(
    () => orchestrators.find((o) => o.id === selectedSession?.orchestratorId) ?? null,
    [orchestrators, selectedSession?.orchestratorId],
  );
  const selectedRole = useMemo(
    () => roles.find((r) => r.id === selectedOrch?.roleId) ?? null,
    [roles, selectedOrch?.roleId],
  );
  const isLead =
    !!selectedSession && !!selectedOrch &&
    selectedSession.id === selectedOrch.leadSessionId;

  const selectedTeam: RightPanelTeam | null = useMemo(() => {
    if (!selectedOrch || !selectedSession) return null;
    return buildRightPanelTeam(selectedOrch, selectedRole, selectedSession.cwd);
  }, [selectedOrch, selectedRole, selectedSession]);

  const selectedAgent: RightPanelAgent | null = useMemo(() => {
    if (!selectedSession) return null;
    return buildRightPanelAgent(selectedSession, logLines, writer);
  }, [selectedSession, logLines, writer]);

  // ── Inbox poll (3 s) for the MESSAGES tab. Distinct from the
  // MapView inbox-count poller (which wants {count} per session for
  // every active session, not the full messages array for one). Two
  // pollers on the same endpoint is acceptable — see spec §4.4. ───
  useEffect(() => {
    const oid = selectedOrch?.id;
    const sid = selectedSession?.id;
    if (!oid || !sid) return;
    let cancelled = false;
    async function poll() {
      try {
        const r = await api.peekInbox(oid!, sid!);
        if (!cancelled) setInboxMessages(r.messages);
      } catch {
        /* swallow — session may have been destroyed mid-poll */
      }
    }
    void poll();
    const t = setInterval(() => void poll(), 3_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [selectedOrch?.id, selectedSession?.id]);

  const messages: readonly MessageBubble[] = useMemo(() => {
    if (!selectedSession) return [];
    return inboxMessages.map((m): MessageBubble => {
      const cls = classifyBubble(m, selectedSession.id);
      return {
        from: cls.kind,
        who: cls.authorLabel,
        text: m.content,
        ts: m.ts,
        via: cls.fromTeam?.name,
      };
    });
  }, [inboxMessages, selectedSession?.id]);

  // ── Step 8 ── adapter WaitingNotice[] (hook shape, oldest→newest) →
  //    WaitingToast[] (component shape, newest→oldest). We need
  //    teamName / agentName which are NOT in the WS frame ; resolve them
  //    via the orchestrators snapshot (already polled every 3 s for the
  //    TopBar / MapView). If the lookup fails (orch not yet arrived) we
  //    degrade gracefully: teamName='—', agentName=sessionId.slice(0,8).
  //    The toast still surfaces so the user can act on it. ────────────
  const waitingToasts = useMemo<WaitingToast[]>(
    () => {
      const reversed = [...waiting].reverse();
      return reversed.map<WaitingToast>((n) => {
        const orch = n.orchestratorId
          ? orchestrators.find((o) => o.id === n.orchestratorId)
          : undefined;
        const session = orch && n.sessionId
          ? orch.sessions.find((s) => s.id === n.sessionId)
          : undefined;
        return {
          id: n.id,
          sessionId: n.sessionId ?? n.id,
          teamId: n.orchestratorId ?? '',
          teamName: orch?.name ?? '—',
          agentName: session?.name ?? (n.sessionId ? n.sessionId.slice(0, 8) : '—'),
          reason: n.reason,
          at: n.ts,
        };
      });
    },
    [waiting, orchestrators],
  );

  // ── handlers ─────────────────────────────────────────────────────────
  // selectAgent: fired from the MapView (any node click — lead OR worker)
  // and from background-click (id === null). We sync the hash too so the
  // route effect above sees `routeOrchestratorId` aligned with the click;
  // without that sync, the next orchestrators poll would clear the
  // selection (no route) or snap it back to the lead (wrong worker).
  function selectAgent(id: string | null) {
    setSelectedSessionId(id);
    if (id === null) return;
    const orch = orchestrators.find((o) =>
      o.sessions.some((s) => s.id === id),
    );
    if (orch) onOpenOrchestrator(orch.id);
  }

  // ── Step 8 ── handleToastOpen: pré-sélectionne la session, sync le
  //    hash via le callback parent, puis dismiss le toast (proto v2
  //    behavior, cf. spec §7.2.4). Edge case: si teamId est vide
  //    (orchestratorId absent du frame WS) on saute le route sync ; la
  //    sélection via setSelectedSessionId reste utile.
  function handleToastOpen(t: WaitingToast) {
    if (t.sessionId) setSelectedSessionId(t.sessionId);
    if (t.teamId) onOpenOrchestrator(t.teamId);
    dismiss(t.id);
  }
  function closeRightPanel() {
    setSelectedSessionId(null);
    onCloseRightPanel();
  }
  // ── handleSelectTeam (Step 4) : clic sur une team-pill de la TopBar.
  //    1. lift le selectedSessionId sur le lead de la team ;
  //    2. sync le hash → `#/orchestrators/:id` via le callback parent
  //       (qui re-déclenche l'effet `routeOrchestratorId` mais c'est ok
  //       car la sélection est déjà à jour). ────────────────────────
  function handleSelectTeam(leadSessionId: string) {
    if (!leadSessionId) return;
    setSelectedSessionId(leadSessionId);
    const orch = orchestrators.find((o) =>
      o.sessions.some((s) => s.id === leadSessionId),
    );
    if (orch) onOpenOrchestrator(orch.id);
  }

  // ── Step 7 ── onAction dispatch (lead vs worker; ConfirmModal lives in
  //    RightPanel; this handler is fired AFTER user confirmation). ────
  async function onAction(agentId: string, action: AgentAction) {
    if (!selectedOrch || !selectedSession) return;
    const actingOnLead = selectedSession.id === selectedOrch.leadSessionId;
    try {
      switch (action) {
        case 'stop':
          if (actingOnLead) {
            await api.destroyOrchestrator(selectedOrch.id);
            setSelectedSessionId(null);
          } else {
            await api.stopSession(agentId);
          }
          return;
        case 'pause':
          await api.pauseSession(agentId);
          return;
        case 'resume':
          await api.resumeSession(agentId);
          return;
        case 'restart': {
          // Lead is NOT restartable (S5 → 409 LEAD_NOT_RESTARTABLE). The
          // button is `disabled` for leads but we keep the guard here too.
          if (actingOnLead) {
            console.warn('lead restart not supported by server (S5)');
            return;
          }
          const { newSession } = await api.restartSession(agentId);
          setSelectedSessionId(newSession.id);
          return;
        }
        case 'kill':
          // KILL = graceful stop + auto-remove from the map. Identical PTY
          // shutdown path as STOP (SIGTERM → 5s grace → SIGKILL) but with
          // the hide flag set so the session/team disappears from the map
          // as soon as it reaches terminal — no second REMOVE click.
          if (actingOnLead) {
            await api.destroyOrchestrator(selectedOrch.id, { hide: true });
          } else {
            await api.stopSession(agentId, { hideAfterExit: true });
          }
          setSelectedSessionId(null);
          return;
        case 'start':
          // REACTIVATE — disabled in the UI (gap §4-8). No-op fallback.
          console.warn('start/reactivate not supported v1 (gap §4-8)');
          return;
        case 'remove':
          // Soft-delete from the map. Lead → cascade to whole team.
          if (actingOnLead) {
            await api.hideOrchestrator(selectedOrch.id);
          } else {
            await api.hideSession(agentId);
          }
          setSelectedSessionId(null);
          return;
      }
    } catch (err) {
      // TODO Step 8 / Phase D : surface error via Toasts.
      console.error(`action ${action} failed:`, err);
    }
  }

  // ── Step 7 ── onSend dispatch (PTY vs mailbox; agent vs team). ──────
  async function onSend(
    agentId: string,
    text: string,
    opts: { mode: ComposerMode; audience: ComposerAudience },
  ) {
    if (!selectedOrch) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      if (opts.audience === 'team') {
        // PTY and MAILBOX both collapse to broadcastToOrchestrator on
        // the wire (server route: human → all sessions mailbox push).
        await api.broadcastToOrchestrator(selectedOrch.id, trimmed);
        return;
      }
      // audience === 'agent'
      if (opts.mode === 'mailbox') {
        console.warn('AGENT/MAILBOX disabled v1 (gap §4-5)');
        return;
      }
      // AGENT + PTY : raw keystrokes. Append \n so the line is submitted.
      const data = trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`;
      await api.postSessionInput(agentId, data);
    } catch (err) {
      console.error('send failed:', err);
    }
  }

  return (
    <div className="app">
      <TopBar
        teams={topBarTeams}
        selectedTeamId={selectedTeamId}
        flashTeamIds={flashTeamIds}
        totalAgents={totalAgents}
        info={topBarInfo}
        onSelectTeam={handleSelectTeam}
        onNewTeam={() => setShowNew(true)}
        onOpenRoles={() => {
          // Step 10 : delegate to App.tsx hash-router when wired ; fall
          // back to legacy placeholder state otherwise. The placeholder
          // setter remains here so Steps 11+ (Settings, Broadcast, …)
          // can mirror the same pattern when they land.
          if (onOpenRoles) onOpenRoles();
          else setShowRoles(true);
        }}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div className="main">
        <LeftPanel
          orchestrators={orchestrators}
          onSelectTeam={(sessionId) => {
            // 1. lift sélection sur le lead de la team cliquée
            setSelectedSessionId(sessionId);
            // 2. sync hash → #/orchestrators/:id (le RightPanel s'ouvre)
            const orch = orchestrators.find(
              (o) => o.leadSessionId === sessionId,
            );
            if (orch) onOpenOrchestrator(orch.id);
          }}
          onSelectEnded={(orchId) => {
            // Drilldown read-only : on route vers la team terminée ; le
            // `RightPanel` détectera `endedAt != null` (Step B.7) et passera
            // son composer en disabled. La pré-sélection du lead est gérée
            // par l'effet `routeOrchestratorId` ci-dessus.
            onOpenOrchestrator(orchId);
          }}
        />
        <MapView
          teams={mapViewTeams}
          selectedId={selectedSessionId}
          onSelect={selectAgent}
          onBroadcast={() => setBroadcastOpen(true)}
          pulses={pulses}
          spawningIds={spawningIds}
        />
        <RightPanel
          selected={selectedAgent}
          team={selectedTeam}
          isLead={isLead}
          messages={messages}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          onClose={closeRightPanel}
          onAction={onAction}
          onSend={onSend}
          onSpawnWorker={(team) => {
            // `team` is the RightPanelTeam projection; resolve to the
            // live OrchestratorView for the modal (cf. spec §9.2).
            const orch = orchestrators.find((o) => o.id === team.id);
            if (orch) setSpawnFor(orch);
          }}
          onEditConfig={(team) => {
            const orch = orchestrators.find((o) => o.id === team.id);
            if (orch) setEditConfigFor(orch);
          }}
          onTerminalRoleChange={onTerminalRoleChange}
          onTerminalDataFrame={onTerminalDataFrame}
        />
      </div>

      {/* Phase C — Step 9 : NewOrchestratorDialog overlay. We delegate to
          `useOrchestrators().create` (it unwraps the `{orchestrator, lead}`
          response from POST /orchestrators and refreshes the snapshot
          immediately so the new team-pill shows up without waiting for
          the 3 s poll). On success we call `triggerFlash(o.id)` directly;
          the helper handles dedup with the WS-event path (Step 19) so
          double-firing (manual call + WS frame) only flashes once. */}
      <NewOrchestratorDialog
        open={showNew}
        onClose={() => setShowNew(false)}
        onCreate={async (body) => {
          const orch = await createOrchestrator(body);
          triggerFlash(orch.id);
          return orch;
        }}
      />
      {/* Phase C — Step 10 : RolesPage overlay (rendered by App.tsx — hash route) */}
      {/* Phase C — Step 11 : SettingsDrawer. Auto-opens when authState is
          missing/invalid (see effect above) and on demand via the cog
          button in the TopBar. We pass `wsConnected` from the SAME
          `useEvents()` call as the toasts/EventsPip pipeline below to
          keep a single WS connection (regression-guard 584d9ec). */}
      {settingsOpen && (
        <SettingsDrawer
          info={info}
          health={health}
          authState={authState}
          wsConnected={eventsConnected}
          onClose={() => setSettingsOpen(false)}
          onTokenSaved={() => { void probeAuth(); }}
          onTokenCleared={() => setAuthState('missing')}
        />
      )}
      {/* Phase C — Step 12 : BroadcastModal. Triggered by the hub click
          on MapView (`onBroadcast` → `setBroadcastOpen(true)`). The
          modal owns the iteration over `api.broadcastToOrchestrator`
          for each active team (workaround §4-1 — no `/swarm/broadcast`
          endpoint yet) ; we just pass the live orchestrator snapshot
          from the same `useOrchestrators` poll that already feeds the
          TopBar / MapView (avoids a second 3 s poll). */}
      <BroadcastModal
        open={broadcastOpen}
        orchestrators={orchestrators}
        onClose={() => setBroadcastOpen(false)}
      />
      {/* Phase C — Step 13 : SpawnWorkerDialog / EditConfigDialog
          (preview-disabled — see docs/redesign-desktop/13_*.md). Both
          dialogs are fully interactive but their submit buttons are
          disabled with a tooltip and an in-modal `.field-warn`
          explaining the missing endpoints (gap §4-3 / §4-2). No backend
          call is issued from either modal v1. */}
      <SpawnWorkerDialog
        open={spawnFor !== null}
        team={spawnFor}
        roles={roles}
        onClose={() => setSpawnFor(null)}
      />
      <EditConfigDialog
        open={editConfigFor !== null}
        team={editConfigFor}
        onClose={() => setEditConfigFor(null)}
      />

      {waitingToasts.length > 0 ? (
        <Toasts
          items={waitingToasts}
          onOpen={handleToastOpen}
          onDismiss={dismiss}
        />
      ) : (
        <EventsPip connected={eventsConnected} />
      )}
    </div>
  );
}


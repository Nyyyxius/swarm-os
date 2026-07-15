// packages/web/src/controller/SwarmController.tsx
//
// Mobile-redesign Slice 0 — the lifted shell controller.
//
// All shared live state + operator handlers that used to live INSIDE
// `DesktopShell` now live here, in a provider mounted ABOVE the shell in
// `App.tsx`. Two reasons, both load-bearing:
//
//   1. Single `useEvents()` invariant (regression-guard 584d9ec): exactly
//      one `/ws/events` WebSocket may exist app-wide. With the controller
//      above the shell, the WS lives in a node that does NOT unmount when
//      we swap DesktopShell ↔ MobileShell at the responsive breakpoint —
//      so there is never a transient second consumer.
//
//   2. No WS cut / no lost `waiting` toasts when the breakpoint is crossed
//      at runtime (resize / rotation / devtools). The shell child remounts;
//      the controller (and its socket + toast state) does not.
//
// DesktopShell and MobileShell are now pure presentation: each calls
// `useSwarmController()` and renders. The business logic (action routing,
// send dispatch, selection sync, pulses/anim, auth probe, inbox polls) is
// identical for both — it is defined ONCE here.
//
// The body below is relocated verbatim from the pre-mobile DesktopShell so
// desktop behaviour is byte-for-byte preserved; only the wrapping changed.

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { type TopBarTeam, type TopBarInfo } from '../components/desktop/TopBar';
import {
  type RightPanelAgent, type RightPanelTeam, type MessageBubble,
  type RightPanelTab, type AgentAction,
} from '../components/desktop/RightPanel';
import { type WaitingToast } from '../components/desktop/Toasts';
import { type AuthState } from '../components/desktop/SettingsDrawer';
import { type ComposerAudience, type ComposerMode } from '../components/desktop/Composer';
import { type MapPulse, type MapViewTeam } from '../components/desktop/MapView';
import { useOrchestrators } from '../hooks/useOrchestrators';
import { useRoles } from '../hooks/useRoles';
import { useSession } from '../hooks/useSession';
import { useEvents, type MailboxMessageEvent } from '../hooks/useEvents';
import {
  api, getToken, HttpError,
  type HealthView, type InfoView, type MailMessageView,
  type OrchestratorView, type RoleView,
} from '../api/client';
import { deriveTopBarPillStatus } from '../lib/topBarStatus';
import { useNow } from '../lib/useNow';
import { classifyBubble } from '../lib/mailBubble';
import { toMapViewTeams } from '../components/desktop/mapTeams';
import { deriveKind, pushPulse, PULSE_CAP } from '../components/desktop/pulses';
import { buildRightPanelTeam, buildRightPanelAgent } from '../components/desktop/rightPanelAdapters';
import { type ShellMode } from '../hooks/useShellMode';

/**
 * Duration of `.flash-new` class application on a team-pill. 100 ms longer
 * than the CSS keyframe (1.6 s) so the class is removed AFTER the animation
 * completes; avoids a tail re-trigger on remount.
 */
const FLASH_MS = 1700;

/** Props supplied by App.tsx (the sovereign router) to the controller. */
export interface SwarmControllerProps {
  /** Orchestrator id extrait de `#/orchestrators/:id`, ou null sur `#/`. */
  routeOrchestratorId: string | null;
  /** Sync le hash quand l'utilisateur choisit une autre team. */
  onOpenOrchestrator: (id: string) => void;
  /** Sync le hash vers `#/` quand l'utilisateur ferme le RightPanel. */
  onCloseRightPanel: () => void;
  /** TopBar/Dock ROLES → route `#/roles`. */
  onOpenRoles?: () => void;
  /** TopBar/Dock PLUGINS → route `#/plugins`. */
  onOpenPlugins?: () => void;
  /** TopBar/Dock IDE → route `#/ide`. */
  onOpenIde?: () => void;
  /** Current shell-mode override (auto|desktop|mobile), from useShellMode. */
  shellMode: ShellMode;
  /** Persist a shell-mode override (escape hatch from the auto breakpoint). */
  setShellMode: (m: ShellMode) => void;
  children: ReactNode;
}

/** Everything the shells (desktop + mobile) consume. */
export interface SwarmControllerValue {
  // raw live snapshot
  orchestrators: readonly OrchestratorView[];
  roles: readonly RoleView[];
  // TopBar / header
  topBarTeams: readonly TopBarTeam[];
  topBarInfo: TopBarInfo;
  selectedTeamId: string | null;
  flashTeamIds: ReadonlySet<string>;
  totalAgents: number;
  // map
  mapViewTeams: readonly MapViewTeam[];
  selectedSessionId: string | null;
  pulses: readonly MapPulse[];
  spawningIds: ReadonlySet<string>;
  // right panel / detail
  selectedAgent: RightPanelAgent | null;
  selectedTeam: RightPanelTeam | null;
  isLead: boolean;
  messages: readonly MessageBubble[];
  activeTab: RightPanelTab;
  setActiveTab: (t: RightPanelTab) => void;
  panelOpen: boolean;
  // events / toasts / auth
  eventsConnected: boolean;
  waitingToasts: readonly WaitingToast[];
  info: InfoView | null;
  health: HealthView | null;
  authState: AuthState;
  // dialog-open intents (presentation-agnostic; shells map to drawer/sheet)
  showNew: boolean;
  setShowNew: (v: boolean) => void;
  settingsOpen: boolean;
  setSettingsOpen: (v: boolean) => void;
  broadcastOpen: boolean;
  setBroadcastOpen: (v: boolean) => void;
  spawnFor: OrchestratorView | null;
  setSpawnFor: (o: OrchestratorView | null) => void;
  editConfigFor: OrchestratorView | null;
  setEditConfigFor: (o: OrchestratorView | null) => void;
  // route passthroughs
  onOpenRoles: () => void;
  onOpenPlugins: () => void;
  onOpenIde: () => void;
  /** Revision counter bumped on each plugin.host.changed WS event (live refresh). */
  pluginsRev: number;
  // shell-mode override (escape hatch from auto breakpoint)
  shellMode: ShellMode;
  setShellMode: (m: ShellMode) => void;
  // handlers
  selectAgent: (id: string | null) => void;
  handleSelectTeam: (leadSessionId: string) => void;
  handleLeftSelectTeam: (sessionId: string) => void;
  handleLeftSelectEnded: (orchId: string) => void;
  closeRightPanel: () => void;
  onAction: (agentId: string, action: AgentAction) => void | Promise<void>;
  onSend: (
    agentId: string, text: string,
    opts: { mode: ComposerMode; audience: ComposerAudience },
  ) => void | Promise<void>;
  handleToastOpen: (t: WaitingToast) => void;
  dismissToast: (id: string) => void;
  handleSpawnWorker: (team: RightPanelTeam) => void;
  handleEditConfig: (team: RightPanelTeam) => void;
  handleCreateOrchestrator: (body: Parameters<ReturnType<typeof useOrchestrators>['create']>[0]) => Promise<OrchestratorView>;
  onTerminalRoleChange: (r: 'writer' | 'reader') => void;
  onTerminalDataFrame: () => void;
  probeAuth: () => Promise<void>;
  setAuthMissing: () => void;
}

const Ctx = createContext<SwarmControllerValue | null>(null);

/** Consume the lifted controller. Throws if used outside the provider. */
export function useSwarmController(): SwarmControllerValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSwarmController must be used within <SwarmControllerProvider>');
  return v;
}

export function SwarmControllerProvider({
  routeOrchestratorId,
  onOpenOrchestrator,
  onCloseRightPanel,
  onOpenRoles,
  onOpenPlugins,
  onOpenIde,
  shellMode,
  setShellMode,
  children,
}: SwarmControllerProps) {
  // ── live orchestrators (single shared poll; resolves :id → leadSessionId
  //    AND feeds TopBar/Map/LeftPanel — one poll, not N) ─────────────────
  const { orchestrators, create: createOrchestrator } = useOrchestrators();

  // ── now (1 s tick) drives `enrichWithIdle` (running→idle at 30 s). ────
  const now = useNow(1_000);

  // ── selection ──────────────────────────────────────────────────────────
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<RightPanelTab>('console');

  // ── flash-new team pills (WS event + snapshot-diff fallback) ──────────
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

  const prevOrchIdsRef = useRef<Set<string>>(new Set());
  const orchBootSeenRef = useRef(false);
  useEffect(() => {
    const cur = new Set(orchestrators.map((o) => o.id));
    if (!orchBootSeenRef.current) {
      prevOrchIdsRef.current = cur;
      orchBootSeenRef.current = true;
      return;
    }
    for (const id of cur) {
      if (!prevOrchIdsRef.current.has(id)) triggerFlash(id);
    }
    prevOrchIdsRef.current = cur;
  }, [orchestrators, triggerFlash]);

  // ── pré-sélection du lead à partir du hash `#/orchestrators/:id` ───────
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

  // ── dialog-open intents ────────────────────────────────────────────────
  const [showNew, setShowNew] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [spawnFor, setSpawnFor] = useState<OrchestratorView | null>(null);
  const [editConfigFor, setEditConfigFor] = useState<OrchestratorView | null>(null);
  const [broadcastOpen, setBroadcastOpen] = useState(false);

  // ── auth state (probe + auto-open settings) ───────────────────────────
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
      else setAuthState('ok');
    }
  }, []);

  useEffect(() => {
    void api.health().then(setHealth).catch(() => undefined);
    void probeAuth();
  }, [probeAuth]);

  useEffect(() => {
    const t = setInterval(() => {
      void api.health().then(setHealth).catch(() => undefined);
    }, 3_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (authState === 'missing' || authState === 'invalid') setSettingsOpen(true);
  }, [authState]);

  // ── INBOX BADGES (peekInbox per active session, every 3 s) ────────────
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

  // ── SPAWN ANIMATION (diff polling + WS session.created) ───────────────
  const [spawningIds, setSpawningIds] = useState<ReadonlySet<string>>(() => new Set());
  const knownIdsRef = useRef<Set<string>>(new Set());
  const primedRef = useRef(false);

  useEffect(() => {
    const cur = new Set<string>();
    for (const o of orchestrators) {
      for (const s of o.sessions) cur.add(s.id);
    }
    if (!primedRef.current) {
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

  // ── PULSES (mailbox.message → MapPulse) ───────────────────────────────
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

  const handleOrchestratorCreated = useCallback(
    (ev: { orchestratorId: string }) => {
      triggerFlash(ev.orchestratorId);
    },
    [triggerFlash],
  );

  const handleSessionCreated = useCallback((ev: { sessionId: string }) => {
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

  // J1 plugins — bump a revision on each plugin.host.changed so the
  // PluginsPage (via usePlugins) refetches live on top of its poll.
  const [pluginsRev, setPluginsRev] = useState(0);
  const handlePluginHostChanged = useCallback(() => {
    setPluginsRev((v) => v + 1);
  }, []);

  // ── THE single useEvents() — waiting + connected + pulses pipeline ─────
  const {
    connected: eventsConnected,
    waiting,
    dismiss,
  } = useEvents({
    onMailboxMessage: handleMailboxMessage,
    onSessionCreated: handleSessionCreated,
    onOrchestratorCreated: handleOrchestratorCreated,
    onPluginHostChanged: handlePluginHostChanged,
  });

  useEffect(() => {
    if (pulses.length === 0) return;
    const t = setTimeout(() => {
      setPulses((p) => p.slice(Math.max(0, p.length - PULSE_CAP)));
    }, 1500);
    return () => clearTimeout(t);
  }, [pulses]);

  // ── DERIVED MapViewTeam[] (rebuilt each `now` tick) ───────────────────
  const mapViewTeams = useMemo(
    () => toMapViewTeams(orchestrators, now, inboxCounts),
    [orchestrators, now, inboxCounts],
  );

  // ── info (one-shot + 60 s refresh) ────────────────────────────────────
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

  // ── TopBar teams (filter ended) ───────────────────────────────────────
  const topBarTeams: readonly TopBarTeam[] = useMemo(
    () => orchestrators
      .filter((o) => o.endedAt == null)
      .map<TopBarTeam>((o) => {
        const pill = deriveTopBarPillStatus(o);
        return {
          id: o.id,
          name: o.name,
          purpose: o.role,
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

  const topBarInfo: TopBarInfo = useMemo(
    () => ({
      projectName: info?.project_name ?? '—',
      version: info?.version ?? '—',
      startedAt: info?.started_at ?? null,
    }),
    [info],
  );

  const totalAgents = useMemo(
    () => orchestrators
      .filter((o) => o.endedAt == null)
      .reduce((s, o) => s + o.sessions.length, 0),
    [orchestrators],
  );

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

  // ── selected agent / team / messages for the detail panel ─────────────
  const { roles } = useRoles();
  const { session: selectedSession } = useSession(selectedSessionId);

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

  const panelOpen = !!(selectedAgent && selectedTeam);

  // ── Inbox poll (3 s) for the MESSAGES tab (selected session) ──────────
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

  // ── waiting toasts (hook shape → component shape) ─────────────────────
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

  // ── handlers ───────────────────────────────────────────────────────────
  const selectAgent = useCallback((id: string | null) => {
    setSelectedSessionId(id);
    if (id === null) return;
    const orch = orchRef.current.find((o) =>
      o.sessions.some((s) => s.id === id),
    );
    if (orch) onOpenOrchestrator(orch.id);
  }, [onOpenOrchestrator]);

  const handleToastOpen = useCallback((t: WaitingToast) => {
    if (t.sessionId) setSelectedSessionId(t.sessionId);
    if (t.teamId) onOpenOrchestrator(t.teamId);
    dismiss(t.id);
  }, [onOpenOrchestrator, dismiss]);

  const closeRightPanel = useCallback(() => {
    setSelectedSessionId(null);
    onCloseRightPanel();
  }, [onCloseRightPanel]);

  const handleSelectTeam = useCallback((leadSessionId: string) => {
    if (!leadSessionId) return;
    setSelectedSessionId(leadSessionId);
    const orch = orchRef.current.find((o) =>
      o.sessions.some((s) => s.id === leadSessionId),
    );
    if (orch) onOpenOrchestrator(orch.id);
  }, [onOpenOrchestrator]);

  const handleLeftSelectTeam = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
    const orch = orchRef.current.find((o) => o.leadSessionId === sessionId);
    if (orch) onOpenOrchestrator(orch.id);
  }, [onOpenOrchestrator]);

  const handleLeftSelectEnded = useCallback((orchId: string) => {
    onOpenOrchestrator(orchId);
  }, [onOpenOrchestrator]);

  const handleSpawnWorker = useCallback((team: RightPanelTeam) => {
    const orch = orchRef.current.find((o) => o.id === team.id);
    if (orch) setSpawnFor(orch);
  }, []);

  const handleEditConfig = useCallback((team: RightPanelTeam) => {
    const orch = orchRef.current.find((o) => o.id === team.id);
    if (orch) setEditConfigFor(orch);
  }, []);

  const handleCreateOrchestrator = useCallback(
    async (body: Parameters<typeof createOrchestrator>[0]) => {
      const orch = await createOrchestrator(body);
      triggerFlash(orch.id);
      return orch;
    },
    [createOrchestrator, triggerFlash],
  );

  // onAction dispatch (lead vs worker; fired AFTER user confirmation) ────
  const onAction = useCallback(async (agentId: string, action: AgentAction) => {
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
          if (actingOnLead) {
            const { orchestrator } = await api.restartOrchestrator(selectedOrch.id);
            setSelectedSessionId(orchestrator.leadSessionId ?? null);
            return;
          }
          const { newSession } = await api.restartSession(agentId);
          setSelectedSessionId(newSession.id);
          return;
        }
        case 'kill':
          if (actingOnLead) {
            await api.destroyOrchestrator(selectedOrch.id, { hide: true });
          } else {
            await api.stopSession(agentId, { hideAfterExit: true });
          }
          setSelectedSessionId(null);
          return;
        case 'start': {
          const { orchestrator } = await api.restartOrchestrator(selectedOrch.id);
          setSelectedSessionId(orchestrator.leadSessionId ?? null);
          return;
        }
        case 'remove':
          if (actingOnLead) {
            await api.hideOrchestrator(selectedOrch.id);
          } else {
            await api.hideSession(agentId);
          }
          setSelectedSessionId(null);
          return;
      }
    } catch (err) {
      console.error(`action ${action} failed:`, err);
    }
  }, [selectedOrch, selectedSession]);

  // onSend dispatch (PTY vs mailbox; agent vs team) ─────────────────────
  const onSend = useCallback(async (
    agentId: string,
    text: string,
    opts: { mode: ComposerMode; audience: ComposerAudience },
  ) => {
    if (!selectedOrch) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      if (opts.audience === 'team') {
        await api.broadcastToOrchestrator(selectedOrch.id, trimmed);
        return;
      }
      if (opts.mode === 'mailbox') {
        console.warn('AGENT/MAILBOX disabled v1 (gap §4-5)');
        return;
      }
      await api.postSessionInput(agentId, trimmed, true);
    } catch (err) {
      console.error('send failed:', err);
    }
  }, [selectedOrch]);

  const setAuthMissing = useCallback(() => setAuthState('missing'), []);
  const onOpenRolesResolved = useCallback(() => { onOpenRoles?.(); }, [onOpenRoles]);
  const onOpenPluginsResolved = useCallback(() => { onOpenPlugins?.(); }, [onOpenPlugins]);
  const onOpenIdeResolved = useCallback(() => { onOpenIde?.(); }, [onOpenIde]);

  const value: SwarmControllerValue = {
    orchestrators,
    roles,
    topBarTeams,
    topBarInfo,
    selectedTeamId,
    flashTeamIds,
    totalAgents,
    mapViewTeams,
    selectedSessionId,
    pulses,
    spawningIds,
    selectedAgent,
    selectedTeam,
    isLead,
    messages,
    activeTab,
    setActiveTab,
    panelOpen,
    eventsConnected,
    waitingToasts,
    info,
    health,
    authState,
    showNew,
    setShowNew,
    settingsOpen,
    setSettingsOpen,
    broadcastOpen,
    setBroadcastOpen,
    spawnFor,
    setSpawnFor,
    editConfigFor,
    setEditConfigFor,
    onOpenRoles: onOpenRolesResolved,
    onOpenPlugins: onOpenPluginsResolved,
    onOpenIde: onOpenIdeResolved,
    pluginsRev,
    shellMode,
    setShellMode,
    selectAgent,
    handleSelectTeam,
    handleLeftSelectTeam,
    handleLeftSelectEnded,
    closeRightPanel,
    onAction,
    onSend,
    handleToastOpen,
    dismissToast: dismiss,
    handleSpawnWorker,
    handleEditConfig,
    handleCreateOrchestrator,
    onTerminalRoleChange,
    onTerminalDataFrame,
    probeAuth,
    setAuthMissing,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

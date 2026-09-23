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
import {
  type WaitingToast, type ApprovalToast, type NoticeToast, type BudgetToast,
} from '../components/desktop/Toasts';
import { type AuthState } from '../components/desktop/SettingsDrawer';
import { type ComposerAudience, type ComposerMode } from '../components/desktop/Composer';
import { type MapPulse, type MapViewTeam } from '../components/desktop/MapView';
import { useCrons } from '../hooks/useCrons';
import { useOrchestrators } from '../hooks/useOrchestrators';
import { useRoles } from '../hooks/useRoles';
import { useSession } from '../hooks/useSession';
import { useEvents, type MailboxMessageEvent, type FeatureChangedEvent } from '../hooks/useEvents';
import {
  api, apiErrorMessage, getToken, HttpError,
  type CronView, type FeatureName, type HealthView, type InfoView, type MailMessageView,
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

/**
 * How long a `NoticeToast` stays up before dismissing itself. Failures live
 * longer than successes: "COMPACT SCHEDULED" is a confirmation the operator
 * already expects, while a 409 carries a reason they have to read.
 */
const NOTICE_TTL_MS = { ok: 5_000, error: 10_000 } as const;

/** Cap on simultaneously visible notices (cf. `TOAST_MAX_VISIBLE`). */
const NOTICE_MAX_VISIBLE = 4;

/**
 * Fail-open feature map (docs/builtin-features.md D2/D10). Used when
 * `GET /features` fails — a server that predates the feature registry (404) or
 * a transient error must degrade to "everything visible", never hide a working
 * surface. Also the seed a `feature.changed` frame patches onto if it somehow
 * arrives before the first snapshot.
 */
const ALL_FEATURES_ENABLED: Record<FeatureName, boolean> = {
  ide: true,
  codegraph: true,
  board: true,
  memory: true,
  monitoring: true,
  approvals: true,
};

/**
 * Shared empty list for `selectedTeamCrons`. A frozen module-level constant,
 * so the common "this team has no cadence" case keeps a STABLE identity
 * across the 5 s poll instead of handing the panel a fresh `[]` every tick.
 */
const EMPTY_CRONS: readonly CronView[] = Object.freeze([]);

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
  /** TopBar/Dock MEMORY → route `#/memory`. */
  onOpenMemory?: () => void;
  /** TopBar BOARD → route `#/board`. */
  onOpenBoard?: () => void;
  /** TopBar APPROVALS → route `#/approvals`. */
  onOpenApprovals?: () => void;
  /** TopBar CODE GRAPH → route `#/graph`. */
  onOpenGraph?: () => void;
  /** TopBar/StatsSheet MONITORING → route `#/monitoring`. */
  onOpenMonitoring?: () => void;
  /** TopBar/Dock PLUGINS → route `#/plugins`. */
  onOpenPlugins?: () => void;
  /** TopBar SKILLS → route `#/skills`. */
  onOpenSkills?: () => void;
  /**
   * TopBar/StatsSheet/RolesPage CRONS → route `#/crons`. The optional
   * `roleId` pre-filters the screen on one role's cadences; it travels as an
   * ARGUMENT, not in the URL, because the hash router compares by strict
   * equality and would rewrite `#/crons?role=x` back to `#/`.
   */
  onOpenCrons?: (roleId?: string) => void;
  /**
   * RightPanel CONFIG tab → deep link one cron (`#/crons/<cronId>`). Separate
   * from `onOpenCrons` because the target is a cron, not a role filter.
   */
  onOpenCron?: (cronId: string) => void;
  /** TopBar/Dock IDE → route `#/ide`. */
  onOpenIde?: () => void;
  /** Plugin panel nav → route `#/panel/<plugin>/<panelId>` (feature B.3). */
  onOpenPanel?: (plugin: string, panelId: string) => void;
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
  /**
   * Cadences of the selected team's ROLE (docs/crons-agents.md §2.4). Kept
   * OUT of `selectedTeam` on purpose: this list is repolled every 5 s while a
   * lead panel is open, and folding it into that memo would rebuild the team
   * object — and every `team`-keyed consumer with it — on every poll.
   *
   * Empty unless a lead is selected AND its team has a `roleId`: the poll
   * itself is gated the same way, so a worker panel costs nothing.
   */
  selectedTeamCrons: readonly CronView[];
  isLead: boolean;
  messages: readonly MessageBubble[];
  activeTab: RightPanelTab;
  setActiveTab: (t: RightPanelTab) => void;
  panelOpen: boolean;
  // events / toasts / auth
  eventsConnected: boolean;
  waitingToasts: readonly WaitingToast[];
  /** P3 — actionable approval toasts (Approve / Deny / open console). */
  approvalToasts: readonly ApprovalToast[];
  /** Lot 14 — teams that crossed their role's cost budget. */
  budgetToasts: readonly BudgetToast[];
  /** Open the over-budget team (selects its lead) and close the toast. */
  handleBudgetOpen: (t: BudgetToast) => void;
  /** Close a budget toast without touching the team. */
  dismissBudgetToast: (id: string) => void;
  /** Generic operator notices (context reset scheduled / refused). */
  notices: readonly NoticeToast[];
  /** Close a notice before its TTL expires. */
  dismissNotice: (id: string) => void;
  /**
   * Push one onto that channel from a PAGE, not just from the controller's own
   * callbacks (Lot 15's cost export is the first: the fetch it fires lives in
   * the page, and its 404 on an older server has to be said somewhere the
   * operator will see it — an unexplained no-op is the failure mode).
   *
   * ALL-CAPS `title`, optional `body` for the server's reason. Stable
   * identity, so it is safe in a dependency array.
   */
  pushNotice: (kind: NoticeToast['kind'], title: string, body?: string) => void;
  info: InfoView | null;
  health: HealthView | null;
  authState: AuthState;
  // dialog-open intents (presentation-agnostic; shells map to drawer/sheet)
  showNew: boolean;
  setShowNew: (v: boolean) => void;
  settingsOpen: boolean;
  setSettingsOpen: (v: boolean) => void;
  /**
   * True when SETTINGS was opened from the update badge — the drawer scrolls
   * its SYSTEM UPDATE section into view. Cleared on close, so the cog never
   * inherits the badge's intent.
   */
  updatesFocus: boolean;
  /** Open SETTINGS on the SYSTEM UPDATE section (TopBar badge / mobile dock). */
  openUpdates: () => void;
  /**
   * True when SETTINGS was opened from the command launcher's APPEARANCE
   * item — the drawer scrolls its APPEARANCE section into view. Cleared on
   * close, exactly like `updatesFocus`.
   */
  appearanceFocus: boolean;
  /** Open SETTINGS on the APPEARANCE section (command launcher). */
  openAppearance: () => void;
  broadcastOpen: boolean;
  setBroadcastOpen: (v: boolean) => void;
  spawnFor: OrchestratorView | null;
  setSpawnFor: (o: OrchestratorView | null) => void;
  editConfigFor: OrchestratorView | null;
  setEditConfigFor: (o: OrchestratorView | null) => void;
  // route passthroughs
  onOpenRoles: () => void;
  onOpenMemory: () => void;
  onOpenPlugins: () => void;
  onOpenSkills: () => void;
  /** Open the agent-crons screen (`#/crons`), optionally filtered on a role. */
  onOpenCrons: (roleId?: string) => void;
  /** Open one cron on the crons screen (`#/crons/<cronId>` deep link). */
  onOpenCron: (cronId: string) => void;
  onOpenIde: () => void;
  /** Open a plugin UI panel overlay (feature B.3). */
  onOpenPanel: (plugin: string, panelId: string) => void;
  /** Revision counter bumped on each plugin.host.changed WS event (live refresh). */
  pluginsRev: number;
  /**
   * Built-in feature visibility map (docs/builtin-features.md). `true` =
   * enabled, `false` = disabled/uninstalled. **`null` = UNKNOWN** — the
   * snapshot has not been hydrated yet: consumers must NOT hide nav, redirect a
   * route, or fetch a gated page while null (D10). Hydrated by `GET /features`
   * at login and patched in place on each `feature.changed` WS frame.
   */
  features: Record<FeatureName, boolean> | null;
  /**
   * Bumped on each `feature.changed` frame. Read-only detail views
   * (`PluginsPage`'s `useFeatures`) refetch `GET /features` when it changes;
   * the `features` MAP above is patched directly and never refetched.
   */
  featuresRev: number;
  /** Enable a built-in feature (install+enable on an `uninstalled` one). */
  enableFeature: (name: FeatureName) => Promise<void>;
  /** Disable a built-in feature (data kept). */
  disableFeature: (name: FeatureName) => Promise<void>;
  /** Uninstall a built-in feature (disable + purge). */
  uninstallFeature: (name: FeatureName) => Promise<void>;
  /** Revision counter bumped on each memory.* WS event (live graph refresh). */
  memoryRev: number;
  /** Revision counter bumped on each taskboard.* WS event (live board refresh). */
  boardRev: number;
  onOpenBoard: () => void;
  /** Revision counter bumped on each approval.* WS event (live approvals refresh). */
  approvalsRev: number;
  onOpenApprovals: () => void;
  /** Revision counter bumped on each code.graph.* WS event (live graph refresh). */
  graphRev: number;
  onOpenGraph: () => void;
  /** Open the per-agent monitoring page (`#/monitoring`). */
  onOpenMonitoring: () => void;
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
  /**
   * Arm a compact/clear on an arbitrary session — NOT the selected one.
   * `onAction` resolves its target from the current selection, which the
   * monitoring page (one actionable row per agent) cannot use.
   */
  onContextReset: (
    sessionId: string,
    cmd: 'compact' | 'clear',
  ) => void | Promise<void>;
  onSend: (
    agentId: string, text: string,
    opts: { mode: ComposerMode; audience: ComposerAudience },
  ) => void | Promise<void>;
  handleToastOpen: (t: WaitingToast) => void;
  dismissToast: (id: string) => void;
  /** P3 — resolve an approval as approved (optionally "don't ask again"). */
  approveApproval: (t: ApprovalToast, opts?: { dontAskAgain?: boolean }) => void;
  /** P3 — resolve an approval as denied. */
  denyApproval: (t: ApprovalToast) => void;
  /** P3 — open the blocked session's console (fallback; does not resolve). */
  handleApprovalOpen: (t: ApprovalToast) => void;
  /** P3 — dismiss an approval toast locally without resolving it. */
  dismissApprovalToast: (id: string) => void;
  handleSpawnWorker: (team: RightPanelTeam) => void;
  /**
   * Lot 7 — the actual `POST /orchestrators/:id/workers` call behind
   * `SpawnWorkerDialog`'s SPAWN button. Rejects with the server's `HttpError` so
   * the dialog can render the code + reason; it does NOT close the dialog.
   */
  handleSpawnWorkerSubmit: (
    orchestratorId: string,
    body: Parameters<ReturnType<typeof useOrchestrators>['spawnWorker']>[1],
  ) => Promise<{ sessionId: string }>;
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
  onOpenMemory,
  onOpenBoard,
  onOpenApprovals,
  onOpenGraph,
  onOpenMonitoring,
  onOpenPlugins,
  onOpenSkills,
  onOpenCrons,
  onOpenCron,
  onOpenIde,
  onOpenPanel,
  shellMode,
  setShellMode,
  children,
}: SwarmControllerProps) {
  // ── live orchestrators (single shared poll; resolves :id → leadSessionId
  //    AND feeds TopBar/Map/LeftPanel — one poll, not N) ─────────────────
  const {
    orchestrators,
    create: createOrchestrator,
    spawnWorker,
  } = useOrchestrators();

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
  // Set only by the update badge; cleared whenever the drawer closes so the
  // next cog click opens a plain SETTINGS.
  const [updatesFocus, setUpdatesFocus] = useState(false);
  // Idem pour APPEARANCE, ouvert depuis l'item du command launcher. Deux
  // drapeaux distincts plutôt qu'un `focusSection: string | null` : chacun
  // n'est lu que par sa propre section, et le typage garde l'exhaustivité.
  const [appearanceFocus, setAppearanceFocus] = useState(false);
  const setSettingsOpenResolved = useCallback((v: boolean) => {
    if (!v) { setUpdatesFocus(false); setAppearanceFocus(false); }
    setSettingsOpen(v);
  }, []);
  const openUpdates = useCallback(() => {
    setUpdatesFocus(true);
    setSettingsOpen(true);
  }, []);
  const openAppearance = useCallback(() => {
    setAppearanceFocus(true);
    setSettingsOpen(true);
  }, []);
  // ── generic operator notices ───────────────────────────────────────────
  // The toast stack until now only carried SERVER-pushed events (waiting
  // sessions, approval requests) fed by `useEvents`. Context reset is the
  // first operator action whose outcome is invisible otherwise: the reset is
  // DEFERRED to the agent's next idle, so a successful call changes nothing
  // on screen for possibly minutes, and a 409 (`RESET_ALREADY_PENDING`,
  // `PROVIDER_NO_RESET`) would vanish into console.error. Hence this minimal
  // generic channel — push a line, it self-dismisses, the operator can close
  // it early. Kept deliberately small: no queue, no dedup, no severity beyond
  // ok/error.
  const [notices, setNotices] = useState<readonly NoticeToast[]>([]);
  const noticeIdRef = useRef(1);
  const noticeTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const timers = noticeTimersRef.current;
    return () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const dismissNotice = useCallback((id: string) => {
    setNotices((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const pushNotice = useCallback(
    (kind: NoticeToast['kind'], title: string, body?: string) => {
      const id = `notice-${noticeIdRef.current++}`;
      setNotices((prev) => [
        { id, kind, title, body, at: Date.now() },
        // Capped like the waiting stack: the monitoring table puts a COMPACT
        // button on every row, so a bulk pass would otherwise paper the
        // screen with a dozen simultaneous toasts.
        ...prev.slice(0, NOTICE_MAX_VISIBLE - 1),
      ]);
      const timer = setTimeout(() => {
        noticeTimersRef.current.delete(timer);
        setNotices((prev) => prev.filter((n) => n.id !== id));
      }, NOTICE_TTL_MS[kind]);
      noticeTimersRef.current.add(timer);
    },
    [],
  );

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

  // ── live orchestrators mirror (read by handlers without re-subscribing) ─
  const orchRef = useRef(orchestrators);
  useEffect(() => { orchRef.current = orchestrators; }, [orchestrators]);

  // NOTE — the INBOX BADGE poll that used to live here is GONE
  // (docs/monitoring-agents.md, Lot 1). It fanned out one `peekInbox` request
  // per live session every 3 s purely to feed the `INBOX N` badge on the map
  // nodes; the server now decorates `SessionView.inboxCount` on the
  // `/orchestrators` payload we already poll, and `toMapViewTeams` reads it
  // straight off the session. The remaining `peekInbox` call (below, for the
  // SELECTED session) is a different thing: it fetches message CONTENT for
  // the MESSAGES tab, which no list payload carries.

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

  // ── Built-in features (docs/builtin-features.md D10) ──────────────────────
  // `null` until the first `GET /features` snapshot: UNKNOWN, so no nav is
  // hidden and no gated route is redirected. Patched IN PLACE on each
  // `feature.changed` frame (no refetch of the map); `featuresRev` bumps so the
  // detail views (PluginsPage) can refetch the richer `FeatureView[]`.
  const [features, setFeatures] = useState<Record<FeatureName, boolean> | null>(null);
  const [featuresRev, setFeaturesRev] = useState(0);
  const handleFeatureChanged = useCallback((ev: FeatureChangedEvent) => {
    setFeatures((prev) => ({
      ...(prev ?? ALL_FEATURES_ENABLED),
      [ev.name]: ev.state === 'enabled',
    }));
    setFeaturesRev((v) => v + 1);
  }, []);

  // Shared memory graph — bump a revision on each memory.* frame so the
  // MemoryPage (via useMemoryNotes) re-fetches live on top of its 3 s poll.
  const [memoryRev, setMemoryRev] = useState(0);
  const handleMemoryEvent = useCallback(() => {
    setMemoryRev((v) => v + 1);
  }, []);

  // Taskboard — bump a revision on each taskboard.* frame so BoardPage
  // (via useBoard) re-fetches live on top of its poll.
  const [boardRev, setBoardRev] = useState(0);
  const handleBoardEvent = useCallback(() => {
    setBoardRev((v) => v + 1);
  }, []);

  // Approval gate — bump a revision on each approval.* frame so ApprovalsPage
  // (via useApprovals) re-fetches live on top of its poll.
  const [approvalsRev, setApprovalsRev] = useState(0);
  const handleApprovalEvent = useCallback(() => {
    setApprovalsRev((v) => v + 1);
  }, []);

  // Code graph — bump a revision on each code.graph.* frame so CodeGraphPage
  // (via useCodeGraph) re-fetches live on top of its poll.
  const [graphRev, setGraphRev] = useState(0);
  const handleGraphEvent = useCallback(() => {
    setGraphRev((v) => v + 1);
  }, []);

  // ── THE single useEvents() — waiting + connected + pulses pipeline ─────
  const {
    connected: eventsConnected,
    waiting,
    dismiss,
    approvals,
    dismissApproval,
    clearApprovals,
    budgets,
    dismissBudget,
    clearBudgets,
  } = useEvents({
    onMailboxMessage: handleMailboxMessage,
    onSessionCreated: handleSessionCreated,
    onOrchestratorCreated: handleOrchestratorCreated,
    onPluginHostChanged: handlePluginHostChanged,
    onMemoryEvent: handleMemoryEvent,
    onBoardEvent: handleBoardEvent,
    onApprovalRequested: handleApprovalEvent,
    onApprovalResolved: handleApprovalEvent,
    onGraphEvent: handleGraphEvent,
    onFeatureChanged: handleFeatureChanged,
  });

  // ── Hydrate the feature map once authenticated ────────────────────────────
  // `GET /features` is behind the auth gate (D10), so it is fetched when the
  // token probe says `ok` — NOT via the public `/info`. A failure (404 on a
  // server predating the registry, or a transient error) degrades to
  // fail-open: every feature reads as enabled, which also lifts the deep-link
  // page-fetch gate so an older backend behaves exactly as before.
  useEffect(() => {
    if (authState !== 'ok') return;
    let alive = true;
    void api.listFeatures()
      .then((r) => {
        if (!alive) return;
        const map = { ...ALL_FEATURES_ENABLED };
        for (const f of r.features) map[f.name] = f.state === 'enabled';
        setFeatures(map);
      })
      .catch(() => {
        if (alive) setFeatures((prev) => prev ?? { ...ALL_FEATURES_ENABLED });
      });
    return () => { alive = false; };
  }, [authState]);

  // ── Flush actionable toasts a feature toggle has invalidated ──────────────
  // On a genuine enabled→off transition (observed after hydration): the
  // approvals stack when `approvals` goes off — its Approve/Deny buttons would
  // hit a 404'd route — and the budget stack when `monitoring` goes off, whose
  // notices drill into the now-hidden cost surface. Re-enabling clears nothing
  // (there is no stale toast when a feature was off).
  const prevFeaturesRef = useRef<Record<FeatureName, boolean> | null>(null);
  useEffect(() => {
    const prev = prevFeaturesRef.current;
    prevFeaturesRef.current = features;
    if (!prev || !features) return;
    if (prev.approvals !== false && features.approvals === false) clearApprovals();
    if (prev.monitoring !== false && features.monitoring === false) clearBudgets();
  }, [features, clearApprovals, clearBudgets]);

  // ── Feature verbs — call the API and let the `feature.changed` frame refresh
  //    the map (+ bump `featuresRev` for the detail views). PluginsPage awaits
  //    these then refetches its own richer list for immediate feedback. ──────
  const enableFeature = useCallback(async (name: FeatureName) => {
    await api.enableFeature(name);
  }, []);
  const disableFeature = useCallback(async (name: FeatureName) => {
    await api.disableFeature(name);
  }, []);
  const uninstallFeature = useCallback(async (name: FeatureName) => {
    await api.uninstallFeature(name);
  }, []);

  useEffect(() => {
    if (pulses.length === 0) return;
    const t = setTimeout(() => {
      setPulses((p) => p.slice(Math.max(0, p.length - PULSE_CAP)));
    }, 1500);
    return () => clearTimeout(t);
  }, [pulses]);

  // ── DERIVED MapViewTeam[] (rebuilt each `now` tick) ───────────────────
  const mapViewTeams = useMemo(
    () => toMapViewTeams(orchestrators, now),
    [orchestrators, now],
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

  // `updateAvailable` is derived from the SAME `info` object as `version`, in
  // the same memo: the badge and the version string are one render, always.
  // A server without the detector omits `update` entirely → no badge, no throw.
  const topBarInfo: TopBarInfo = useMemo(
    () => ({
      projectName: info?.project_name ?? '—',
      version: info?.version ?? '—',
      startedAt: info?.started_at ?? null,
      updateAvailable: info?.update?.available ?? false,
      updateLatest: info?.update?.latest ?? null,
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

  // ── crons of the selected team's role (docs/crons-agents.md §2.4) ─────
  // Gated poll, `useApprovals`-style: it runs only while a LEAD panel is
  // open. A worker panel is excluded because a tick is delivered to the lead
  // only, so the data would be shown nowhere; a closed panel issues nothing.
  const { crons: allCrons } = useCrons(5_000, panelOpen && isLead);
  const selectedTeamCrons = useMemo<readonly CronView[]>(() => {
    // Mirror the poll gate explicitly. `useCrons` keeps its last snapshot
    // when it stops polling, so without this a worker panel would inherit
    // whatever the previously selected lead had fetched — data that is no
    // longer refreshed and that the worker's own header does not show.
    if (!panelOpen || !isLead) return EMPTY_CRONS;
    const roleId = selectedOrch?.roleId;
    // No role (free-form `role` string) ⇒ no cron can target this team.
    if (!roleId) return EMPTY_CRONS;
    const own = allCrons.filter((c) => c.roleId === roleId);
    // Keep the identity stable while the list is empty: `filter` allocates a
    // new array on every 5 s poll, which would re-render the panel for
    // nothing on the (common) team that has no cadence at all.
    return own.length === 0 ? EMPTY_CRONS : own;
  }, [allCrons, selectedOrch?.roleId, panelOpen, isLead]);

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

  // ── approval toasts (hook shape → component shape) ────────────────────
  // Same enrichment as waitingToasts: resolve the team/agent NAMES off the
  // live snapshot so the toast reads "team :: agent" rather than raw ids.
  const approvalToasts = useMemo<ApprovalToast[]>(
    () => {
      const reversed = [...approvals].reverse();
      return reversed.map<ApprovalToast>((n) => {
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
          category: n.category,
          summary: n.requestedSummary,
          at: n.ts,
        };
      });
    },
    [approvals, orchestrators],
  );

  // ── budget toasts (hook shape → component shape) ──────────────────────
  // Same enrichment idiom as the two stacks above. The team NAME is taken
  // from the frame first and from the live snapshot second: the payload names
  // the team as it was when the janitor priced it, and a team destroyed
  // between the crossing and the render would otherwise be an anonymous `—`
  // on the one notice that says why it stopped.
  const budgetToasts = useMemo<BudgetToast[]>(
    () => {
      const reversed = [...budgets].reverse();
      return reversed.map<BudgetToast>((n) => {
        const orch = n.orchestratorId
          ? orchestrators.find((o) => o.id === n.orchestratorId)
          : undefined;
        return {
          id: n.id,
          teamId: n.orchestratorId ?? '',
          teamName: n.teamName ?? orch?.name ?? '—',
          costUsd: n.costUsd,
          budgetUsd: n.budgetUsd,
          action: n.action,
          at: n.ts,
        };
      });
    },
    [budgets, orchestrators],
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

  // OPEN TEAM — the same navigation the waiting toast performs, one level up:
  // it selects the team's LEAD rather than a session, because the subject of
  // a budget is the team and its lead is where an operator decides what to do
  // about it (resume, kill, raise the ceiling). Dismisses on the way, like the
  // waiting toast: the notice has been acted on.
  const handleBudgetOpen = useCallback((t: BudgetToast) => {
    if (t.teamId) {
      const orch = orchRef.current.find((o) => o.id === t.teamId);
      if (orch?.leadSessionId) setSelectedSessionId(orch.leadSessionId);
      onOpenOrchestrator(t.teamId);
    }
    dismissBudget(t.id);
  }, [onOpenOrchestrator, dismissBudget]);

  // ── approval handlers ─────────────────────────────────────────────────
  // POST the decision (server replays the keystroke + records it). The
  // `approval.resolved` WS frame is what normally removes the toast, but we
  // ALSO dismiss locally on success (and on a 409 = already resolved, which is
  // terminal) so the toast never lingers if the socket is slow. Any other
  // error keeps the toast so the operator can retry. `by` defaults to 'web'
  // server-side (§9.4 — anyone with the token may approve).
  const resolveApprovalToast = useCallback(
    async (id: string, decision: 'approve' | 'deny', dontAskAgain?: boolean) => {
      try {
        await api.resolveApproval(id, { decision, dontAskAgain });
        dismissApproval(id);
      } catch (e) {
        if (e instanceof HttpError && e.status === 409) {
          dismissApproval(id); // already resolved elsewhere — terminal, drop it.
          return;
        }
        // Transient/unknown failure — leave the toast up for a retry.
      }
    },
    [dismissApproval],
  );

  const approveApproval = useCallback(
    (t: ApprovalToast, opts?: { dontAskAgain?: boolean }) =>
      resolveApprovalToast(t.id, 'approve', opts?.dontAskAgain),
    [resolveApprovalToast],
  );

  const denyApproval = useCallback(
    (t: ApprovalToast) => resolveApprovalToast(t.id, 'deny'),
    [resolveApprovalToast],
  );

  // "Open the console" fallback — select the blocked session + route to it,
  // reusing the same navigation the waiting toast uses. Does NOT resolve or
  // dismiss the approval: the operator may want to answer in the PTY directly.
  const handleApprovalOpen = useCallback((t: ApprovalToast) => {
    if (t.sessionId) setSelectedSessionId(t.sessionId);
    if (t.teamId) onOpenOrchestrator(t.teamId);
  }, [onOpenOrchestrator]);

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

  /**
   * Multi-provider Lot 7 — `SpawnWorkerDialog` submit. Goes through the same
   * `useOrchestrators` handle as team creation (one shared poll, one WS), so the
   * new session is in `orchestrators` before this resolves and the map shows it
   * without waiting for the next tick.
   *
   * Errors are deliberately re-thrown: the dialog is the surface that knows how
   * to render `UNKNOWN_PROVIDER` / `PROVIDER_UNAVAILABLE` / 413 / 429 next to the
   * field the operator must change. Swallowing them here would close the dialog
   * on a failure and lose the reason.
   */
  const handleSpawnWorkerSubmit = useCallback(
    async (orchestratorId: string, body: Parameters<typeof spawnWorker>[1]) => {
      const session = await spawnWorker(orchestratorId, body);
      return { sessionId: session.id };
    },
    [spawnWorker],
  );

  /**
   * Arm a deferred context reset on ANY session — deliberately decoupled
   * from the current selection.
   *
   * `onAction` below resolves its target from `selectedOrch`/`selectedSession`
   * (and derives `actingOnLead` from them), which is correct for the right
   * panel — you can only act on the agent you have open — but makes it
   * unusable from the monitoring page, where every row is actionable and the
   * selection is usually somewhere else entirely. So this one takes the
   * session id as the sole source of truth and looks its team up only to name
   * it in the toast.
   *
   * The server answers `200 {scheduled:true}`: ARMED, not done. The reset
   * fires at the agent's next idle (never mid-turn), and it is
   * `contextResetPending` on the next 3 s poll that shows it is still queued.
   * The toast says so, because "COMPACT" followed by nothing visible for two
   * minutes otherwise reads as a failure.
   */
  const onContextReset = useCallback(async (
    sessionId: string,
    cmd: 'compact' | 'clear',
  ) => {
    const label = cmd.toUpperCase();
    const orch = orchRef.current.find((o) =>
      o.sessions.some((s) => s.id === sessionId),
    );
    const session = orch?.sessions.find((s) => s.id === sessionId);
    const who = orch && session ? `${orch.name} :: ${session.name}` : sessionId;
    try {
      await api.contextReset(sessionId, cmd);
      pushNotice('ok', `${label} SCHEDULED — FIRES AT IDLE`, who);
    } catch (err) {
      // apiErrorMessage surfaces the server's `code: reason` pair
      // (PROVIDER_NO_RESET / SESSION_NOT_ACTIVE / RESET_ALREADY_PENDING);
      // `HttpError.message` alone would only say "HTTP 409".
      pushNotice('error', `${label} REFUSED — ${who}`, apiErrorMessage(err));
    }
  }, [pushNotice]);

  // onAction dispatch (lead vs worker; fired AFTER user confirmation) ────
  const onAction = useCallback(async (agentId: string, action: AgentAction) => {
    // Context actions first, BEFORE the selection guard: they are the two
    // actions that must work on an agent that is not the selected one. TS
    // narrows `action` past this switch, so the lifecycle switch below stays
    // exhaustive over exactly the remaining seven.
    switch (action) {
      case 'compact':
      case 'clear':
        await onContextReset(agentId, action);
        return;
    }
    if (!selectedOrch || !selectedSession) return;
    // Every branch below derives its TARGET from the selection, not from
    // `agentId` — `actingOnLead` decides between "destroy the team" and
    // "stop this worker". Now that `compact`/`clear` accept an arbitrary id,
    // a future caller could reasonably assume the same holds here and pass a
    // non-selected agent to `kill`, which would tear down the SELECTED team
    // instead. Refuse loudly rather than act on the wrong agent.
    if (agentId !== selectedSession.id) {
      console.error(
        `onAction(${action}): agentId ${agentId} is not the selected session `
        + `(${selectedSession.id}); lifecycle actions only act on the selection. `
        + 'Use onContextReset for selection-independent actions.',
      );
      return;
    }
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
      // Exhaustiveness idiom (same as `TopBar.handlePick`): a new member of
      // `AgentAction` that nobody routes fails to compile here. Without it an
      // unrouted action is a silent no-op — the operator clicks, nothing
      // happens, and nothing says why.
      const _exhaustive: never = action;
      return _exhaustive;
    } catch (err) {
      console.error(`action ${action} failed:`, err);
    }
  }, [selectedOrch, selectedSession, onContextReset]);

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
  const onOpenMemoryResolved = useCallback(() => { onOpenMemory?.(); }, [onOpenMemory]);
  const onOpenBoardResolved = useCallback(() => { onOpenBoard?.(); }, [onOpenBoard]);
  const onOpenApprovalsResolved = useCallback(() => { onOpenApprovals?.(); }, [onOpenApprovals]);
  const onOpenGraphResolved = useCallback(() => { onOpenGraph?.(); }, [onOpenGraph]);
  const onOpenMonitoringResolved = useCallback(
    () => { onOpenMonitoring?.(); },
    [onOpenMonitoring],
  );
  const onOpenPluginsResolved = useCallback(() => { onOpenPlugins?.(); }, [onOpenPlugins]);
  const onOpenSkillsResolved = useCallback(() => { onOpenSkills?.(); }, [onOpenSkills]);
  const onOpenCronsResolved = useCallback(
    (roleId?: string) => { onOpenCrons?.(roleId); },
    [onOpenCrons],
  );
  const onOpenCronResolved = useCallback(
    (cronId: string) => { onOpenCron?.(cronId); },
    [onOpenCron],
  );
  const onOpenIdeResolved = useCallback(() => { onOpenIde?.(); }, [onOpenIde]);
  const onOpenPanelResolved = useCallback(
    (plugin: string, panelId: string) => { onOpenPanel?.(plugin, panelId); },
    [onOpenPanel],
  );

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
    selectedTeamCrons,
    isLead,
    messages,
    activeTab,
    setActiveTab,
    panelOpen,
    eventsConnected,
    waitingToasts,
    approvalToasts,
    budgetToasts,
    handleBudgetOpen,
    dismissBudgetToast: dismissBudget,
    notices,
    dismissNotice,
    pushNotice,
    info,
    health,
    authState,
    showNew,
    setShowNew,
    settingsOpen,
    setSettingsOpen: setSettingsOpenResolved,
    updatesFocus,
    openUpdates,
    appearanceFocus,
    openAppearance,
    broadcastOpen,
    setBroadcastOpen,
    spawnFor,
    setSpawnFor,
    editConfigFor,
    setEditConfigFor,
    onOpenRoles: onOpenRolesResolved,
    onOpenMemory: onOpenMemoryResolved,
    onOpenBoard: onOpenBoardResolved,
    approvalsRev,
    onOpenApprovals: onOpenApprovalsResolved,
    graphRev,
    onOpenGraph: onOpenGraphResolved,
    onOpenMonitoring: onOpenMonitoringResolved,
    onOpenPlugins: onOpenPluginsResolved,
    onOpenSkills: onOpenSkillsResolved,
    onOpenCrons: onOpenCronsResolved,
    onOpenCron: onOpenCronResolved,
    onOpenIde: onOpenIdeResolved,
    onOpenPanel: onOpenPanelResolved,
    pluginsRev,
    features,
    featuresRev,
    enableFeature,
    disableFeature,
    uninstallFeature,
    memoryRev,
    boardRev,
    shellMode,
    setShellMode,
    selectAgent,
    handleSelectTeam,
    handleLeftSelectTeam,
    handleLeftSelectEnded,
    closeRightPanel,
    onAction,
    onContextReset,
    onSend,
    handleToastOpen,
    dismissToast: dismiss,
    approveApproval,
    denyApproval,
    handleApprovalOpen,
    dismissApprovalToast: dismissApproval,
    handleSpawnWorker,
    handleSpawnWorkerSubmit,
    handleEditConfig,
    handleCreateOrchestrator,
    onTerminalRoleChange,
    onTerminalDataFrame,
    probeAuth,
    setAuthMissing,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

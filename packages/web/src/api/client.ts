// REST client for the swarm-os server. Sends X-Auth-Token from localStorage on
// every authenticated request. /health and /info are intentionally token-free.

const TOKEN_KEY = 'swarm-os.token';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setToken(t: string): void {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
  syncPanelCookie();
}

/**
 * Feature B.3 — plugin UI panels load in an iframe, which cannot send the
 * `X-Auth-Token` header. The server's auth gate accepts a cookie as an
 * alternative, but only for the `/plugin-api/` zone. We mirror the localStorage
 * token into that cookie: `Path=/plugin-api/` (so the browser never attaches it
 * to other routes) + `SameSite=Strict` (no cross-site attachment → CSRF-safe).
 * No `Secure` flag: swarm-os is commonly served over plain http (loopback /
 * Tailscale) and a Secure cookie would silently fail to store there.
 */
const PANEL_COOKIE = 'swarm_os_token';

/** Set or clear the panel-auth cookie to match the current token. */
export function syncPanelCookie(): void {
  const t = getToken();
  if (t) {
    document.cookie = `${PANEL_COOKIE}=${encodeURIComponent(t)}; Path=/plugin-api/; SameSite=Strict`;
  } else {
    document.cookie = `${PANEL_COOKIE}=; Path=/plugin-api/; SameSite=Strict; Max-Age=0`;
  }
}

export interface OrchestratorView {
  id: string;
  name: string;
  role: string;
  roleId: string | null;
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';
  leadSessionId: string | null;
  defaultModel: string;
  defaultEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  defaultPermissionMode: string;
  /**
   * Multi-provider Lot 2 — the adapter new agents of this team inherit
   * (`'claude'` unless the creation request or the role named another).
   * OPTIONAL on the wire on purpose: a server that predates the lot omits it,
   * and the UI must degrade to "unknown provider" rather than crash.
   */
  defaultProvider?: string;
  leadPreamble: string | null;
  workerPreamble: string | null;
  createdAt: string;
  endedAt: string | null;
  lastError: string | null;
  sessions: SessionView[];
  /**
   * Phase update_system S1 — cumulative count of bus messages pushed into
   * this orchestrator's mailbox since it started (one push = one
   * increment; broadcast to N recipients adds N). Monotone, never reset.
   * 0 for history rows recovered from SQLite (no live mailbox).
   */
  msgCount: number;
  /** Phase 4: present on history rows so UI can show "interrupted (server-restart)" etc. */
  stopReason?: string | null;
  /**
   * Phase update_system S7 — aggregated team health verdict, derived
   * server-side on every `toView()` from `status`, `lead.status`, worker
   * statuses and `lastError`. Maps 1:1 to the desktop TopBar pill
   * (`ok` = HEALTHY, `warn` = DEGRADED, `bad` = FAILED, `stopped` =
   * OFFLINE). History rows recovered from SQLite return `'bad'` (for
   * `status === 'failed'`) or `'stopped'` otherwise.
   */
  health: 'ok' | 'warn' | 'bad' | 'stopped';
  /**
   * Phase 8 — count of successful auto-resumes since this team's first
   * boot. 0 means "never restarted"; >0 means the UI surfaces a
   * "Resumed N×" chip so operators can spot restart loops.
   */
  resumeCount: number;
  /** Phase 8 — ISO timestamp of the latest successful resume (or null). */
  lastResumedAt: string | null;
}

/** Sentinel returned for `format:'password'` fields; echoed back to preserve. */
export const CONNECTOR_PASSWORD_SENTINEL = '•••';

export interface ConnectorPropSchema {
  type: 'string' | 'number' | 'boolean';
  enum?: Array<string | number>;
  default?: string | number | boolean;
  title?: string;
  description?: string;
  format?: 'password';
}
export interface ConnectorSchema {
  type: 'object';
  properties: Record<string, ConnectorPropSchema>;
  required?: string[];
}
/** One connector type available for a role connector (`GET /connector-types`). */
export interface ConnectorTypeInfo {
  type: string;
  label: string;
  schema: ConnectorSchema | null;
  builtin: boolean;
}

/**
 * What a provider adapter can express. Mirrors the server-side
 * `ProviderCapabilities` (`modules/providers/types.ts`) as rendered by
 * `GET /providers`.
 *
 * This is what lets the dialogs stop guessing: EFFORT is only a control when
 * the CLI has an equivalent of `--effort` (gemini has none), and PERMISSION is
 * only a choice when the adapter accepts more than one mode (codex has a
 * sandbox, not claude's permission modes).
 */
export interface ProviderCapabilities {
  effort: boolean;
  permissionModes: string[];
  fallbackPermissionMode: string;
  notificationHook: boolean;
  inkSubmitDance: boolean;
  durablePreamble: boolean;
  httpMcp: boolean;
}

/**
 * One entry of `GET /providers`. Mirror of the server's
 * `ProviderInfoPayload` (`http/routes/providers.ts`).
 *
 * THIS is what replaced the four hard-coded `MODELS` arrays the web bundle
 * used to carry (`desktop/constants.ts`, `NewOrchestratorDialog`,
 * `RoleDialog`, `RolesPage`) — a catalogue duplicated in four files is a
 * catalogue that is wrong in at least three.
 */
export interface ProviderInfo {
  id: string;
  label: string;
  binary: string;
  builtin: boolean;
  available: boolean;
  /**
   * Present only when `available` is false, and written for a human. The UI
   * MUST surface it: an unusable provider is rendered disabled WITH its reason
   * rather than hidden, because a missing option teaches the operator nothing
   * while "`gemini` is not on PATH on the host" tells them exactly what to do.
   */
  unavailableReason?: string;
  /** First line of `<binary> --version`, when the probe got one. */
  version?: string;
  /** Indicative catalogue. NOT exhaustive — see the free-text escape hatch. */
  models: Array<{ value: string; label: string }>;
  capabilities: ProviderCapabilities;
  defaults: { model: string; effort: string; permissionMode: string };
}

/** Body of `GET /providers`. */
export interface ProvidersView {
  /** What a team gets when neither the request nor the role names one. */
  defaultProvider: string;
  /**
   * Where agents run (`local` | `ssh`). Explains why a CLI installed on the
   * host still reads as unavailable in `local` transport, and vice-versa.
   */
  transport: string;
  providers: ProviderInfo[];
}

export interface DiscordConnectorView {
  type: 'discord';
  /**
   * Discord webhook URL for outbound system notifications. Optional — a
   * role can run bidirectional bot only (botToken + channelId) without any
   * webhook. At least one of `webhookUrl` or `botToken`+`channelId` must
   * be set; the server rejects empty connectors.
   */
  webhookUrl?: string;
  /**
   * Discord channel id (snowflake). Optional — when set AND `botToken` is
   * also set, the lead reads humans' messages from this channel and posts
   * replies via the `discord.send_message` MCP tool.
   */
  channelId?: string;
  /**
   * Per-role Discord bot OAuth token. Optional — when set, swarm-os opens
   * a dedicated Gateway connection for this role, so each role gets its
   * own Discord user identity. Replaces the previous `SWARM_OS_DISCORD_BOT_TOKEN`
   * global env var.
   */
  botToken?: string;
}
/** A plugin-provided connector (J4): provider-specific fields under `config`. */
export interface GenericConnectorView {
  type: string;
  config: Record<string, unknown>;
}

export type ConnectorView = DiscordConnectorView | GenericConnectorView;

/** Narrow a connector to the flat built-in Discord shape. */
export function isDiscordConnectorView(c: ConnectorView): c is DiscordConnectorView {
  return c.type === 'discord';
}

export interface RoleView {
  id: string;
  label: string;
  leadPrompt: string | null;
  leadPreamble: string | null;
  workerPreamble: string | null;
  workerCount: number | null;
  defaultModel: string | null;
  defaultEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  defaultPermissionMode: string | null;
  /**
   * Multi-provider Lot 2 — `null` means "inherit the instance default", the
   * same convention as `defaultModel`. Optional so fixtures and older servers
   * that never sent the field keep type-checking.
   */
  defaultProvider?: string | null;
  connectors: ConnectorView[];
  /** 5-field cron expression, or null. When set, the server's in-process
   * scheduler pokes the lead inbox of every live instance of this role. */
  schedule: string | null;
  /** Message template delivered at each cron tick ({{fire}}, {{now}},
   * {{window:Nh}}). Required when `schedule` is set. */
  scheduleMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RoleInput = Omit<RoleView, 'id' | 'createdAt' | 'updatedAt'>;

export type PluginStatus = 'disabled' | 'enabled' | 'error' | 'crashed' | 'quarantined';

/**
 * A UI panel a plugin exposes (feature B.3). Mirror of the server-side
 * `UiPanel` (modules/plugins/manifest.ts). Rendered by the SPA as an iframe.
 */
export interface UiPanel {
  id: string;
  title: string;
  path: string;
}

/** Mirror of the server-side `PluginView` (modules/plugins/api-types.ts). */
export interface PluginView {
  name: string;
  version: string;
  displayName?: string;
  status: PluginStatus;
  enabled: boolean;
  sourceKind: string;
  /**
   * git HEAD the plugin was installed from. `null` for npm/dir/upload sources
   * AND for anything installed before origin tracking existed — those can only
   * ever report an "unknown" update status.
   */
  sourceCommit: string | null;
  /**
   * Update detection for this plugin. Both are OPTIONAL on the wire: the
   * server declares them but a given build may not populate them. An absent
   * value means "not checked" — never "up to date", so the UI must stay silent
   * rather than claim anything.
   */
  latestVersion?: string | null;
  updateStatus?: 'up_to_date' | 'available' | 'unknown' | 'error';
  apiVersion: number;
  /** Capabilities the manifest requests. */
  capabilities: string[];
  /** Capabilities the operator granted (⊆ capabilities); null before first enable. */
  grantedCapabilities: string[] | null;
  failCount: number;
  quarantinedUntil: string | null;
  lastError: string | null;
  installedAt: string;
  updatedAt: string;
  /** UI panels (feature B.3). Present ONLY for an enabled plugin; else `[]`. */
  uiPanels: UiPanel[];
}

/** Body of `POST /plugins/install`. Upload is a separate raw-body endpoint. */
export type InstallSourceInput =
  | { source: 'npm'; spec: string }
  | { source: 'git'; url: string; ref?: string }
  | { source: 'dir'; dir: string };

/** Response of install / upload / upgrade. */
export interface PluginInstallResult {
  plugin: PluginView;
  isUpgrade: boolean;
  /** Manifest capabilities not yet granted (re-present for approval on upgrade). */
  newCapabilities: string[];
}

export interface SessionView {
  id: string;
  orchestratorId: string;
  name: string;
  role: string;
  type: 'lead' | 'worker';
  cwd: string;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  permissionMode: string;
  /**
   * Multi-provider Lot 2 — the adapter driving THIS agent. Per-agent, not
   * per-team: a lead on `claude` may run workers on `codex`, which is what the
   * provider tag on the map node exists to make visible. Optional for the same
   * reason as `OrchestratorView.defaultProvider`.
   */
  provider?: string;
  status:
    | 'starting'
    | 'running'
    | 'paused'
    | 'waiting'
    | 'exited'
    | 'killed'
    | 'interrupted'
    | 'failed';
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  lastError: string | null;
  stopReason: string | null;
  logPath: string;
  lastActivityAt: string;
}

/**
 * Per-instance visual settings — backs the APPEARANCE section of the
 * settings drawer. Server source-of-truth lives at
 * `packages/server/src/modules/settings/index.ts`; if you add a field there,
 * mirror it in this interface (and `INSTANCE_SETTINGS_DEFAULTS` below).
 */
export type InstanceBgTint = 'warm' | 'neutral' | 'cool';
export type InstanceDensity = 'compact' | 'regular' | 'comfy';

export interface InstanceSettingsView {
  instanceLabel: string | null;
  accent: string;
  bgTint: InstanceBgTint;
  fontSize: number;
  density: InstanceDensity;
  darkMode: boolean;
  /**
   * OpenRouter API key used by the `opencode` agent provider — **never the real
   * key**. The server masks it: `PASSWORD_SENTINEL` ('•••') when one is stored,
   * `null` when none is. Same contract as a plugin password field.
   *
   * On a PATCH: echo the sentinel back to keep the stored key, send a new string
   * to replace it, send `null` to delete it.
   */
  openrouterApiKey: string | null;
  updatedAt: string;
}

export type InstanceSettingsPatch = Partial<Omit<InstanceSettingsView, 'updatedAt'>>;

/**
 * Hard-coded defaults — same values as the server module. Used by the hook
 * for synchronous first-paint before the server's GET resolves and as a
 * fallback when no localStorage cache exists yet.
 */
export const INSTANCE_SETTINGS_DEFAULTS: InstanceSettingsView = {
  instanceLabel: null,
  accent: '#ffb060',
  bgTint: 'warm',
  fontSize: 13,
  density: 'regular',
  darkMode: true,
  openrouterApiKey: null,
  updatedAt: '1970-01-01T00:00:00.000Z',
};

export interface HealthView {
  status: string;
  project_name: string;
  orchestrators_active: number;
  sessions_active: number;
  sessions_waiting: number;
  uptime_seconds: number;
  /**
   * False while auto-resume is still replaying teams. `/health` is mounted
   * BEFORE the boot gate and answers 200 unconditionally (the Dockerfile
   * HEALTHCHECK would restart-loop a slow-but-correct resume otherwise), so
   * a 200 alone only proves the process is listening. Anything waiting for a
   * container to actually be *back* — the update overlay — gates on this bit.
   *
   * Optional on the wire: a server older than the boot gate omits it, and
   * "absent" must read as "nothing to wait for", never as "still booting".
   */
  boot_complete?: boolean;
  /** S5 — sessions an operator paused. Absent on older servers. */
  sessions_paused?: number;
}

export interface InfoView {
  project_name: string;
  version: string;
  started_at: string;
  /**
   * Build provenance baked into the image (`ARG GIT_SHA`). Null on a run from
   * source, absent on a server older than the provenance work.
   */
  commit?: string | null;
  /** `SWARM_OS_IMAGE` this deployment started from; null when the compose
   *  hardcodes its tag. */
  image?: string | null;
  /**
   * The ONLY update data `/info` carries — it is unauthenticated, so release
   * notes, plugin origins and the self-update eligibility reason stay behind
   * the auth gate in `GET /updates`.
   *
   * Optional on purpose: a server without the detector simply omits the field,
   * which must read as "no badge", never as a crash. This is what backs the
   * TopBar badge — the SPA already polls `/info` every 60 s, so the badge
   * paints in the very same `setInfo` as the version string beside it and
   * needs no poll, hook or WS event of its own.
   */
  update?: { available: boolean; latest: string | null };
}

/**
 * ── Update surface ───────────────────────────────────────────────────────
 * Hand-maintained mirror of `packages/server/src/modules/updates/index.ts`
 * (+ `plugins-check.ts`). `web` does not depend on `server` (design doc
 * §2.1), so a field added there must be added here too.
 */

/** Outcome of the last COMPLETED system check — each maps to its own sentence. */
export type SystemCheckStatus =
  | 'never_checked'
  | 'ok'
  | 'no_releases'
  | 'no_token'
  | 'unauthorized'
  | 'not_found'
  | 'error';

export interface SystemUpdateState {
  /** Version this instance is running. */
  current: string;
  /** `latest > current` AND not dismissed. Recomputed server-side on each read. */
  available: boolean;
  /** Comparable version of the newest published release (`0.6.0`). */
  latest: string | null;
  /** Its tag as published (`v0.6.0`). */
  tag: string | null;
  notesUrl: string | null;
  notesBody: string | null;
  publishedAt: string | null;
  /** Version the operator chose to hide, if any. */
  dismissedVersion: string | null;
  checkStatus: SystemCheckStatus;
  /** ISO of the last completed check, success or failure. */
  checkedAt: string | null;
  /** Message for `checkStatus === 'error'`. */
  error: string | null;
}

/**
 * Why this deployment can (or cannot) update itself. A boolean would tell an
 * operator "no" without telling them the one thing to change — hence a reason
 * per case, each with its own copy in the UI.
 */
export type SelfUpdateStatus =
  | 'ok'
  | 'transport_not_ssh'
  | 'image_not_registry'
  | 'image_not_interpolated'
  | 'env_file_not_found'
  | 'env_file_not_writable'
  | 'registry_auth_missing'
  /** Checks that need the host and don't exist yet. */
  | 'unknown';

export interface SelfUpdateEligibility {
  status: SelfUpdateStatus;
  /** One operator-facing sentence, computed server-side from this deployment. */
  detail: string;
}

export type PluginUpdateStatus = 'available' | 'up_to_date' | 'local' | 'unknown';

export interface PluginUpdateCheck {
  name: string;
  status: PluginUpdateStatus;
  /** npm only — `dist-tags.latest`. Null for git (a sha is not a version). */
  latestVersion: string | null;
  /** git only — the remote sha at the installed ref. */
  latestCommit: string | null;
  /** Stable machine-readable cause for `local`/`unknown`; null otherwise. */
  reason: string | null;
  checkedAt: string;
}

/**
 * ── Apply / schedule ──────────────────────────────────────────────────────
 * Mirror of `packages/server/src/modules/updates/runner.ts`.
 *
 *   scheduled → warning_teams → preflight → applying → verifying → success
 *        │            │             │                      ├→ rolled_back
 *    cancelled    cancelled      refused                   ├→ failed
 *                             (nothing touched)            └→ abandoned
 */
export type UpdateRunState =
  | 'scheduled'
  | 'warning_teams'
  | 'preflight'
  | 'applying'
  | 'verifying'
  | 'success'
  | 'rolled_back'
  | 'failed'
  | 'abandoned'
  | 'cancelled'
  | 'refused';

/** Terminal = nothing more will happen on its own. Mirrors `TERMINAL_UPDATE_STATES`. */
export const TERMINAL_UPDATE_STATES: ReadonlySet<UpdateRunState> = new Set<UpdateRunState>([
  'success',
  'rolled_back',
  'failed',
  'abandoned',
  'cancelled',
  'refused',
]);

/**
 * How a lead actually received the warning — NOT a counter. `read` is observed
 * server-side by pre-minting the mailbox id and checking it left the queue;
 * `queued_unread` means the notice was injected into the PTY and is still
 * sitting in the inbox; `never_idle` means the lead never offered an idle
 * boundary before the deadline; `no_lead` means there was nobody to warn.
 *
 * Those four are observations. `pending` is not: it is the placeholder row the
 * server writes for every snapshot team the instant the warning window opens,
 * and it means **nothing has been observed about this lead yet**. It used to be
 * `never_idle`, which put "this lead never reached an idle boundary" on screen —
 * "(busy for 4m31)" — about leads whose notice had already fired, for the whole
 * window. Anything this build does not recognise is treated as `pending` too:
 * an unknown value must never be able to read as a verdict.
 *
 * ⚠️ In a `pending` record `signalled` and `read` are FLOORS, not observations:
 * false because nothing was seen, not because nothing happened. Read `state`
 * first and the booleans only when it is one of the other four.
 */
export type LeadNoticeState =
  | 'read'
  | 'queued_unread'
  | 'never_idle'
  | 'no_lead'
  | 'pending';

/** One team alive at the instant the update was requested (`teamsSnapshot`). */
export interface UpdateTeamSnapshot {
  orchestratorId: string;
  name: string;
  leadSessionId: string | null;
}

/**
 * One row of `teams_warned_json`. Snake_case on the wire — this is persisted
 * JSON, not a view model, and the server writes it verbatim.
 */
export interface WarnedTeamRecord {
  orch_id: string;
  orch_name: string;
  lead_id: string | null;
  /** The notice was injected into the lead's session (not merely queued). */
  signalled: boolean;
  /** The lead consumed it before the deadline. */
  read: boolean;
  state: LeadNoticeState;
}

/** Why a team of the pre-update snapshot is (or is not) back. */
export type TeamReconcileReason = 'ok' | 'absent' | 'not_running' | 'no_lead' | 'lead_dead';

/**
 * One row of `teams_reconciled_json`, written ONCE by the boot that followed
 * the update. Snake_case on the wire for the same reason as
 * `WarnedTeamRecord`: persisted JSON, served verbatim.
 *
 * This is what makes the post-update screen still true tomorrow — it records
 * the state of the world at the instant the teams were reconciled, which no
 * amount of looking at `GET /orchestrators` later can reconstruct.
 */
export interface ReconciledTeamRecord {
  orch_id: string;
  orch_name: string;
  /** Lead session id BEFORE the update. */
  lead_id: string | null;
  /** Live, non-terminal, with a live lead. */
  back: boolean;
  /** Lead id now — differs from `lead_id` after a fresh restart-in-place. */
  lead_id_now: string | null;
  /** Orchestrator status then; `null` when it was not in the live map at all. */
  status: string | null;
  reason: TeamReconcileReason;
}

export interface UpdateRunView {
  id: string;
  kind: string;
  state: UpdateRunState;
  targetVersion: string | null;
  scheduledFor: string | null;
  warnedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Verdict message, refusal reason, or the review note on a `success`. */
  error: string | null;
  /** Live phase from the host script's `events.ndjson`; null when terminal. */
  phase: string | null;
  envFile: string | null;
  teamsSnapshot: UpdateTeamSnapshot[];
  teamsWarned: WarnedTeamRecord[];
  /**
   * §D.6 — which of `teamsSnapshot` came back, as recorded by the boot that
   * followed the update. OPTIONAL on the wire: a server older than the
   * `teams_reconciled_json` column omits it, and a run that has not been
   * through that boot sends `[]`. Both mean "no record" — the UI falls back to
   * diffing the snapshot against the live team list.
   */
  teamsReconciled?: ReconciledTeamRecord[] | null;
  /** Seconds left in the grace window; null outside `warning_teams`. */
  graceRemainingSeconds: number | null;
  terminal: boolean;
}

/** `result.json` as the host script wrote it. Every field is optional on read. */
export interface HostUpdateResult {
  script_version?: string;
  state?: string;
  exit_code?: number;
  reason?: string;
  message?: string;
  /** `boot_complete` | `healthy_no_boot_complete` | `unreachable` | `skipped`. */
  verify?: string;
  env_file?: string;
  target_image?: string;
  previous_image?: string;
  env_written?: boolean;
  deployed?: boolean;
  finished_at?: string;
}

/** `GET /updates/:id` — the view plus what only the run directory knows. */
export interface UpdateRunDetail extends UpdateRunView {
  runDir: string;
  envLineBefore: string | null;
  logTail: string;
  result: HostUpdateResult | null;
}

/** Full authenticated state — `GET /updates`. */
export interface UpdatesView {
  system: SystemUpdateState;
  plugins: PluginUpdateCheck[];
  /** ISO of the last completed plugin sweep; null until the first one. */
  pluginsCheckedAt: string | null;
  canSelfUpdate: SelfUpdateEligibility;
  /**
   * The run in flight or scheduled; null when idle. The three fields below are
   * OPTIONAL on the wire on purpose: a server that shipped detection without
   * the apply engine omits them entirely, and that must read as "this build
   * cannot apply", never as a crash.
   */
  run?: UpdateRunView | null;
  /** Newest-first history (10), for the "last update" verdict. */
  recentRuns?: UpdateRunView[];
  /** Version + sha256 of the updater script this build would run. */
  updater?: { version: string; sha256: string } | null;
}

/**
 * Phase update_system S9 — snapshot returned by `GET /metrics/messages`.
 * Shape mirrored from `packages/server/src/modules/metrics/aggregator.ts`;
 * we **do not** import server types here because `web` does not depend on
 * `server` (cf. design doc §2.1).
 */
export interface MessagesMetricsSnapshot {
  /** Σ mailbox.messagesTotal across all orchs at call time. */
  total: number;
  /** Most recent 60-second delta (`global[59]`). */
  per_minute: number;
  /** 60 ints: msg/min over the trailing 60 minutes (oldest first). */
  global: number[];
  /**
   * Per-orchestrator 8-point ring (oldest first), keyed by orch.id (UUID).
   * An orch that has just been created may not appear here until the first
   * tick after its creation.
   */
  per_orchestrator: Record<string, number[]>;
}

/**
 * Phase update_system S8 — snapshot returned by `GET /metrics/bus`. May
 * 404 if the server was instantiated without a `BusMetricsCollector`;
 * callers must tolerate the error (cf. design doc §2.2 note).
 */
export interface BusMetricsSnapshot {
  /** Sliding mean MCP RTT (ms) over the trailing 60 s window. */
  latency_ms: number;
  /** Mean bus throughput (messages / second) over the trailing window. */
  throughput_msg_per_s: number;
  /** Instantaneous Σ mailbox.totalSize() across every orch. */
  queue_depth: number;
  /** Sliding error rate (%) over the trailing window. */
  err_rate_pct: number;
  /** Constant 60 — handy for UI labelling. */
  window_seconds: number;
}

/**
 * ── Shared memory / knowledge-graph DTOs ──────────────────────────────────
 * Hand-maintained mirror of the server's `MemoryStore` view types (design doc
 * `docs/memoire-partagee.md` §7-8). `web` does not depend on `server`, so a
 * field added there must be mirrored here. Field names are wire-contractual —
 * do NOT rename them.
 *
 * A note is a markdown file with frontmatter; the graph nodes are notes and the
 * edges are the `[[wikilinks]]` between them (plus optional typed relations).
 */
export type MemoryNoteType =
  | 'user'
  | 'feedback'
  | 'project'
  | 'reference'
  | 'entity'
  | 'decision'
  | (string & {});

/** Frontmatter-level metadata — what `GET /api/memory` returns per note. */
export interface MemoryNoteMeta {
  /** Slug (kebab-case) = filename = node identity. */
  name: string;
  description: string;
  type: MemoryNoteType;
  /** Provenance: orchestrator id that authored it (optional). */
  team?: string;
  /** Provenance: session/agent that authored it (optional). */
  createdBy?: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms. */
  updatedAt: number;
  /** Optimistic-concurrency counter, bumped on every write. */
  version: number;
}

/** A full note — `GET /api/memory/:name`. */
export interface MemoryNote extends MemoryNoteMeta {
  /** Markdown body (below the frontmatter). */
  body: string;
  /** Names this note links out to (derived from `[[links]]`). */
  outLinks: string[];
  /** Names that link into this note (back-links). */
  inLinks: string[];
}

/** One node of `GET /api/memory/graph`. */
export interface GraphNode {
  name: string;
  type: MemoryNoteType;
  description?: string;
}

/** One edge of `GET /api/memory/graph`. */
export interface GraphEdge {
  from: string;
  to: string;
  relation?: string;
}

/** One hit of `GET /api/memory/search`. */
export interface SearchHit {
  name: string;
  description: string;
  type: MemoryNoteType;
  snippet: string;
  score: number;
}

/** Body of `PUT /api/memory/:name`. */
export interface MemoryNoteInput {
  description: string;
  type: MemoryNoteType;
  body: string;
  /** Optimistic lock — the version the client last read. Omit to force. */
  expectedVersion?: number;
}

class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
  }
}

/**
 * Turn a rejected `api.*` call into something an operator can act on.
 *
 * `HttpError.message` is only `HTTP 409 POST /orchestrators` — showing that in
 * a dialog is a silent failure with extra steps. The server sends a written
 * reason plus a machine code (`UNKNOWN_PROVIDER`, `PROVIDER_UNAVAILABLE`, …);
 * this surfaces both, and appends `unavailableReason` when present since that
 * is the sentence that actually tells the operator what to fix.
 */
export function apiErrorMessage(err: unknown): string {
  if (err instanceof HttpError) {
    const body = err.body as
      | { error?: string; code?: string; unavailableReason?: string | null; known?: string[] }
      | undefined;
    const head = body?.error ?? err.message;
    const parts = [body?.code ? `${body.code}: ${head}` : head];
    if (body?.unavailableReason) parts.push(body.unavailableReason);
    if (body?.known?.length) parts.push(`known providers: ${body.known.join(', ')}`);
    return parts.join(' — ');
  }
  return err instanceof Error ? err.message : String(err);
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { auth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  const auth = opts.auth ?? true;
  if (auth) headers['X-Auth-Token'] = getToken();
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  const parsed: unknown = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    throw new HttpError(`HTTP ${res.status} ${method} ${path}`, res.status, parsed);
  }
  return parsed as T;
}

/**
 * A single mail entry as returned by `GET /orchestrators/:id/mailbox/peek`.
 *
 * Authoritative semantics live in
 * `packages/server/src/modules/orchestrator/mailbox.ts:24-43`. The `from`
 * field is intentionally polymorphic; it belongs to one of four buckets
 * that the UI distinguishes via `classifyBubble` (see
 * `packages/web/src/lib/mailBubble.ts`):
 *
 * 1. `'human'`      — operator broadcast via `POST /orchestrators/:id/broadcast`.
 * 2. `'system'`     — server-emitted notice (e.g. worker exit signalled to
 *                     the lead). Future sentinel values may be added; the
 *                     classifier keeps them in a `Set` for easy extension.
 * 3. session-id (intra-team) — peer-to-peer via `team.send_message` /
 *                     `team.broadcast`. No cross-team enrichment fields.
 * 4. session-id (cross-team) — `swarm.send_to_lead` /
 *                     `swarm.broadcast_to_leads`. Distinguished on the
 *                     wire by the optional fields below being present.
 */
export interface MailMessageView {
  id: string;
  /** See JSDoc above for the four-bucket semantics. */
  from: string;
  content: string;
  ts: string;
  /**
   * Cross-team only: orchestrator id of the sending team. Absent for
   * intra-team peer messages, `'human'` and `'system'` entries.
   */
  fromOrchestratorId?: string;
  /** Cross-team only: human-readable name of the sending orchestrator. */
  fromOrchestratorName?: string;
  /** Cross-team only: name of the sending session within its team. */
  fromSessionName?: string;
}

export const api = {
  health: () => request<HealthView>('GET', '/health', undefined, { auth: false }),
  info: () => request<InfoView>('GET', '/info', undefined, { auth: false }),
  listOrchestrators: () =>
    request<{ orchestrators: OrchestratorView[] }>('GET', '/orchestrators'),
  getOrchestrator: (id: string) => request<OrchestratorView>('GET', `/orchestrators/${id}`),
  createOrchestrator: (body: {
    name: string;
    role?: string;
    roleId?: string;
    lead: { cwd: string; prompt?: string; preamble?: string };
    workerPreamble?: string;
    defaults?: {
      /** Multi-provider Lot 2 — resolved body > role > `config.defaultProvider`. */
      provider?: string;
      model?: string;
      effort?: string;
      permissionMode?: string;
    };
  }) =>
    request<{ orchestrator: OrchestratorView; lead: SessionView }>(
      'POST',
      '/orchestrators',
      body,
    ),
  /**
   * Multi-provider Lot 7 — add a worker to an existing team. The HTTP twin of
   * the MCP `team.spawn_worker` tool: only `prompt` is required, and every
   * omitted field inherits the team default server-side (that is what makes
   * "leave the selects alone" mean "inherit").
   *
   * Failures worth surfacing verbatim through `apiErrorMessage`: 400
   * `UNKNOWN_PROVIDER`, 409 `PROVIDER_UNAVAILABLE` (carries
   * `unavailableReason`), 409 `ORCH_NOT_ACTIVE`, 413 (prompt+preamble over the
   * server cap), 429 `MAX_WORKERS_PER_ORCH`.
   */
  spawnWorker: (
    orchestratorId: string,
    body: {
      name?: string;
      role?: string;
      prompt: string;
      /** Per-worker override of the team's worker preamble. */
      preamble?: string;
      provider?: string;
      model?: string;
      effort?: string;
      permissionMode?: string;
    },
  ) =>
    request<{ session: SessionView }>(
      'POST',
      `/orchestrators/${orchestratorId}/workers`,
      body,
    ),
  getPreambleDefaults: () =>
    request<{ lead: string; worker: string }>('GET', '/preambles/defaults'),
  improveText: (body: {
    field: 'leadPrompt' | 'leadPreamble' | 'workerPreamble';
    text: string;
  }) => request<{ text: string }>('POST', '/ai/improve-text', body),
  listRoles: () => request<{ roles: RoleView[] }>('GET', '/roles'),
  getRole: (id: string) => request<{ role: RoleView }>('GET', `/roles/${id}`),
  createRole: (body: Partial<RoleInput> & { label: string }) =>
    request<{ role: RoleView }>('POST', '/roles', body),
  updateRole: (id: string, body: Partial<RoleInput>) =>
    request<{ role: RoleView }>('PATCH', `/roles/${id}`, body),
  deleteRole: (id: string) => request<void>('DELETE', `/roles/${id}`),
  /** J4 — connector types available for role connectors (built-in + plugins). */
  listConnectorTypes: () =>
    request<{ connectorTypes: ConnectorTypeInfo[] }>('GET', '/connector-types'),
  /**
   * Multi-provider Lot 2 — the agent-provider catalogue: models, capabilities,
   * server defaults and live availability, per adapter.
   *
   * The availability verdict has a 60 s TTL server-side, so a CLI freshly
   * installed on the host shows up on the next call — which is why the dialogs
   * re-fetch on open instead of only on mount.
   */
  listProviders: () => request<ProvidersView>('GET', '/providers'),
  // ---- Plugins (J1 socle) --------------------------------------------------
  listPlugins: () => request<{ plugins: PluginView[] }>('GET', '/plugins'),
  getPlugin: (name: string) =>
    request<{
      plugin: PluginView;
      manifest: { configSchema?: unknown; [k: string]: unknown } | null;
      /** Redacted stored config (password fields masked as the sentinel). */
      config?: Record<string, unknown>;
    }>('GET', `/plugins/${name}`),
  scanPlugins: () => request<{ plugins: PluginView[] }>('POST', '/plugins/scan'),
  enablePlugin: (name: string, grantedCapabilities?: string[]) =>
    request<{ plugin: PluginView }>(
      'POST',
      `/plugins/${name}/enable`,
      grantedCapabilities === undefined ? {} : { grantedCapabilities },
    ),
  disablePlugin: (name: string) =>
    request<{ plugin: PluginView }>('POST', `/plugins/${name}/disable`),
  setPluginPermissions: (name: string, grantedCapabilities: string[]) =>
    request<{ plugin: PluginView }>('PUT', `/plugins/${name}/permissions`, {
      grantedCapabilities,
    }),
  setPluginConfig: (name: string, config: Record<string, unknown>) =>
    request<{ plugin: PluginView }>('PUT', `/plugins/${name}/config`, config),
  uninstallPlugin: (name: string, purge = false) =>
    request<void>('DELETE', `/plugins/${name}${purge ? '?purge=true' : ''}`),
  // ---- Plugins (J3 install from source / upgrade) --------------------------
  installPlugin: (source: InstallSourceInput) =>
    request<PluginInstallResult>('POST', '/plugins/install', source),
  /** Upload a `.tgz` (npm pack format) — RAW body, NOT JSON. */
  uploadPlugin: async (file: File | Blob, name?: string): Promise<PluginInstallResult> => {
    const qs = name ? `?name=${encodeURIComponent(name)}` : '';
    const res = await fetch(`/plugins/upload${qs}`, {
      method: 'POST',
      headers: { 'X-Auth-Token': getToken(), 'Content-Type': 'application/gzip' },
      body: file,
    });
    const ct = res.headers.get('content-type') ?? '';
    const parsed: unknown = ct.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) {
      throw new HttpError(`HTTP ${res.status} POST /plugins/upload`, res.status, parsed);
    }
    return parsed as PluginInstallResult;
  },
  upgradePlugin: (name: string) =>
    request<PluginInstallResult>('POST', `/plugins/${name}/upgrade`),
  validateDiscordToken: (token: string) =>
    request<
      | {
          ok: true;
          bot: { id: string; username: string; discriminator?: string; avatar: string | null };
        }
      | { ok: false; status: number; error: string }
    >('POST', '/api/discord/validate-token', { token }),
  createDiscordWebhook: (body: { token: string; channelId: string; name?: string }) =>
    request<
      { ok: true; webhookUrl: string } | { ok: false; status: number; error: string }
    >('POST', '/api/discord/create-webhook', body),
  /**
   * Destroy an orchestrator. `opts.hide` collapses stop-then-remove into one
   * request: the team is soft-deleted from the map as soon as the lead PTY
   * exits. Used by the KILL UI button on a lead.
   */
  destroyOrchestrator: (id: string, opts: { hide?: boolean } = {}) => {
    const qs = opts.hide ? '?hide=true' : '';
    return request<void>('DELETE', `/orchestrators/${id}${qs}`);
  },
  /**
   * Relaunch a terminal orchestrator in place — same id/config/history,
   * reusing the auto-resume mechanic server-side. Backs the desktop RESTART /
   * REACTIVATE button on a dead team's lead. 404 if unknown, 409 if still
   * running.
   */
  restartOrchestrator: (id: string) =>
    request<{ orchestrator: OrchestratorView }>('POST', `/orchestrators/${id}/restart`),
  getSession: (id: string) => request<SessionView>('GET', `/sessions/${id}`),
  /**
   * Push input to a session's PTY. `submit: true` types the line and fires
   * Enter (standalone CR) server-side so it actually executes — otherwise the
   * bytes are forwarded verbatim (raw keystroke pass-through). Do NOT append
   * `\n`/`\r` yourself when submitting; the server owns the CR.
   */
  postSessionInput: (id: string, data: string, submit = false) =>
    request<{ ok: boolean; bytes: number }>('POST', `/sessions/${id}/input`, { data, submit }),
  /**
   * S5 — stop a single worker session. Lead → 409 LEAD_NOT_STOPPABLE.
   * `opts.hideAfterExit` collapses stop-then-remove into one request: the
   * session is soft-deleted from the map once the PTY actually exits.
   * Used by the KILL UI button on a worker.
   */
  stopSession: (id: string, opts: { hideAfterExit?: boolean } = {}) =>
    request<{ stopped: true; status: string }>(
      'POST',
      `/sessions/${id}/stop`,
      opts.hideAfterExit ? { hideAfterExit: true } : undefined,
    ),
  /** S5 — pause a session via SIGSTOP. Idempotent (already paused → 409). */
  pauseSession: (id: string) =>
    request<{ paused: true; status: string }>('POST', `/sessions/${id}/pause`),
  /** S5 — resume a paused session via SIGCONT. */
  resumeSession: (id: string) =>
    request<{ resumed: true; status: string }>('POST', `/sessions/${id}/resume`),
  /**
   * S5 — restart a worker: stop the existing PTY and respawn with the same
   * config. Returns the old + new session views. Lead → 409 LEAD_NOT_RESTARTABLE.
   */
  restartSession: (id: string) =>
    request<{ oldSession: SessionView; newSession: SessionView; note: string }>(
      'POST',
      `/sessions/${id}/restart`,
    ),
  /**
   * Soft-delete a terminal session (killed/exited/failed) from the map. If
   * the session is the orchestrator's lead, the whole team is hidden.
   * Returns 204 on success, 409 if the session is not terminal.
   */
  hideSession: (id: string) =>
    request<void>('POST', `/sessions/${id}/hide`),
  /**
   * Soft-delete a terminal orchestrator (stopped/failed). Cascades to hide
   * all its sessions. Returns 204 on success, 409 if not terminal.
   */
  hideOrchestrator: (id: string) =>
    request<void>('POST', `/orchestrators/${id}/hide`),
  /**
   * Phase 3: human → all sessions broadcast (`from: 'human'` mailbox push,
   * idle PTY signal). Body `{ content }`.
   */
  broadcastToOrchestrator: (id: string, content: string) =>
    request<{ delivered_to: string[] }>(
      'POST',
      `/orchestrators/${id}/broadcast`,
      { content },
    ),
  /**
   * Phase 3 (dev/UI): non-destructive peek at a session's mailbox. Used for
   * the inbox-count badge on the OrchestratorView.
   */
  peekInbox: (orchestratorId: string, sessionId: string) =>
    request<{ count: number; messages: MailMessageView[] }>(
      'GET',
      `/orchestrators/${orchestratorId}/sessions/${sessionId}/inbox`,
    ),
  getWsTicket: (sessionId: string) =>
    request<{ ticket: string; ttlMs: number; kind: string; sessionId: string }>(
      'GET',
      `/ws-ticket?session=${encodeURIComponent(sessionId)}`,
    ),
  getEventsTicket: () =>
    request<{ ticket: string; ttlMs: number; kind: string }>('GET', `/ws-ticket?events=1`),
  /**
   * Phase update_system S9 — global + per-orchestrator message-flow ring
   * buffers. Used by `LeftPanel` for the `MESSAGE FLOW` big graph (when
   * `messageFlowSource === 's9-server'`) and for the `PER-TEAM TRAFFIC`
   * sparklines (always).
   */
  getMetricsMessages: () =>
    request<MessagesMetricsSnapshot>('GET', '/metrics/messages'),
  /**
   * Phase update_system S8 — bus health KPIs. Drives the `BUS HEALTH` 4-cell
   * grid in `LeftPanel`. May return 404 on servers built without
   * `BusMetricsCollector`; the consumer hook swallows the error and keeps
   * cells at `—`.
   */
  getMetricsBus: () =>
    request<BusMetricsSnapshot>('GET', '/metrics/bus'),
  /**
   * Per-instance visual settings (theme + label). Singleton on the server.
   * The GET returns hard-coded defaults until the first PATCH seeds the DB
   * row, so the response always parses.
   */
  getInstanceSettings: () =>
    request<{ settings: InstanceSettingsView }>('GET', '/settings'),
  patchInstanceSettings: (patch: InstanceSettingsPatch) =>
    request<{ settings: InstanceSettingsView }>('PATCH', '/settings', patch),
  resetInstanceSettings: () =>
    request<{ settings: InstanceSettingsView }>('POST', '/settings/reset'),
  /**
   * Operator backups. `triggerBackup` forces an online SQLite snapshot now
   * (`ok:false` on failure/overlap); `listBackups` lists existing snapshots
   * newest-first. Both reuse the server-side BackupScheduler.
   */
  triggerBackup: () =>
    request<{ ok: boolean; file: string | null; pruned: number }>('POST', '/backup'),
  listBackups: () =>
    request<{ backups: Array<{ name: string; sizeBytes: number; mtimeMs: number }> }>(
      'GET',
      '/backups',
    ),
  /**
   * Update surface. `getUpdates` is the full authed state (system + plugins +
   * self-update eligibility) and is fetched ON DEMAND when the SETTINGS
   * drawer's SYSTEM UPDATE section opens — never polled. The badge rides the
   * public `/info` poll instead (`InfoView.update`).
   *
   * `dismissUpdate(version)` hides one version; `dismissUpdate(null)`
   * un-hides. Both return the recomputed system state.
   */
  getUpdates: () => request<UpdatesView>('GET', '/updates'),
  dismissUpdate: (version: string | null) =>
    request<{ system: SystemUpdateState }>('POST', '/updates/dismiss', { version }),
  /**
   * Apply / schedule. Every one of these answers **503** when the instance was
   * wired without an apply machine — that is a fact about the build, not a
   * failure, and the UI says so instead of showing a generic error.
   *
   * `apply` answers 202: the run outlives the request and, by design, outlives
   * the server process (the whole point is `docker compose up -d` on the
   * container we are talking to). It is followed through `getUpdateRun`.
   * 409 means a run is already in flight.
   *
   * `graceSeconds` is floored server-side at 120 (`MIN_GRACE_SECONDS`) whenever
   * a team is alive — below that an operator is announcing, not warning.
   */
  applyUpdate: (body: { targetVersion: string; graceSeconds?: number }) =>
    request<{ runId: string; run: UpdateRunDetail | null }>('POST', '/updates/apply', {
      kind: 'system',
      ...body,
    }),
  /**
   * Cut the warning window short. 200 `{applied:true}` once the hard
   * {@link MIN_GRACE_SECONDS} floor has elapsed; **409 while it has not**, with
   * `remainingSeconds` and a message naming the wait — the server refuses
   * rather than queueing the apply, because an operator who asked for "now"
   * has not asked for "in 90 s". 404 names a run the server does not know
   * (and is also what a server predating this route answers).
   */
  applyUpdateNow: (runId?: string) =>
    request<{ applied: boolean; run: UpdateRunDetail | null }>(
      'POST',
      '/updates/apply-now',
      runId === undefined ? {} : { runId },
    ),
  /** One-shot at an ISO datetime (Lot E) — not a cron. */
  scheduleUpdate: (body: { at: string; targetVersion: string; graceSeconds?: number }) =>
    request<{ runId: string; at: string; run: UpdateRunDetail | null }>(
      'POST',
      '/updates/schedule',
      { kind: 'system', ...body },
    ),
  /** 404 when nothing was scheduled. */
  cancelUpdateSchedule: () => request<{ cancelled: boolean }>('DELETE', '/updates/schedule'),
  /**
   * Cancel during the warning window. 409 once the host updater owns the
   * outcome: past that point there is nothing safe to interrupt.
   */
  cancelUpdateRun: (runId?: string) =>
    request<{ cancelled: boolean; run: UpdateRunView | null }>(
      'POST',
      '/updates/cancel',
      runId === undefined ? {} : { runId },
    ),
  getUpdateRun: (id: string) =>
    request<{ run: UpdateRunDetail }>('GET', `/updates/${encodeURIComponent(id)}`),
  /**
   * VS Code web (`code serve-web`) connection details. The editor is
   * reverse-proxied under `basePath` (e.g. `/ide`) on the same origin, so the
   * caller builds a same-origin iframe URL:
   *   `${basePath}/?folder=${folder}&tkn=${token}`
   * 404s when the instance was started with SWARM_OS_IDE_ENABLED=false.
   */
  getIdeInfo: () =>
    request<{ basePath: string; folder: string; token: string }>('GET', '/ide-info'),
  // ---- Shared memory / knowledge graph (docs/memoire-partagee.md §7-8) -----
  //
  // These live under `/api/*` (proxied by vite.config.ts) unlike most routes
  // above. All are authenticated (X-Auth-Token) like the rest of the client.
  // The web view feature-detects: a 404 on `listMemory` means the backend
  // predates this surface and the page renders a graceful empty state.
  /** List note metadata (no bodies). */
  listMemory: () => request<{ notes: MemoryNoteMeta[] }>('GET', '/api/memory'),
  /** Nodes + edges for the graph canvas. */
  getMemoryGraph: () =>
    request<{ nodes: GraphNode[]; edges: GraphEdge[] }>('GET', '/api/memory/graph'),
  /** FTS-ranked search. `type` filters by note type; `limit` caps results. */
  searchMemory: (q: string, opts: { type?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams({ q });
    if (opts.type) qs.set('type', opts.type);
    if (opts.limit != null) qs.set('limit', String(opts.limit));
    return request<{ results: SearchHit[] }>('GET', `/api/memory/search?${qs.toString()}`);
  },
  /** Full note (body + links). 404 when the note does not exist. */
  getMemoryNote: (name: string) =>
    request<MemoryNote>('GET', `/api/memory/${encodeURIComponent(name)}`),
  /**
   * Create or update a note. Returns the stored note (with bumped version).
   * 409 when `expectedVersion` no longer matches (another writer won the race).
   */
  putMemoryNote: (name: string, body: MemoryNoteInput) =>
    request<MemoryNote>('PUT', `/api/memory/${encodeURIComponent(name)}`, body),
  /** Delete a note (lead-only server-side). */
  deleteMemoryNote: (name: string) =>
    request<{ ok: true }>('DELETE', `/api/memory/${encodeURIComponent(name)}`),
};

export { HttpError };

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

/** One skill activation entry on a role. */
export interface SkillActivation {
  name: string;
  mode: 'inject';
}

/**
 * Mirror of the server-side `SkillView` (modules/skills/store.ts).
 * All nullable fields match the DB schema — a server that predates the lot
 * omits the whole skills route; the UI degrades to an empty list.
 */
export interface SkillView {
  name: string;
  version: string;
  displayName: string | null;
  description: string | null;
  /** 'dir' | 'upload' | 'git' | 'npm' | 'market' */
  sourceKind: string;
  sourceRef: string | null;
  /** 'first-party' | 'verified' | 'community' | 'local' */
  trust: string;
  requires: { plugins: string[]; capabilities: string[] };
  assetsPresent: boolean;
  triggers: string[];
  checksum: string | null;
  installedAt: string;
  updatedAt: string;
  lastError: string | null;
  /** Commit SHA or tag captured at import time (Lot 2b). Optional on older servers. */
  sourceCommit?: string | null;
  /** Lot 3b — operator has explicitly reviewed this skill's assets. */
  reviewed?: boolean;
  /** Lot 3b — activation is gated until reviewed (risqué + community/local). */
  reviewRequired?: boolean;
  /** Lot 3b — live install status for each plugin listed in requires.plugins. */
  pluginStatus?: Array<{ name: string; installed: boolean; enabled: boolean }>;
  /** Lot 3b — non-fatal warnings (missing plugin, review required, …). */
  warnings?: string[];
}

/** Lot 3b — full review information returned by GET /skills/:name/review and in 409 bodies. */
export interface SkillReviewInfo {
  name: string;
  version: string;
  trust: string;
  checksum: string | null;
  reviewed: boolean;
  reviewRequired: boolean;
  requires: { plugins: string[]; capabilities: string[] };
  pluginStatus: Array<{ name: string; installed: boolean; enabled: boolean }>;
  warnings: string[];
  assets: Array<{ path: string; size: number; executable: boolean; isText: boolean }>;
}

/** Lot 3b — content of a single asset file fetched via GET /skills/:name/asset?path=. */
export interface SkillAssetContent {
  path: string;
  size: number;
  executable: boolean;
  isText: boolean;
  /** UTF-8 text content, capped at 256 KiB. Empty if binary. */
  content: string;
  truncated: boolean;
  binary: boolean;
}

/** Body of `POST /skills/install` — all sources (Lot 1b dir/upload + Lot 4b git/npm/market). */
export type SkillInstallInput =
  | { source: 'dir'; dir: string }
  | { source: 'git'; url: string; ref?: string; subdir?: string }
  | { source: 'npm'; spec: string }
  | { source: 'market'; ref: string };

/** One entry from `GET /skills/market/search` (Lot 4b). */
export interface MarketSearchEntry {
  name: string;
  description?: string;
  /** Re-injectable as `ref` in `POST /skills/install { source:'market', ref }`. */
  ref?: string;
  /** Lien web vers la source du skill, ex. page GitHub. */
  url?: string;
}

/** Response of `GET /skills/market/search?q=` (Lot 4b). */
export interface MarketSearchResult {
  available: boolean;
  results: MarketSearchEntry[];
  error?: string;
}

/** Response shape for install / upload / upgrade. */
export interface SkillInstallResult {
  skill: SkillView;
  /** Lot 3b — only present on upgrade responses. */
  drift?: {
    checksumChanged: boolean;
    previousChecksum: string | null;
    previousBody: string | null;
  };
}

/** Response of POST /skills/pack/install (Lot 5b). */
export interface PackInstallResponse {
  installed: SkillView[];
  errors: { name: string; error: string }[];
}

/** One scope-level activation row returned by GET /skills/:name/activations (Lot 2b). */
export interface SkillScopeActivation {
  scope: 'orch' | 'session';
  scopeId: string;
  /** 1 = explicitly active; 0 = negative override (explicitly deactivated). */
  enabled: number;
}

/** Body for POST /skills/:name/activate and /deactivate (Lot 2b). */
export interface SkillActivateBody {
  scope?: 'role' | 'orch' | 'session';
  orchestratorId: string;
  sessionId?: string;
  /** Lot 3b — pass true to register a review and activate in one call (409 gate bypass). */
  reviewed?: boolean;
}

/** Response of POST /skills/:name/activate|deactivate (Lot 2b). */
export interface SkillActivateResult {
  name: string;
  scope: string;
  found: boolean;
  persisted: boolean;
  injected: boolean;
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
  /**
   * How many crons target this role (docs/crons-agents.md). READ-ONLY: computed
   * by `GET /roles` and ignored on write — the cadence itself lives in the
   * `crons` collection, not on the role. Optional so fixtures and older servers
   * that never sent the field keep type-checking; absent reads as 0.
   */
  cronCount?: number;
  /**
   * Approval gate (docs/garde-fous-approbation.md, P5) — OPTIONAL per-role
   * override of the human-in-the-loop guard. `null`/absent = no override: the
   * role uses the built-in default arming and Discord notification ON. Optional
   * so older servers that never sent the field keep type-checking.
   */
  approval?: RoleApprovalSettings | null;
  /** Skills activated for this role (Lot 1b). Optional: older servers omit it. */
  skills?: SkillActivation[];
  /**
   * Dead-worker reaper toggle: when `true`, the server soft-removes terminal
   * workers (killed/exited/failed) of this role's teams after
   * `autoRemoveDeadWorkersDelayMs`. Optional so older servers that never sent
   * the field keep type-checking; treat absent as `false`.
   */
  autoRemoveDeadWorkers?: boolean;
  /** Grace period (ms) before a dead worker is removed. Default 600000 (10 min). */
  autoRemoveDeadWorkersDelayMs?: number;
  /**
   * Cost budget (docs/monitoring-agents.md, Lot 14) — the ceiling, in USD, on
   * the CUMULATIVE spend of one team of this role, removed workers included.
   * `null` (or absent, on a server predating Lot 14) = no budget at all, which
   * is deliberately distinct from `0` ("stop this role from spending anything").
   */
  costBudgetUsd?: number | null;
  /** What the server does at the crossing. Absent = `notify`. */
  budgetAction?: BudgetAction;
  /**
   * Auto-compact threshold (docs/auto-compact.md, §3.3) — the share of its
   * context window an agent of this role may fill before the server arms
   * `/compact` at its next idle boundary (empty inbox, never mid-turn).
   *
   *   - `null` (or absent, on a server predating the feature) = INHERIT the
   *     instance default, carried by `GET /roles` as `defaults.autoCompactPct`;
   *   - `0` = disabled for this role — deliberately distinct from `null`;
   *   - `1..100` = the threshold, in percent, as an INTEGER (the server
   *     answers 400 on `3.5` and on the string `"35"`).
   *
   * Applies to the team's LEAD only since v0.10.1 — workers have their own
   * field below.
   */
  autoCompactPct?: number | null;
  /**
   * Auto-compact threshold for the team's WORKERS (docs/auto-compact.md §8.2,
   * v0.10.1) — same three states as `autoCompactPct`, but the instance value a
   * `null` inherits is `defaults.workerAutoCompactPct`, which is `0` (= OFF)
   * unless the operator set `SWARM_OS_WORKER_AUTO_COMPACT_PCT`: workers run
   * short, linear tasks and are reset by their lead, not by a threshold.
   * Absent on a server predating v0.10.1 — read as "inherit".
   */
  workerAutoCompactPct?: number | null;
  /**
   * Tool lists per role. Four independent overrides, each read at the NEXT
   * launch of a session (a new worker, or the lead on its next restart or
   * resume), never hot-applied:
   *
   *   - `leadTools` / `workerTools`: Claude Code BUILT-IN tools allowed to the
   *     team's lead / workers (`["Bash","Read","Edit","Write"]`), passed to the
   *     CLI as `--tools`;
   *   - `leadMcpTools` / `workerMcpTools`: team-comms (swarm-os MCP) tools
   *     exposed to the lead / workers, by their canonical dotted names
   *     (`team.send_message`, `memory.search`, `board.list`,
   *     `discord-agent.reply`). The server always keeps the essentials
   *     (`team.whoami`, `team.list`, `team.send_message`, `team.read_inbox`,
   *     `team.context_compact`, `team.context_clear`) and always hides
   *     lead-only tools from workers, whatever the list says.
   *
   * `null` (or absent, on a server predating the feature) = ALL tools, today's
   * behaviour. On write, `null` clears the override and a NON-EMPTY array of
   * non-empty strings sets it; an empty array is a 400 — which is why the form
   * never sends one (`lib/toolList.ts` turns an empty field into `null`).
   */
  leadTools?: string[] | null;
  workerTools?: string[] | null;
  leadMcpTools?: string[] | null;
  workerMcpTools?: string[] | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * What happens when a team crosses its role's `costBudgetUsd`:
 *
 *   - `notify` — an event (toast + Discord when a webhook is configured) and
 *     nothing else. The team keeps running.
 *   - `pause` — SIGSTOP on the WHOLE team, lead included; resuming is a manual
 *     operator gesture.
 *
 * Absent = `notify`, which is why every read site defaults to it: a missing
 * field must never be read as "this team may be paused".
 */
export type BudgetAction = 'notify' | 'pause';

/**
 * Per-role approval override. Every field is independently optional; an absent
 * field inherits the default (default arming, Discord ON). Mirrors the server's
 * `RoleApprovalSettings`.
 */
export interface RoleApprovalSettings {
  /** Master switch. `false` = the guard never arms for this role. */
  enabled?: boolean;
  /**
   * Explicit allowlist of permission modes that ARM the guard, overriding the
   * default. `undefined` = inherit the default arming set.
   */
  armingModes?: string[];
  /** Whether the Discord approval embed is posted. `undefined`/`true` = ON. */
  discordNotify?: boolean;
}

export type RoleInput = Omit<RoleView, 'id' | 'createdAt' | 'updatedAt'>;

// ---- Agent crons (docs/crons-agents.md) ------------------------------------
// Wire mirror of `modules/crons/store.ts` + the `view()` enrichment of
// `http/routes/crons.ts`. Nothing here is inferred: every field name below
// exists verbatim in one of those two files.

/** What a tick does: deliver a template, or run a local script that decides. */
export type CronAction = 'message' | 'script';

/** Why a run happened: the cadence fired, or an operator pressed RUN NOW. */
export type CronRunKind = 'tick' | 'manual';

/** How a run ended (`overlap` = the previous run was still in flight). */
export type CronRunOutcome = 'wake' | 'skip' | 'noop' | 'overlap' | 'error';

/** Interpreters a script cron may declare. No `+x` fallback, server-side. */
export const CRON_INTERPRETERS = ['python3', 'bash', 'node'] as const;

/** One row of a cron's bounded history (20 kept per cron, server-side). */
export interface CronRunView {
  id: string;
  cronId: string;
  firedAt: string;
  kind: CronRunKind;
  outcome: CronRunOutcome;
  /** action=script only. */
  exitCode: number | null;
  durationMs: number | null;
  /** Truncated stdout/stderr, or the reason of an `error` outcome. */
  outputExcerpt: string | null;
  /** Orchestrator ids the message reached. */
  deliveredTo: string[];
}

export interface CronView {
  id: string;
  /** Display slug, UNIQUE — also the `cron:<name>` sender of its messages. */
  name: string;
  /** Target role. A deleted role leaves an ORPHAN cron, not a cascade. */
  roleId: string;
  /** 5-field cron expression, evaluated in the server's schedule timezone. */
  schedule: string;
  action: CronAction;
  message: string | null;
  scriptPath: string | null;
  scriptArgs: string[] | null;
  interpreter: string | null;
  /** `null` = the server default budget. */
  timeoutMs: number | null;
  paused: boolean;
  createdAt: string;
  updatedAt: string;
  /**
   * Read off the ARMED croner job, never recomputed client-side (a local
   * `new Cron(expr)` would evaluate in the browser's timezone, not the
   * server's). `null` when the cron is paused or cadence is disabled
   * instance-wide — the UI must never advertise a fire that will not happen.
   */
  nextRun: string | null;
  lastRun: CronRunView | null;
  /** A run is in flight right now — a manual fire would answer 409. */
  running: boolean;
}

/** Body of `POST /crons`. `PATCH` takes a `Partial<CronInput>`. */
export interface CronInput {
  name: string;
  roleId: string;
  schedule: string;
  action: CronAction;
  message?: string | null;
  scriptPath?: string | null;
  scriptArgs?: string[] | null;
  interpreter?: string | null;
  timeoutMs?: number | null;
  paused?: boolean;
}

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

/**
 * ── Built-in features (docs/builtin-features.md) ──────────────────────────
 * The six core surfaces that became enable/disable/uninstall-able like plugins
 * (their code stays compiled in — only the lifecycle is steerable). Wire mirror
 * of the server's `FeatureView` (`modules/features/registry.ts`). `/features`
 * lives BEHIND the auth gate on purpose (D10): `/info` is public and must not
 * leak which surfaces an instance runs.
 */
export type FeatureName =
  | 'ide' | 'codegraph' | 'board' | 'memory' | 'monitoring' | 'approvals';

/**
 * `uninstalled` = `disabled` + data purged. `enable` on `uninstalled` is the
 * documented install+enable (idempotent, the built-in tables are recreated
 * with `CREATE TABLE IF NOT EXISTS`).
 */
export type FeatureState = 'enabled' | 'disabled' | 'uninstalled';

export interface FeatureView {
  name: FeatureName;
  displayName: string;
  description: string;
  state: FeatureState;
  updatedAt: string;
}

/**
 * Per-session context-window usage — mirror of the server-side
 * `ContextUsageView` (`modules/orchestrator/session.ts`). See
 * `docs/monitoring-agents.md` § "Forme du champ".
 *
 * Present ONLY for a provider whose usage we can actually read (claude via
 * the `SessionStart` hook + transcript tail; codex/opencode best-effort;
 * gemini never) AND only while the session is `running | waiting` — nothing
 * is serialised for a terminated session. Every consumer must therefore
 * treat the whole object as optional and render `—`, never a guess
 * (`lib/contextPercent.ts`).
 */
export interface ContextUsageView {
  /**
   * Tokens in the live context. `null` ONLY while `awaitingCall` is set — the
   * context was reset and no call has been read since; render the reset state,
   * never an old figure.
   */
  usedTokens: number | null;
  /**
   * Model context window. `null` when the model is absent both from the
   * models.dev catalogue and from the pinned per-model fallbacks — in which
   * case `pct` is null too, but `usedTokens` is still a real measurement.
   */
  limitTokens: number | null;
  /** `min(1, used/limit)` — computed server-side. `null` iff `limitTokens` is. */
  pct: number | null;
  basis: 'transcript' | 'control-plane' | 'estimated';
  /** ISO timestamp of the snapshot. */
  updatedAt: string;
  /**
   * The snapshot may be outdated — typically right after a `/clear`, until
   * the agent's next turn is read back. NOT a missing value: keep showing
   * the number, muted, with a STALE tag.
   */
  stale: boolean;
  /**
   * v0.10.3 — the context was just reset (`compact` / `clear`) and no API call
   * has been read since: `usedTokens` and `pct` are `null`. Render
   * `contextResetTag()` instead of a figure. Absent otherwise.
   */
  awaitingCall?: 'compact' | 'clear';
}

/**
 * The four CUMULATIVE token counters, without the pricing that usually rides
 * along. Split out of `TokenUsageView` at Lot 12 because the per-session
 * ventilation of `GET /orchestrators/:id/cost` carries its `costUsd` NEXT to
 * the counters rather than inside them — one shape, so a bucket renamed on
 * the wire breaks both call sites at once instead of drifting silently.
 */
export interface TokenCounters {
  /** Input tokens billed at full price — cache reads NOT included. */
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Mirror of the server's `TokenUsageView` (`modules/orchestrator/session.ts`).
 * See `docs/monitoring-agents.md` § Lot 11.
 *
 * The counters are CUMULATIVE for the life of the agent — they survive a
 * `/compact` or `/clear` (unlike `ContextUsageView`, which measures what is
 * in the window right now) and keep accumulating across the session
 * rotations those commands cause under codex and opencode.
 *
 * Absent for a provider with no readable spend (gemini), for a backend
 * predating Lot 11, and for a session that has not produced a single turn
 * yet. Consumers render `—`, never a zero (`lib/tokenCost.ts`).
 */
export interface TokenUsageView extends TokenCounters {
  /**
   * Catalogue list prices applied to the four counters, or `null` when the
   * model's input AND output prices are both unknown. A single bucket
   * without a known price contributes 0 rather than inventing a rate, so a
   * non-null amount is always a LOWER bound on the truth.
   */
  costUsd: number | null;
  /**
   * Where the amount comes from (Lot 13).
   *
   * - `'estimated'` — catalogue list prices applied to the counters we read.
   *   Every provider today, and the fallback whenever a CLI reports nothing.
   * - `'reported'` — the amount the provider's own CLI put on the wire
   *   (opencode carries a `cost` per message). It supersedes the estimate
   *   rather than sitting next to it: two amounts for one agent on one screen
   *   is a support ticket.
   *
   * The UI never hides the difference — the TOKENS · COST cell suffixes the
   * amount `EST` or `RPT` (`lib/tokenCost.ts`). A backend predating Lot 13
   * only ever sends `'estimated'`, so nothing has to be back-filled.
   */
  costBasis: 'estimated' | 'reported';
}

/**
 * Provider-level rate-limit budget attached to a session (Lot 13).
 *
 * This is an ACCOUNT quota, not an agent one: codex reports `rate_limits`
 * (used_percent / resets_at / plan) on the `token_count` line, and every codex
 * agent on this instance draws from the same bucket. The UI says so out loud
 * (the sidebar chip's `title`) because a per-agent reading of `62% USED` would
 * suggest starting a second agent to spread the load, which is exactly wrong.
 *
 * Present only on codex sessions, and only once the CLI has reported it.
 * Every field is independently nullable — a plan-less account still reports a
 * percentage, and the reset time can be missing from an older CLI.
 */
export interface ProviderQuotaView {
  /** Consumed share of the account's window, 0-100. */
  usedPercent: number | null;
  /** ISO timestamp at which the window rolls over. */
  resetsAt: string | null;
  /** Plan name as the provider spells it (`pro`, `plus`, …). */
  plan: string | null;
}

/**
 * Time windows offered by `GET /sessions/:id/context-history` — the server
 * rejects anything else with a 400, so the union is the contract, not a hint.
 */
export type ContextHistoryWindow = '1h' | '24h' | '3d';

/**
 * One time bucket of the context-usage history (Lot 9). `min`/`max`/`last`
 * are **token counts**, not percentages: the server bucketises raw samples
 * and keeps the three extremes so a `/compact` drop inside a bucket can never
 * be smoothed away by an average.
 */
export interface ContextHistoryPoint {
  /** ISO timestamp of the bucket (its last sample). */
  t: string;
  min: number;
  max: number;
  last: number;
}

/** A context reset that actually FIRED (never a merely armed one). */
export interface ContextHistoryReset {
  t: string;
  cmd: 'compact' | 'clear';
}

/**
 * `GET /sessions/:id/context-history?window=1h|24h|3d` (Lot 9).
 *
 * In-memory, three sliding days, wiped by a server restart — which is why
 * the band that renders it says so. Both arrays are empty (200, not 404)
 * for a live session that has no history yet, so "empty" is a normal state
 * to render, never an error.
 */
export interface ContextHistoryView {
  /**
   * Model context window, or `null` when unknown — in which case the chart
   * has no percentage to plot and falls back to a raw-token Y axis with no
   * threshold lines (a 70% line on an unknown window would be invented).
   */
  limitTokens: number | null;
  points: ContextHistoryPoint[];
  resets: ContextHistoryReset[];
}

// ── Per-call ledger (`session_calls`) ────────────────────────────────────────

/** Windows of the per-call endpoints — the server 400s anything else. */
export type CallWindow = '1h' | '24h' | '3d' | '14d';

/** Bucket sizes of the team / fleet series — the server 400s anything else. */
export type CallBucket = '5m' | 'hour' | 'day';

/** The four token buckets of a call (or of a sum of calls). */
export interface CallTokens {
  /** Fresh input tokens — the cache misses. */
  input: number;
  /** Tokens written to the prompt cache. */
  cacheWrite: number;
  /** Tokens read from the prompt cache. */
  cacheRead: number;
  output: number;
}

/**
 * One bar of an agent's call chart: ONE call (`n === 1`), or — when the
 * window holds more than ~600 — every call of a time bucket (`n > 1`, token
 * buckets are SUMS, `context` is the bucket's LARGEST context).
 */
export interface CallPoint extends CallTokens {
  /** ISO — the call's own time, or the start of its bucket. */
  t: string;
  n: number;
  /** `null` when unknown or when a bucket mixed several models. */
  model: string | null;
  /** Context sent: input + cache write + cache read. */
  context: number;
  /** Single calls only — a sub-agent's call. */
  sidechain?: boolean;
}

/** `GET /sessions/:id/calls?window=…` — persisted 14 days, claude only. */
export interface SessionCallsView {
  window: CallWindow;
  since: string;
  until: string;
  aggregated: boolean;
  bucketMs: number | null;
  calls: CallPoint[];
  /** Calls per hour — hours with at least one call only. */
  hourly: { t: string; calls: number }[];
  totals: CallTokens & { calls: number; maxContext: number };
}

export interface CallSeriesPoint extends CallTokens {
  t: string;
  calls: number;
}

export interface CallUsageTeam extends CallTokens {
  orchestratorId: string;
  name: string | null;
  calls: number;
}

/**
 * `GET /orchestrators/:id/call-usage` and `GET /metrics/call-usage` — calls
 * and tokens per bucket, lead and workers apart. `lead`/`workers` are DENSE
 * (every bucket of the window, zeros included) and index-aligned. `teams` is
 * present on the fleet variant only.
 */
export interface CallUsageView {
  window: CallWindow;
  bucket: CallBucket;
  bucketMs: number;
  since: string;
  until: string;
  lead: CallSeriesPoint[];
  workers: CallSeriesPoint[];
  totals: {
    lead: CallTokens & { calls: number };
    workers: CallTokens & { calls: number };
  };
  teams?: CallUsageTeam[];
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
  // ── Monitoring (docs/monitoring-agents.md, Lots 1-3) ───────────────────
  // All four are ADDITIVE and optional: a backend predating the feature
  // omits them, and Lot 2 (the context tracker) can land after Lot 1. The UI
  // contract is "absent → `—`", never a synthesised value.
  /**
   * Messages currently queued in this session's mailbox (`mailbox.size(sid)`,
   * decorated in `Orchestrator.toView()`). Replaces the per-session
   * `peekInbox` N+1 poll the web client used to run every 3 s.
   */
  inboxCount?: number;
  /** Monotone count of mailbox messages actually drained by this session. */
  messagesProcessed?: number;
  /**
   * A `compact`/`clear` has been armed and will fire at the session's next
   * idle (never mid-turn). Falls back to `false` once fired.
   */
  contextResetPending?: boolean;
  /** Context-window usage, or `null`/absent when unmeasurable. */
  contextUsage?: ContextUsageView | null;
  /**
   * Lot 9 — the last ~20 context-usage readings as whole percents (0-100),
   * oldest first. Rides on the 3 s `/orchestrators` poll, so the MONITORING
   * table gets a trend column for free; absent for a session with no
   * telemetry, no known limit, or a backend predating Lot 9 (→ the cell
   * renders `—`, never a flat line at zero).
   */
  contextSpark?: number[];
  /**
   * Lot 11 — cumulative token spend + its estimated cost. Additive and
   * optional like every field above it: absent for gemini, for a backend
   * predating the feature, and for a session that has produced nothing yet.
   */
  tokenUsage?: TokenUsageView | null;
  /**
   * Lot 13 — the provider ACCOUNT quota this agent draws from, or absent when
   * the provider reports none (everything but codex today) and on a backend
   * predating Lot 13. Deliberately carried per session even though it
   * describes the account: it arrives on a session's own CLI output, and the
   * page de-duplicates identical readings rather than guessing which session
   * speaks for the account.
   */
  providerQuota?: ProviderQuotaView | null;
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
  /** GitHub's API rate limit is spent; `error` says until when. */
  | 'rate_limited'
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
 * Monitoring Lot 10 — snapshot returned by `GET /metrics/system`
 * (docs/monitoring-agents.md § Lot 10). Container-level CPU and memory read
 * from the deployment's OWN cgroup files — no Docker socket, so the numbers
 * cover every process in the container, agent CLIs included.
 *
 * EVERY field is nullable and that is the contract, not sloppiness: cgroup
 * files can be unreadable, and the CPU sampler needs two `cpu.stat` reads to
 * produce a delta, so the first call after a boot legitimately has no
 * percentage. The whole endpoint may also 404 on a server predating Lot 10.
 * Callers render `—`; nothing here is ever defaulted to zero.
 *
 * `basis: 'host'` means the denominator came from the host (`os.totalmem()` /
 * `os.cpus().length`) because the cgroup limit was `max` (unlimited). The
 * reading is still true, but it is a share of the MACHINE, not of a quota —
 * the UI tags it `HOST BASIS` so an operator does not read it as a container
 * limit they can raise.
 */
export interface SystemMetricsSnapshot {
  cpu: {
    /** Fraction of the available cores in use, `0..1`, or `null`. */
    pct: number | null;
    /** Cores the fraction is measured against (cgroup quota, else host). */
    cores: number | null;
    basis: 'cgroup' | 'host' | null;
  };
  memory: {
    usedBytes: number | null;
    limitBytes: number | null;
    /** `usedBytes / limitBytes`, `0..1`, or `null`. */
    pct: number | null;
    basis: 'cgroup' | 'host' | null;
  };
}

/**
 * ── Team cost DTOs (Lot 12, docs/monitoring-agents.md) ────────────────────
 *
 * The one place in this client where the numbers do NOT come from the
 * `/orchestrators` snapshot: a team's true spend includes the workers that
 * are no longer in it. Killed and removed sessions keep their row (and their
 * Lot 11 counters) in the DB, so the server aggregates in SQL over hidden
 * rows included — which is exactly why an in-memory sum over `SessionView[]`
 * could never produce this figure, and why the section says `DB TOTALS`.
 */
export interface TeamCostTotals extends TokenCounters {
  /**
   * Priced spend for the whole team, live and removed agents together, or
   * `null` when NOTHING under it could be priced. A non-null amount is always
   * a lower bound: an unpriced model contributes 0 rather than a guess.
   */
  costUsd: number | null;
}

/** One team's line in `GET /metrics/costs`. */
export interface TeamCostRow {
  orchId: string;
  name: string;
  /** Agents still in the team — the denominator the operator sees as `N LIVE`. */
  live: number;
  total: TeamCostTotals;
  removed: {
    /** How many sessions left the team (killed, reaped, removed by hand). */
    count: number;
    /**
     * Their share of the total, or `null` when they exist but carry no
     * counters — sessions that ran before Lot 11 have no numbers to recover,
     * and a `$0.00` there would read as "those workers were free".
     */
    costUsd: number | null;
  };
  /**
   * USD per hour over the trailing hour, from the tracker's cumulative-cost
   * ring — `null` with fewer than two points (a team younger than the ring,
   * or a server restarted since). Live sessions only: a removed worker's
   * spend is in `total`, but it is not burning anything any more.
   */
  burnPerHour: number | null;
  /**
   * Lot 14 — the budget of the ROLE this team was spawned from, resolved
   * against `total.costUsd` server-side. `null` (or absent, on a server
   * predating Lot 14) = this team has no budget, which is NOT the same as a
   * budget it has not reached: `exceeded: false` is a measured verdict, an
   * absent `budget` is no verdict at all.
   */
  budget?: TeamBudgetView | null;
}

/** The budget half of a `TeamCostRow` — the ceiling and where the team is against it. */
export interface TeamBudgetView {
  /** The ceiling, in USD. */
  usd: number;
  action: BudgetAction;
  /** `true` once `total.costUsd` has crossed `usd`. */
  exceeded: boolean;
}

/** `GET /metrics/costs`. Ordering is NOT contractual — the client sorts. */
export interface TeamCostsSnapshot {
  teams: TeamCostRow[];
}

/** One session's line in `GET /orchestrators/:id/cost`. */
export interface SessionCostRow {
  id: string;
  name: string;
  type: 'lead' | 'worker';
  /** Free-form session status (`running`, `killed`, `stopped`, …). */
  status: string;
  /** `true` once the session left the team — the rows the detail view shows. */
  removed: boolean;
  /** `null` for a session that predates the Lot 11 counters. */
  tokens: TokenCounters | null;
  costUsd: number | null;
}

/**
 * `GET /orchestrators/:id/cost` — per-session ventilation behind an expanded
 * team row. Fetched ON DEMAND (never polled): it is a drill-down, and the
 * numbers in it only move for the sessions that are still alive.
 */
export interface OrchestratorCostView {
  sessions: SessionCostRow[];
}

/**
 * Monitoring Lot 15 — the two wire formats of `GET /metrics/costs/export`.
 *
 * `csv` is the one an operator opens in a spreadsheet (header row
 * `day,orchestrator_id,team,session_id,agent,tokens_in,tokens_out,cache_read,
 * cache_write,cost_usd`), `json` the one a script consumes
 * (`{days, rows: [...]}`). Both come back as TEXT — see `api.exportCosts`.
 */
export type CostExportFormat = 'csv' | 'json';

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

/** A directed out-edge with its relation label (`links` = plain wikilink). */
export interface MemoryOutEdge {
  to: string;
  relation: string;
}

/** A directed in-edge (back-link) with its relation label. */
export interface MemoryInEdge {
  from: string;
  relation: string;
}

/** A full note — `GET /api/memory/:name`. */
export interface MemoryNote extends MemoryNoteMeta {
  /** Markdown body (below the frontmatter). */
  body: string;
  /** Names this note links out to (derived from `[[links]]`). */
  outLinks: string[];
  /** Names that link into this note (back-links). */
  inLinks: string[];
  /** Typed out-edges: one per (target, relation). Mirrors the server DTO. */
  outEdges: MemoryOutEdge[];
  /** Typed in-edges (back-links): one per (source, relation). */
  inEdges: MemoryInEdge[];
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

/** Search engine for `GET /api/memory/search?mode=`. */
export type MemorySearchMode = 'text' | 'semantic' | 'hybrid';

/** One hit of `GET /api/memory/search`. */
export interface SearchHit {
  name: string;
  description: string;
  type: MemoryNoteType;
  snippet: string;
  score: number;
  /**
   * Phase 5 — which engine surfaced this hit. Optional on the wire: a server
   * that predates semantic search omits it, and the UI treats absent as `fts`.
   */
  via?: 'fts' | 'semantic';
}

/**
 * `GET /api/memory/capabilities` — mirror of the server's `EmbeddingCapabilities`
 * (`modules/memory/embeddings.ts`). Lets the UI decide whether to offer the
 * semantic / hybrid toggle, and label it honestly when it is the degraded local
 * fallback. Absent endpoint (404) is treated by the caller as "no semantic".
 */
export interface MemoryCapabilities {
  /** Is semantic search usable at all (provider !== 'none')? */
  semantic: boolean;
  /** True when backed by the local hash fallback — a real ranking, not model meaning. */
  degraded: boolean;
  /** Active provider kind (`hash` | `api` | `none`). */
  provider: string;
  /** Model identifier behind the vectors. */
  model: string;
  /** Vector dimension (0 when disabled). */
  dim: number;
}

/** Body of `PUT /api/memory/:name`. */
export interface MemoryNoteInput {
  description: string;
  type: MemoryNoteType;
  body: string;
  /** Optimistic lock — the version the client last read. Omit to force. */
  expectedVersion?: number;
}

// ── Taskboard / Kanban DTOs ──────────────────────────────────────────────────
// Hand-maintained mirror of server's `TaskboardStore` types. The web cannot
// import the server package, so these are kept in sync manually with
// `packages/server/src/modules/taskboard/store.ts`.

export type BoardStatus = 'todo' | 'doing' | 'blocked' | 'review' | 'done';

export type BoardEventKind =
  | 'created'
  | 'updated'
  | 'moved'
  | 'assigned'
  | 'dep_added'
  | 'dep_removed'
  | 'comment'
  | 'closed'
  | 'reopened'
  | 'deleted'
  | 'orphaned';

/** One card in the board — mirrors `TaskboardCard`. */
export interface BoardCard {
  id: string;
  orchestratorId: string;
  title: string;
  body: string;
  status: BoardStatus;
  assigneeSessionId: string | null;
  priority: number;
  labels: string[];
  orderKey: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  version: number;
  closedAt: number | null;
  orphanedAt: number | null;
  autoCreated: boolean;
  hiddenAt: number | null;
  /**
   * Monitoring Lot 16 — what this card cost while it was in `doing`, in USD:
   * the delta of its assignee's cumulative spend between the move IN and the
   * move OUT of that column.
   *
   * OPTIONAL and nullable, and the two absences mean different things to the
   * server but the same thing to the UI — nothing is rendered:
   *  - `undefined`: a backend predating Lot 16 (the field is not on the wire);
   *  - `null`: the server declined to attribute one (assignee changed mid-card,
   *    the session carries no counters, the card never passed through `doing`).
   *
   * A missing cost is the NORM, not an anomaly — hence no `—` placeholder on
   * the cards, unlike every other "no signal" cell in this app: forty cards
   * each carrying an em-dash would be forty times the noise for zero signal.
   */
  costUsd?: number | null;
}

/** One audit-journal entry — mirrors `TaskboardEvent`. */
export interface BoardAuditEvent {
  id: string;
  cardId: string;
  orchestratorId: string;
  actorSessionId: string | null;
  kind: BoardEventKind;
  data: Record<string, unknown> | null;
  ts: number;
}

/** Card detail with deps + audit journal — mirrors `TaskboardCardDetail`. */
export interface BoardCardDetail extends BoardCard {
  dependsOn: string[];
  blocks: string[];
  events: BoardAuditEvent[];
}

/** Team selector entry — mirrors `TaskboardTeam`. */
export interface BoardTeam {
  orchestratorId: string;
  total: number;
  open: number;
}

// ── Approval-gate DTOs (P3) ──────────────────────────────────────────────────
// Hand-maintained mirror of the server's `ApprovalStore` types
// (`packages/server/src/modules/approvals/store.ts`). Consumed by the P3
// actionable toast; response routing from Discord is P4.

export type ApprovalCategory = 'permission' | 'question';

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'answered_in_console';

/** One approval request — mirrors the server's `ApprovalRequest`. */
export interface ApprovalRequest {
  id: string;
  orchestratorId: string;
  sessionId: string;
  category: ApprovalCategory;
  requestedSummary: string;
  rawMessage: string;
  permissionMode: string;
  provider: string;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number | null;
  resolvedAt: number | null;
  resolvedBy: string | null;
  decision: string | null;
}

/** Compact list item — the list endpoint returns the same rows as the detail. */
export type ApprovalListItem = ApprovalRequest;

/** One audit-journal entry of an approval — mirrors the server's `ApprovalEvent`. */
export interface ApprovalAuditEvent {
  id: string;
  approvalId: string;
  orchestratorId: string;
  sessionId: string;
  kind: string;
  data: Record<string, unknown> | null;
  ts: number;
}

/** Detail with the tail of its audit journal — `GET /api/approvals/:id`. */
export interface ApprovalDetail extends ApprovalRequest {
  events: ApprovalAuditEvent[];
}

/** Body of `POST /api/approvals/:id/resolve`. */
export interface ResolveApprovalBody {
  decision: 'approve' | 'deny';
  dontAskAgain?: boolean;
  by?: string;
}

/** Response of `POST /api/approvals/:id/resolve`. */
export interface ResolveApprovalResult {
  ok: boolean;
  delivered: boolean;
  keystroke?: string | null;
  reason?: string;
  decision: string;
  dontAskAgain?: boolean;
  status: ApprovalStatus;
  request: ApprovalRequest;
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
 *
 * TWO server conventions exist and both must survive this function:
 *   - `{ error: <written reason>, code: <CODE> }` — orchestrator/provider routes;
 *   - `{ error: <CODE>, message: <written reason> }` — the session routes,
 *     including `POST /sessions/:id/context-reset` (`sendActionError` in
 *     `http/routes/sessions.ts`).
 * Reading only `error` + `code` covers the first and silently truncates the
 * second to a bare `PROVIDER_NO_RESET`, which names the failure without ever
 * saying what to do about it. So `message` is appended too, when it adds
 * something the head does not already say.
 */
export function apiErrorMessage(err: unknown): string {
  if (err instanceof HttpError) {
    const body = err.body as
      | {
          error?: string; code?: string; message?: string;
          unavailableReason?: string | null; known?: string[];
        }
      | undefined;
    const head = body?.error ?? err.message;
    const parts = [body?.code ? `${body.code}: ${head}` : head];
    if (body?.message && body.message !== head) parts.push(body.message);
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
  /**
   * `defaults` carries the INSTANCE value a role inherits when its own field
   * is `null` (`autoCompactPct`, docs/auto-compact.md §3.3, and since v0.10.1
   * `workerAutoCompactPct`, §8.2). Optional on purpose — a server predating the
   * feature sends `{ roles }` alone, and so do the fixtures that mock this
   * call; `workerAutoCompactPct` is optional inside it for a v0.10.0 server.
   */
  listRoles: () =>
    request<{
      roles: RoleView[];
      defaults?: { autoCompactPct: number; workerAutoCompactPct?: number };
    }>('GET', '/roles'),
  getRole: (id: string) => request<{ role: RoleView }>('GET', `/roles/${id}`),
  createRole: (body: Partial<RoleInput> & { label: string }) =>
    request<{ role: RoleView }>('POST', '/roles', body),
  updateRole: (id: string, body: Partial<RoleInput>) =>
    request<{ role: RoleView }>('PATCH', `/roles/${id}`, body),
  deleteRole: (id: string) => request<void>('DELETE', `/roles/${id}`),

  // ---- Agent crons (docs/crons-agents.md §2.3) ------------------------------
  // `schedulingEnabled` is a GLOBAL flag carried by the list response (not a
  // per-cron field): when false nothing is armed and every `nextRun` is null.
  listCrons: () =>
    request<{ crons: CronView[]; schedulingEnabled: boolean }>('GET', '/crons'),
  createCron: (body: CronInput) => request<{ cron: CronView }>('POST', '/crons', body),
  getCron: (id: string) =>
    request<{ cron: CronView }>('GET', `/crons/${encodeURIComponent(id)}`),
  updateCron: (id: string, body: Partial<CronInput>) =>
    request<{ cron: CronView }>('PATCH', `/crons/${encodeURIComponent(id)}`, body),
  deleteCron: (id: string) => request<void>('DELETE', `/crons/${encodeURIComponent(id)}`),
  /** Manual fire: 202 + the pre-allocated run id, never synchronous. 409 if in
   *  flight. `run` is the recorded row for a message cron (delivery is
   *  synchronous) and `null` for a script cron, whose row lands only when the
   *  child process settles — poll `listCronRuns` for it. */
  fireCron: (id: string) =>
    request<{ runId: string; run: CronRunView | null }>(
      'POST',
      `/crons/${encodeURIComponent(id)}/fire`,
    ),
  listCronRuns: (id: string) =>
    request<{ runs: CronRunView[] }>('GET', `/crons/${encodeURIComponent(id)}/runs`),

  // ---- Skills (Lot 1b) -------------------------------------------------------
  listSkills: () => request<{ skills: SkillView[] }>('GET', '/skills'),
  getSkill: (name: string) => request<{ skill: SkillView; body: string }>('GET', `/skills/${name}`),
  installSkill: (source: SkillInstallInput) =>
    request<SkillInstallResult>('POST', '/skills/install', source),
  /** Upload a `.tgz` (npm pack format) — RAW body, NOT JSON. Max 25 MB. */
  uploadSkill: async (file: File | Blob, name?: string): Promise<SkillInstallResult> => {
    const qs = name ? `?name=${encodeURIComponent(name)}` : '';
    const res = await fetch(`/skills/upload${qs}`, {
      method: 'POST',
      headers: { 'X-Auth-Token': getToken(), 'Content-Type': 'application/gzip' },
      body: file,
    });
    const ct = res.headers.get('content-type') ?? '';
    const parsed: unknown = ct.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) {
      throw new HttpError(`HTTP ${res.status} POST /skills/upload`, res.status, parsed);
    }
    return parsed as SkillInstallResult;
  },
  upgradeSkill: (name: string) =>
    request<SkillInstallResult>('POST', `/skills/${name}/upgrade`),
  deleteSkill: (name: string) => request<void>('DELETE', `/skills/${name}`),
  activateSkill: (name: string, body: SkillActivateBody) =>
    request<SkillActivateResult>('POST', `/skills/${name}/activate`, body),
  deactivateSkill: (name: string, body: SkillActivateBody) =>
    request<SkillActivateResult>('POST', `/skills/${name}/deactivate`, body),
  getSkillActivations: (name: string) =>
    request<{ activations: SkillScopeActivation[] }>('GET', `/skills/${name}/activations`),
  // Lot 3b — review endpoints
  getSkillReview: (name: string) =>
    request<{ review: SkillReviewInfo }>('GET', `/skills/${name}/review`),
  postSkillReview: (name: string, reviewed: boolean) =>
    request<{ name: string; reviewed: boolean }>('POST', `/skills/${name}/review`, { reviewed }),
  getSkillAsset: (name: string, path: string) =>
    request<{ asset: SkillAssetContent }>('GET', `/skills/${name}/asset?path=${encodeURIComponent(path)}`),
  /** Browse the marketplace index — always 200 (400 only if q missing). Lot 4b. */
  marketSearch: (q: string) =>
    request<MarketSearchResult>('GET', `/skills/market/search?q=${encodeURIComponent(q)}`),
  // Lot 5b — export / pack -------------------------------------------------------
  /** Export a single skill as a .tgz — authenticated fetch → triggers browser download. */
  exportSkill: async (name: string): Promise<void> => {
    const path = `/skills/${encodeURIComponent(name)}/export`;
    const res = await fetch(path, { headers: { 'X-Auth-Token': getToken() } });
    if (!res.ok) {
      const ct = res.headers.get('content-type') ?? '';
      const parsed: unknown = ct.includes('application/json') ? await res.json() : await res.text();
      throw new HttpError(`HTTP ${res.status} GET ${path}`, res.status, parsed);
    }
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') ?? '';
    const m = cd.match(/filename="?([^";\r\n]+)"?/);
    const filename = m?.[1] ?? `${name}.tgz`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
  /** Export a set of skills as a pack .tgz — authenticated fetch → triggers browser download. */
  exportPack: async (names: string[]): Promise<void> => {
    const path = '/skills/pack/export';
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'X-Auth-Token': getToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ names }),
    });
    if (!res.ok) {
      const ct = res.headers.get('content-type') ?? '';
      const parsed: unknown = ct.includes('application/json') ? await res.json() : await res.text();
      throw new HttpError(`HTTP ${res.status} POST ${path}`, res.status, parsed);
    }
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') ?? '';
    const m = cd.match(/filename="?([^";\r\n]+)"?/);
    const filename = m?.[1] ?? `skills-pack-${names.length}.tgz`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
  /** Install a pack .tgz (raw body, like uploadSkill). Lot 5b. */
  installPack: async (file: File | Blob): Promise<PackInstallResponse> => {
    const res = await fetch('/skills/pack/install', {
      method: 'POST',
      headers: { 'X-Auth-Token': getToken(), 'Content-Type': 'application/gzip' },
      body: file,
    });
    const ct = res.headers.get('content-type') ?? '';
    const parsed: unknown = ct.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) {
      throw new HttpError(`HTTP ${res.status} POST /skills/pack/install`, res.status, parsed);
    }
    return parsed as PackInstallResponse;
  },
  // ---- Connector types -------------------------------------------------------
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
  // ---- Built-in features (docs/builtin-features.md) -------------------------
  // Behind the auth gate (D10). `enableFeature` on an `uninstalled` feature is
  // the documented install+enable. The front never refetches its feature map
  // off these responses: it patches on the `feature.changed` WS frame instead.
  listFeatures: () => request<{ features: FeatureView[] }>('GET', '/features'),
  enableFeature: (name: FeatureName) =>
    request<{ feature: FeatureView }>('POST', `/features/${name}/enable`),
  disableFeature: (name: FeatureName) =>
    request<{ feature: FeatureView }>('POST', `/features/${name}/disable`),
  /** Uninstall = disable + purge the feature's data (DELETE, never DROP). */
  uninstallFeature: (name: FeatureName) =>
    request<{ feature: FeatureView }>('DELETE', `/features/${name}`),
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
   * Monitoring Lot 3 — arm a context `compact` / `clear` on a session (lead
   * OR worker). The reset is DEFERRED: the server fires it at the session's
   * next idle, never mid-turn, so a `200 {scheduled:true}` means "armed",
   * not "done" — `SessionView.contextResetPending` is what falls back at the
   * next 3 s poll.
   *
   * Rejects with `HttpError` on 404 (unknown session) and on 409 with a
   * machine code: `PROVIDER_NO_RESET` (gemini & co. have no reset line),
   * `SESSION_NOT_ACTIVE` (terminal status), `RESET_ALREADY_PENDING`. Render
   * those through `apiErrorMessage` — the bare `HTTP 409 POST …` says
   * nothing an operator can act on.
   */
  contextReset: (
    sessionId: string,
    cmd: 'compact' | 'clear',
    instructions?: string,
  ) =>
    request<{ scheduled: true }>(
      'POST',
      `/sessions/${sessionId}/context-reset`,
      instructions === undefined ? { cmd } : { cmd, instructions },
    ),
  /**
   * Monitoring Lot 9 — context-usage history for ONE session over a sliding
   * window. Called only while the history band is open (there is no cheap
   * aggregate for it, unlike the sparkline series that rides on the
   * `/orchestrators` poll).
   *
   * Rejects with `HttpError` on 400 (window outside the union) and 404
   * (unknown session). A live session with nothing recorded yet answers
   * `200 {points: [], resets: []}` — an EMPTY state to render, not an error.
   * A backend predating Lot 9 answers 404 for every session; the band
   * treats that the same way, silently.
   */
  contextHistory: (sessionId: string, window: ContextHistoryWindow) =>
    request<ContextHistoryView>(
      'GET',
      `/sessions/${sessionId}/context-history?window=${window}`,
    ),
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
   * Monitoring Lot 10 — container CPU / memory from the deployment's own
   * cgroups. Drives the two arc gauges at the head of the MONITORING KPI
   * band. 404s on a server predating Lot 10; `useSystemMetrics` swallows the
   * error and the gauges stay at `—`.
   */
  getMetricsSystem: () =>
    request<SystemMetricsSnapshot>('GET', '/metrics/system'),
  /**
   * Monitoring Lot 12 — cost per team, workers that already left INCLUDED
   * (SQL aggregate over the soft-deleted session rows). Drives the TEAM COSTS
   * section and the BURN /H KPI. 404s on a server predating Lot 12;
   * `useTeamCosts` swallows the error and the section stays empty.
   */
  getMetricsCosts: () =>
    request<TeamCostsSnapshot>('GET', '/metrics/costs'),
  /**
   * Per-call ledger — one agent's API calls over `window`. Answers for ended
   * and removed agents too (SQLite, 14 days). 404 on an unknown id AND on a
   * server predating the ledger; the band treats both as "no chart".
   */
  sessionCalls: (sessionId: string, window: CallWindow) =>
    request<SessionCallsView>(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}/calls?window=${window}`,
    ),
  /** Per-call ledger — one team's calls and tokens per bucket, lead / workers. */
  getOrchestratorCallUsage: (orchId: string, window: CallWindow, bucket: CallBucket) =>
    request<CallUsageView>(
      'GET',
      `/orchestrators/${encodeURIComponent(orchId)}/call-usage?window=${window}&bucket=${bucket}`,
    ),
  /** Per-call ledger — the same for every team, plus one total per team. */
  getMetricsCallUsage: (window: CallWindow, bucket: CallBucket) =>
    request<CallUsageView>('GET', `/metrics/call-usage?window=${window}&bucket=${bucket}`),
  /**
   * Monitoring Lot 12 — per-session ventilation for ONE team, fetched when
   * its row is expanded. Not polled: the panel is a drill-down, and re-asking
   * every 15 s for a list of dead workers would be pure noise.
   */
  getOrchestratorCost: (orchId: string) =>
    request<OrchestratorCostView>(
      'GET',
      `/orchestrators/${encodeURIComponent(orchId)}/cost`,
    ),
  /**
   * Monitoring Lot 15 — the daily cost table (`session_token_daily`) as a
   * downloadable document: one row per day × session, `days` back (server
   * default 30, capped at 90).
   *
   * Returns the response body VERBATIM as a string, and deliberately stops
   * there: no Blob, no anchor, no `document` at all. Three reasons this is not
   * a `request()` call and not a download either —
   *
   *  1. `request()` would hand back the CSV as a `string` too, but only by
   *     accident of its content-type sniffing, and would silently `JSON.parse`
   *     the JSON flavour into an object — destroying the exact bytes the
   *     operator asked to save (key order, formatting, everything).
   *  2. A bare `window.open` of this URL cannot carry `X-Auth-Token`, so the
   *     fetch has to be explicit — same reason as `getCodegraphGraphHtml`.
   *  3. Keeping the DOM out means the failure path is a plain rejected promise
   *     the caller can turn into a toast, instead of a browser tab that has
   *     already opened onto an error page. `lib/costExport.ts` owns the save.
   *
   * Throws `HttpError` on any non-2xx — notably 404 on a server predating this
   * lot, which the caller reports as "server too old" rather than as a failure.
   */
  exportCosts: async (
    format: CostExportFormat,
    days?: number,
  ): Promise<string> => {
    const qs = new URLSearchParams({ format });
    if (days != null) qs.set('days', String(days));
    const path = `/metrics/costs/export?${qs.toString()}`;
    const res = await fetch(path, { headers: { 'X-Auth-Token': getToken() } });
    if (!res.ok) {
      const ct = res.headers.get('content-type') ?? '';
      const parsed: unknown = ct.includes('application/json')
        ? await res.json()
        : await res.text();
      throw new HttpError(`HTTP ${res.status} GET ${path}`, res.status, parsed);
    }
    return res.text();
  },
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
  /**
   * Embedding capabilities — drives the search-mode toggle. 404 on a server
   * predating Phase 5; the caller treats that as "semantic unavailable".
   */
  getMemoryCapabilities: () =>
    request<MemoryCapabilities>('GET', '/api/memory/capabilities'),
  /**
   * Ranked search. `mode` selects the engine (`text` default = exact FTS;
   * `semantic` = embedding cosine; `hybrid` = fuse both). `type` filters by note
   * type; `limit` caps results.
   */
  searchMemory: (
    q: string,
    opts: { type?: string; limit?: number; mode?: MemorySearchMode } = {},
  ) => {
    const qs = new URLSearchParams({ q });
    if (opts.type) qs.set('type', opts.type);
    if (opts.limit != null) qs.set('limit', String(opts.limit));
    if (opts.mode) qs.set('mode', opts.mode);
    return request<{ results: SearchHit[] }>('GET', `/api/memory/search?${qs.toString()}`);
  },
  /** Distinct relation labels currently in use (for typed-relation UI). */
  listMemoryRelations: () =>
    request<{ relations: string[] }>('GET', '/api/memory/relations'),
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

  // ---- Taskboard / Kanban (Phase 4, read-only web surface) ----------------
  // Feature-detect: a 404 on `listBoard` means the backend predates this
  // surface — the page renders a graceful empty state.

  /** List cards for one team. `status` and `assignee` are optional filters. */
  listBoard: (
    orchId: string,
    opts: { status?: BoardStatus; assignee?: string } = {},
  ) => {
    const qs = new URLSearchParams({ orch: orchId });
    if (opts.status) qs.set('status', opts.status);
    if (opts.assignee) qs.set('assignee', opts.assignee);
    return request<{ cards: BoardCard[] }>('GET', `/api/board?${qs.toString()}`);
  },

  /** Team selector data (all teams with cards). */
  listBoardTeams: () => request<{ teams: BoardTeam[] }>('GET', '/api/board/teams'),

  /** Full card detail with deps + audit journal. 404 when absent. */
  getBoardCard: (id: string) =>
    request<BoardCardDetail>('GET', `/api/board/card/${encodeURIComponent(id)}`),

  /** Operator cleanup — soft-delete a card (typically orphaned ones). */
  deleteBoardCard: (id: string) =>
    request<{ ok: boolean; deleted: boolean }>(
      'DELETE',
      `/api/board/card/${encodeURIComponent(id)}`,
    ),

  // ---- Approval gate (P3 actionable notification) -------------------------
  // Consumes the P2 REST surface (`http/routes/approvals.ts`). `orch` is
  // required (the queue is per-team, like the board); `status` is an optional
  // filter. A 404 on these means a backend predating the approval gate — the
  // caller degrades gracefully (no approvals surfaced).

  /** List a team's approvals, optionally filtered by status. */
  listApprovals: (orchId: string, status?: ApprovalStatus) => {
    const qs = new URLSearchParams({ orch: orchId });
    if (status) qs.set('status', status);
    return request<{ approvals: ApprovalListItem[] }>('GET', `/api/approvals?${qs.toString()}`);
  },

  /** One approval + the tail of its audit journal. 404 when absent. */
  getApproval: (id: string) =>
    request<ApprovalDetail>('GET', `/api/approvals/${encodeURIComponent(id)}`),

  /**
   * Resolve a pending approval: the server replays the operator's keystroke to
   * the blocked PTY and records the decision. `dontAskAgain` maps claude's
   * "approve AND don't ask again" option. `by` defaults to `'web'` server-side.
   */
  resolveApproval: (id: string, body: ResolveApprovalBody) =>
    request<ResolveApprovalResult>(
      'POST',
      `/api/approvals/${encodeURIComponent(id)}/resolve`,
      body,
    ),

  // ---- Code graph / Graphify (P4 web surface) -----------------------------
  // Backed by GET /api/codegraph (P3 REST, http/routes/codegraph.ts).
  // Feature-detect: a 404 on listCodegraphScopes means the backend predates
  // this surface; the page shows a graceful empty state.

  listCodegraphScopes: () =>
    request<{ scopes: CodegraphScope[] }>('GET', '/api/codegraph'),

  getCodegraphGraph: (scopeId: string) =>
    request<CodegraphGraph>('GET', `/api/codegraph/${encodeURIComponent(scopeId)}/graph`),

  /**
   * Fetch graphify's self-contained interactive `graph.html` (whole-graph viz)
   * as a Blob, so the caller can open it in a new tab via a blob: URL. This is
   * an AUTHENTICATED fetch — the same `X-Auth-Token` header + `swarm-os.token`
   * localStorage source as `request` — because a bare `window.open` of the URL
   * cannot carry the auth header. Throws `HttpError` on a non-2xx response.
   */
  getCodegraphGraphHtml: async (scopeId: string): Promise<Blob> => {
    const path = `/api/codegraph/${encodeURIComponent(scopeId)}/graph.html`;
    const res = await fetch(path, { headers: { 'X-Auth-Token': getToken() } });
    if (!res.ok) {
      const ct = res.headers.get('content-type') ?? '';
      const parsed: unknown = ct.includes('application/json')
        ? await res.json()
        : await res.text();
      throw new HttpError(`HTTP ${res.status} GET ${path}`, res.status, parsed);
    }
    return res.blob();
  },

  searchCodegraph: (scopeId: string, q: string, limit?: number) => {
    const qs = new URLSearchParams({ q });
    if (limit != null) qs.set('limit', String(limit));
    return request<CodegraphSearchResponse>(
      'GET',
      `/api/codegraph/${encodeURIComponent(scopeId)}/search?${qs.toString()}`,
    );
  },
};

// ── Codegraph DTOs (P4) ────────────────────────────────────────────────────
// Hand-maintained mirror of the server's codegraph types. Field names are
// wire-contractual; do NOT rename them.

/** One scope from `GET /api/codegraph`. */
export interface CodegraphScope {
  id: string;
  kind: string;
  path: string;
  enabled: boolean;
  status: string;
  nodeCount: number;
  edgeCount: number;
  lastIndexedAt: string | null;
  lastError: string | null;
}

/** A node in the NetworkX node-link `graph.json`. */
export interface CodegraphNode {
  id: string;
  label?: string | null;
  source_file?: string | null;
  source_location?: string | null;
  file_type?: string | null;
  community_name?: string | null;
  norm_label?: string | null;
}

/** A link in the NetworkX node-link `graph.json`. */
export interface CodegraphLink {
  source: string;
  target: string;
  relation?: string | null;
  source_file?: string | null;
  source_location?: string | null;
  weight?: number;
}

/** Full graph from `GET /api/codegraph/:scopeId/graph`. */
export interface CodegraphGraph {
  nodes: CodegraphNode[];
  links: CodegraphLink[];
}

/** One ranked hit from `GET /api/codegraph/:scopeId/search`. */
export interface CodegraphHit {
  id: string;
  label: string;
  file: string | null;
  line: number | null;
  fileType: string | null;
  community: string | null;
}

export type CodegraphSearchResponse =
  | { ok: true; scope: string; results: CodegraphHit[] }
  | { ok: false; reason: string };

export { HttpError };

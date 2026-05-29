// REST client for the swarm-os server. Sends X-Auth-Token from localStorage on
// every authenticated request. /health and /info are intentionally token-free.

const TOKEN_KEY = 'swarm-os.token';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setToken(t: string): void {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
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

export interface DiscordConnectorView {
  type: 'discord';
  webhookUrl: string;
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
export type ConnectorView = DiscordConnectorView;

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
  connectors: ConnectorView[];
  createdAt: string;
  updatedAt: string;
}

export type RoleInput = Omit<RoleView, 'id' | 'createdAt' | 'updatedAt'>;

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
  updatedAt: '1970-01-01T00:00:00.000Z',
};

export interface HealthView {
  status: string;
  project_name: string;
  orchestrators_active: number;
  sessions_active: number;
  sessions_waiting: number;
  uptime_seconds: number;
}

export interface InfoView {
  project_name: string;
  version: string;
  started_at: string;
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

class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
  }
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
    defaults?: { model?: string; effort?: string; permissionMode?: string };
  }) =>
    request<{ orchestrator: OrchestratorView; lead: SessionView }>(
      'POST',
      '/orchestrators',
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
  /**
   * Destroy an orchestrator. `opts.hide` collapses stop-then-remove into one
   * request: the team is soft-deleted from the map as soon as the lead PTY
   * exits. Used by the KILL UI button on a lead.
   */
  destroyOrchestrator: (id: string, opts: { hide?: boolean } = {}) => {
    const qs = opts.hide ? '?hide=true' : '';
    return request<void>('DELETE', `/orchestrators/${id}${qs}`);
  },
  getSession: (id: string) => request<SessionView>('GET', `/sessions/${id}`),
  postSessionInput: (id: string, data: string) =>
    request<{ ok: boolean; bytes: number }>('POST', `/sessions/${id}/input`, { data }),
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
};

export { HttpError };

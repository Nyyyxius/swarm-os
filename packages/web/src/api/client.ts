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
  status: 'starting' | 'running' | 'waiting' | 'exited' | 'killed' | 'interrupted' | 'failed';
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  lastError: string | null;
  stopReason: string | null;
  logPath: string;
  lastActivityAt: string;
}

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

export const api = {
  health: () => request<HealthView>('GET', '/health', undefined, { auth: false }),
  info: () => request<InfoView>('GET', '/info', undefined, { auth: false }),
  listOrchestrators: () =>
    request<{ orchestrators: OrchestratorView[] }>('GET', '/orchestrators'),
  getOrchestrator: (id: string) => request<OrchestratorView>('GET', `/orchestrators/${id}`),
  createOrchestrator: (body: {
    name: string;
    role: string;
    lead: { cwd: string; prompt: string; preamble?: string };
    workerPreamble?: string;
    defaults?: { model?: string; effort?: string; permissionMode?: string };
  }) =>
    request<{ orchestrator: OrchestratorView; lead: SessionView }>(
      'POST',
      '/orchestrators',
      body,
    ),
  destroyOrchestrator: (id: string) =>
    request<void>('DELETE', `/orchestrators/${id}`),
  getSession: (id: string) => request<SessionView>('GET', `/sessions/${id}`),
  postSessionInput: (id: string, data: string) =>
    request<{ ok: boolean; bytes: number }>('POST', `/sessions/${id}/input`, { data }),
  getWsTicket: (sessionId: string) =>
    request<{ ticket: string; ttlMs: number; kind: string; sessionId: string }>(
      'GET',
      `/ws-ticket?session=${encodeURIComponent(sessionId)}`,
    ),
  getEventsTicket: () =>
    request<{ ticket: string; ttlMs: number; kind: string }>('GET', `/ws-ticket?events=1`),
};

export { HttpError };

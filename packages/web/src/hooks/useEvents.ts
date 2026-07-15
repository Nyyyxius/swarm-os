import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

/**
 * Phase 4 — subscribe to `/ws/events` and surface a toast whenever a
 * session enters the `waiting` state (driven by the Notification hook).
 *
 * The hook auto-reconnects with backoff if the WS drops. Tickets expire
 * after 10 s so a fresh one is fetched per (re)connect attempt.
 *
 * Toasts are deduplicated by `sessionId` — repeated waiting events for the
 * same session refresh the existing notice (newer ts, reset auto-dismiss)
 * instead of stacking. Each notice also auto-dismisses after 30 s so a
 * burst of unattended sessions can't fill the viewport indefinitely.
 *
 * Step 6 — additive subscription callbacks for MapView pulses + spawn
 * animation. Callbacks are kept in refs so the WS effect doesn't tear
 * down on every parent render — only the ref is updated. This is the
 * same pattern as useGlobalMessageStats and avoids duplicate connection
 * warnings (cf. commit 584d9ec).
 */

export interface SwarmEvent {
  kind: string;
  ts: string;
  orchestratorId?: string;
  sessionId?: string;
  payload?: unknown;
}

export interface WaitingNotice {
  id: string;
  ts: string;
  orchestratorId?: string;
  sessionId?: string;
  reason?: string;
}

/**
 * Normalized `mailbox.message` frame surfaced to MapView for pulse
 * derivation. Only fired when payload is well-formed (has at least
 * `from`, `to`, `sessionId`, `orchestratorId`).
 */
export interface MailboxMessageEvent {
  kind: 'mailbox.message';
  ts: string;
  orchestratorId: string;
  sessionId: string;
  from: string;
  to: string;
  fromOrchestratorId?: string;
  fromOrchestratorName?: string;
  fromSessionName?: string;
}

/**
 * Normalized `session.created` frame surfaced to DesktopShell to drive
 * the spawn animation with sub-second latency (the polling diff fallback
 * inside DesktopShell still covers MCP-created sessions in case the
 * server doesn't emit this event yet).
 */
export interface SessionCreatedEvent {
  kind: 'session.created';
  ts: string;
  orchestratorId: string;
  sessionId: string;
}

/**
 * Normalized `orchestrator.created` frame surfaced to DesktopShell to
 * drive the `.flash-new` team-pill animation with sub-second latency.
 * Backend emission: packages/server/src/modules/spawner/index.ts:117-121
 * (payload = orch.toView()). The polling diff fallback in DesktopShell
 * still covers cases where the WS dropped between create + reconnect.
 */
export interface OrchestratorCreatedEvent {
  kind: 'orchestrator.created';
  ts: string;
  orchestratorId: string;
}

/**
 * Normalized `plugin.host.changed` frame — a plugin's enable/status changed.
 * Payload is minimal so the UI can refresh the plugins list without a refetch
 * of each row (see server events.ts PluginHostChangedPayload).
 */
export interface PluginHostChangedEvent {
  kind: 'plugin.host.changed';
  ts: string;
  name: string;
  status: string;
  enabled: boolean;
}

export interface UseEventsOptions {
  /** Callback fired on every well-formed mailbox.message frame. */
  onMailboxMessage?: (ev: MailboxMessageEvent) => void;
  /** Callback fired on every session.created frame. */
  onSessionCreated?: (ev: SessionCreatedEvent) => void;
  /** Callback fired on every orchestrator.created frame (Step 19). */
  onOrchestratorCreated?: (ev: OrchestratorCreatedEvent) => void;
  /** Callback fired on every plugin.host.changed frame (J1 plugins). */
  onPluginHostChanged?: (ev: PluginHostChangedEvent) => void;
}

const AUTO_DISMISS_MS = 30_000;

export function useEvents(opts: UseEventsOptions = {}): {
  connected: boolean;
  waiting: WaitingNotice[];
  dismiss: (id: string) => void;
  clear: () => void;
} {
  const [connected, setConnected] = useState(false);
  const [waiting, setWaiting] = useState<WaitingNotice[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const closedRef = useRef(false);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Step 6 — mirror callbacks in refs so the WS effect (mount-only deps)
  // reads the fresh fn without tearing down the socket on parent renders.
  const onMailRef = useRef<UseEventsOptions['onMailboxMessage']>(opts.onMailboxMessage);
  const onCreatedRef = useRef<UseEventsOptions['onSessionCreated']>(opts.onSessionCreated);
  const onOrchCreatedRef = useRef<UseEventsOptions['onOrchestratorCreated']>(opts.onOrchestratorCreated);
  const onPluginRef = useRef<UseEventsOptions['onPluginHostChanged']>(opts.onPluginHostChanged);
  useEffect(() => { onMailRef.current = opts.onMailboxMessage; }, [opts.onMailboxMessage]);
  useEffect(() => { onCreatedRef.current = opts.onSessionCreated; }, [opts.onSessionCreated]);
  useEffect(() => { onOrchCreatedRef.current = opts.onOrchestratorCreated; }, [opts.onOrchestratorCreated]);
  useEffect(() => { onPluginRef.current = opts.onPluginHostChanged; }, [opts.onPluginHostChanged]);

  const cancelTimer = (id: string): void => {
    const t = timersRef.current.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      timersRef.current.delete(id);
    }
  };

  const dismiss = (id: string): void => {
    cancelTimer(id);
    setWaiting((w) => w.filter((n) => n.id !== id));
  };

  const clear = (): void => {
    for (const t of timersRef.current.values()) clearTimeout(t);
    timersRef.current.clear();
    setWaiting([]);
  };

  useEffect(() => {
    let cancelled = false;
    let backoff = 1000;
    closedRef.current = false;
    const timers = timersRef.current;

    const scheduleAutoDismiss = (id: string): void => {
      const existing = timers.get(id);
      if (existing !== undefined) clearTimeout(existing);
      const t = setTimeout(() => {
        timers.delete(id);
        setWaiting((w) => w.filter((n) => n.id !== id));
      }, AUTO_DISMISS_MS);
      timers.set(id, t);
    };

    async function connect() {
      while (!cancelled) {
        try {
          const t = await api.getEventsTicket();
          const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/events?ticket=${t.ticket}`;
          const ws = new WebSocket(url);
          wsRef.current = ws;
          await new Promise<void>((resolve, reject) => {
            let opened = false;
            ws.onopen = () => {
              opened = true;
              setConnected(true);
              backoff = 1000;
            };
            ws.onerror = () => {
              if (!opened) reject(new Error('ws error'));
            };
            ws.onclose = () => {
              setConnected(false);
              if (opened) resolve();
              else reject(new Error('ws closed'));
            };
            ws.onmessage = (e) => {
              try {
                const ev = JSON.parse(typeof e.data === 'string' ? e.data : '') as SwarmEvent;

                // Step 6 — mailbox.message: normalize + fire subscriber.
                // Does NOT early-return so the existing waiting-toast path
                // below keeps running for other frames.
                if (ev.kind === 'mailbox.message') {
                  const p = ev.payload as
                    | {
                        from?: string;
                        to?: string;
                        fromOrchestratorId?: string;
                        fromOrchestratorName?: string;
                        fromSessionName?: string;
                      }
                    | undefined;
                  if (
                    p && typeof p.from === 'string' && typeof p.to === 'string'
                    && typeof ev.sessionId === 'string'
                    && typeof ev.orchestratorId === 'string'
                  ) {
                    onMailRef.current?.({
                      kind: 'mailbox.message',
                      ts: ev.ts,
                      orchestratorId: ev.orchestratorId,
                      sessionId: ev.sessionId,
                      from: p.from,
                      to: p.to,
                      fromOrchestratorId: p.fromOrchestratorId,
                      fromOrchestratorName: p.fromOrchestratorName,
                      fromSessionName: p.fromSessionName,
                    });
                  }
                }

                // Step 6 — session.created: drive spawn animation.
                if (
                  ev.kind === 'session.created'
                  && typeof ev.sessionId === 'string'
                  && typeof ev.orchestratorId === 'string'
                ) {
                  onCreatedRef.current?.({
                    kind: 'session.created',
                    ts: ev.ts,
                    orchestratorId: ev.orchestratorId,
                    sessionId: ev.sessionId,
                  });
                }

                // Step 19 — orchestrator.created: drive `.flash-new`
                // team-pill animation. Backend payload is the full
                // OrchestratorView; we surface only the id (sufficient
                // for the flash trigger, the snapshot poll fills the rest).
                if (
                  ev.kind === 'orchestrator.created'
                  && typeof ev.orchestratorId === 'string'
                ) {
                  onOrchCreatedRef.current?.({
                    kind: 'orchestrator.created',
                    ts: ev.ts,
                    orchestratorId: ev.orchestratorId,
                  });
                }

                // J1 plugins — plugin.host.changed: refresh the plugins list
                // live. Payload carries { name, status, enabled }.
                if (ev.kind === 'plugin.host.changed') {
                  const p = ev.payload as
                    | { name?: string; status?: string; enabled?: boolean }
                    | undefined;
                  onPluginRef.current?.({
                    kind: 'plugin.host.changed',
                    ts: ev.ts,
                    name: typeof p?.name === 'string' ? p.name : '',
                    status: typeof p?.status === 'string' ? p.status : '',
                    enabled: p?.enabled === true,
                  });
                }

                // Phase 4: notification hook fires session.status_changed
                // with payload.status === 'waiting'. Surface it as a toast.
                if (
                  ev.kind === 'session.status_changed' &&
                  (ev.payload as { status?: string })?.status === 'waiting'
                ) {
                  // Dedupe key: one toast per session. Falls back to ts when
                  // sessionId is absent so unknown-session events still surface
                  // individually instead of collapsing into a single phantom.
                  const id = ev.sessionId ?? `unknown-${ev.ts}`;
                  const notice: WaitingNotice = {
                    id,
                    ts: ev.ts,
                    orchestratorId: ev.orchestratorId,
                    sessionId: ev.sessionId,
                    reason: (ev.payload as { reason?: string })?.reason,
                  };
                  setWaiting((w) => {
                    const filtered = w.filter((n) => n.id !== id);
                    filtered.push(notice);
                    return filtered;
                  });
                  scheduleAutoDismiss(id);
                }
              } catch {
                /* drop malformed frames */
              }
            };
          });
        } catch {
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 30000);
        }
      }
    }
    void connect();
    return () => {
      cancelled = true;
      closedRef.current = true;
      try {
        wsRef.current?.close();
      } catch {
        /* ignore */
      }
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  return { connected, waiting, dismiss, clear };
}

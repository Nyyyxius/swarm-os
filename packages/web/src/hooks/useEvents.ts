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

const AUTO_DISMISS_MS = 30_000;

export function useEvents(): {
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
            ws.onopen = () => {
              setConnected(true);
              backoff = 1000;
              resolve();
            };
            ws.onerror = () => reject(new Error('ws error'));
            ws.onclose = () => {
              setConnected(false);
              if (!cancelled) reject(new Error('ws closed'));
            };
            ws.onmessage = (e) => {
              try {
                const ev = JSON.parse(typeof e.data === 'string' ? e.data : '') as SwarmEvent;
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

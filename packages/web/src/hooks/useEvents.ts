import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

/**
 * Phase 4 — subscribe to `/ws/events` and surface a toast whenever a
 * session enters the `waiting` state (driven by the Notification hook).
 *
 * The hook auto-reconnects with backoff if the WS drops. Tickets expire
 * after 10 s so a fresh one is fetched per (re)connect attempt.
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

  const dismiss = (id: string): void => setWaiting((w) => w.filter((n) => n.id !== id));
  const clear = (): void => setWaiting([]);

  useEffect(() => {
    let cancelled = false;
    let backoff = 1000;
    closedRef.current = false;

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
                  setWaiting((w) => [
                    ...w,
                    {
                      id: `${ev.ts}-${ev.sessionId ?? 'unknown'}`,
                      ts: ev.ts,
                      orchestratorId: ev.orchestratorId,
                      sessionId: ev.sessionId,
                      reason: (ev.payload as { reason?: string })?.reason,
                    },
                  ]);
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
    };
  }, []);

  return { connected, waiting, dismiss, clear };
}

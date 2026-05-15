import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api/client';

interface Props {
  sessionId: string;
}

export function Terminal({ sessionId }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting');
  const [role, setRole] = useState<'writer' | 'reader' | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let term: XTerm | null = null;
    let fit: FitAddon | null = null;
    let ws: WebSocket | null = null;
    let resizeObs: ResizeObserver | null = null;

    async function go() {
      try {
        const ticket = await api.getWsTicket(sessionId);
        if (cancelled) return;

        term = new XTerm({
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
          fontSize: 13,
          theme: { background: '#0b1220' },
          cursorBlink: true,
          scrollback: 5000,
          convertEol: true,
        });
        fit = new FitAddon();
        term.loadAddon(fit);
        term.loadAddon(new WebLinksAddon());
        if (containerRef.current) {
          term.open(containerRef.current);
          try {
            fit.fit();
          } catch {
            /* noop */
          }
        }

        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const url = `${proto}://${window.location.host}/ws/sessions/${encodeURIComponent(
          sessionId,
        )}?ticket=${encodeURIComponent(ticket.ticket)}`;
        ws = new WebSocket(url);

        ws.onopen = () => {
          setStatus('open');
          if (term && fit) {
            try {
              fit.fit();
            } catch {
              /* noop */
            }
            ws?.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          }
        };
        ws.onmessage = (ev) => {
          if (!term) return;
          try {
            const obj: unknown = JSON.parse(String(ev.data));
            if (obj && typeof obj === 'object') {
              const o = obj as { type?: string; data?: string; role?: string; lines?: string[] };
              switch (o.type) {
                case 'attached':
                  if (o.role === 'writer' || o.role === 'reader') setRole(o.role);
                  return;
                case 'role-changed':
                  if (o.role === 'writer' || o.role === 'reader') setRole(o.role);
                  return;
                case 'replay':
                  if (Array.isArray(o.lines)) {
                    for (const l of o.lines) term.writeln(l);
                  }
                  return;
                case 'data':
                  if (typeof o.data === 'string') term.write(o.data);
                  return;
                case 'exit':
                  term.writeln('\r\n[swarm-os] session exited');
                  return;
              }
            }
          } catch {
            // Plain text — write as-is.
            term.write(String(ev.data));
          }
        };
        ws.onerror = () => {
          setStatus('error');
          setErrorMsg('WebSocket error');
        };
        ws.onclose = () => setStatus((s) => (s === 'error' ? s : 'closed'));

        term.onData((d) => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input', data: d }));
          }
        });

        if (containerRef.current) {
          resizeObs = new ResizeObserver(() => {
            if (!fit || !term) return;
            try {
              fit.fit();
            } catch {
              /* noop */
            }
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
            }
          });
          resizeObs.observe(containerRef.current);
        }
      } catch (err) {
        setStatus('error');
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    }
    void go();

    return () => {
      cancelled = true;
      try {
        ws?.close();
      } catch {
        /* noop */
      }
      try {
        resizeObs?.disconnect();
      } catch {
        /* noop */
      }
      try {
        term?.dispose();
      } catch {
        /* noop */
      }
    };
  }, [sessionId]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 text-xs text-slate-400 mb-1">
        <span>WS: {status}</span>
        <span>·</span>
        <span>role: {role ?? '…'}</span>
        {errorMsg && <span className="text-red-400">{errorMsg}</span>}
      </div>
      <div ref={containerRef} className="flex-1 min-h-0 bg-[#0b1220] border border-slate-700 rounded p-1" />
    </div>
  );
}

import { useEffect, useState } from 'react';

interface HealthState {
  status: string;
  uptime: number;
}

export default function App() {
  const [health, setHealth] = useState<HealthState | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>(
    'connecting',
  );
  const [wsMessages, setWsMessages] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch('/health')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: HealthState) => {
        if (!cancelled) setHealth(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setHealthError(err instanceof Error ? err.message : String(err));
      });

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/events`);
    ws.onopen = () => {
      setWsStatus('open');
      ws.send(JSON.stringify({ ping: 'hello-from-web' }));
    };
    ws.onmessage = (ev) => {
      setWsMessages((m) => [...m, String(ev.data)].slice(-10));
    };
    ws.onerror = () => setWsStatus('error');
    ws.onclose = () => setWsStatus((s) => (s === 'error' ? s : 'closed'));

    return () => {
      cancelled = true;
      ws.close();
    };
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-8">
      <h1 className="text-3xl font-bold mb-6">swarm-os</h1>
      <p className="text-slate-400 mb-8">Phase 0 bootstrap — Tailwind utility class verifies.</p>

      <section className="mb-6">
        <h2 className="text-xl font-semibold mb-2">/health</h2>
        {health ? (
          <pre className="bg-slate-900 p-3 rounded text-sm">{JSON.stringify(health, null, 2)}</pre>
        ) : healthError ? (
          <p className="text-red-400">Error: {healthError}</p>
        ) : (
          <p className="text-slate-500">loading...</p>
        )}
      </section>

      <section>
        <h2 className="text-xl font-semibold mb-2">/ws/events ({wsStatus})</h2>
        <ul className="bg-slate-900 p-3 rounded text-sm space-y-1">
          {wsMessages.length === 0 ? (
            <li className="text-slate-500">no messages yet</li>
          ) : (
            wsMessages.map((m, i) => <li key={i}>{m}</li>)
          )}
        </ul>
      </section>
    </div>
  );
}

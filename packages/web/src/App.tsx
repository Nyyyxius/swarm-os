import { useEffect, useState } from 'react';
import { OrchestratorList } from './components/OrchestratorList';
import { OrchestratorView } from './components/OrchestratorView';
import { api, getToken, setToken, type HealthView, type InfoView } from './api/client';

type Route = { kind: 'list' } | { kind: 'detail'; id: string };

/**
 * Parse the current URL hash into a Route. We use the URL fragment so deep
 * links work without needing server-side rewrites:
 *
 *   #/orchestrators/<id>  → detail view
 *   #/                    → list (also: empty hash)
 */
function parseHash(): Route {
  const h = window.location.hash;
  const m = /^#\/orchestrators\/([a-zA-Z0-9-]+)$/.exec(h);
  if (m && m[1]) return { kind: 'detail', id: m[1] };
  return { kind: 'list' };
}

function setHashRoute(route: Route): void {
  const target = route.kind === 'list' ? '#/' : `#/orchestrators/${route.id}`;
  if (window.location.hash !== target) {
    window.location.hash = target;
  }
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => parseHash());
  const [token, setTokenState] = useState<string>(getToken());
  const [showSettings, setShowSettings] = useState(false);
  const [health, setHealth] = useState<HealthView | null>(null);
  const [info, setInfo] = useState<InfoView | null>(null);

  useEffect(() => {
    void api.health().then(setHealth).catch(() => undefined);
    void api.info().then(setInfo).catch(() => undefined);
  }, []);

  useEffect(() => {
    setTokenState(getToken());
  }, [showSettings]);

  // Keep the hash in sync with state, AND honour back/forward navigation.
  useEffect(() => {
    setHashRoute(route);
  }, [route]);

  useEffect(() => {
    function onHashChange() {
      setRoute(parseHash());
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <header className="border-b border-slate-800 px-4 py-2 flex items-center gap-3">
        <h1 className="text-lg font-bold tracking-tight">swarm-os</h1>
        {info && (
          <span className="text-xs text-slate-400 font-mono">
            project={info.project_name} · v{info.version}
          </span>
        )}
        {health && (
          <span className="text-xs text-slate-400 font-mono">
            orch={health.orchestrators_active} · sess={health.sessions_active} · uptime=
            {health.uptime_seconds}s
          </span>
        )}
        <div className="ml-auto">
          <button
            className="px-2 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700"
            onClick={() => setShowSettings((v) => !v)}
          >
            Settings
          </button>
        </div>
      </header>

      {showSettings && (
        <div className="border-b border-slate-800 p-4 bg-slate-900">
          <label className="block text-xs text-slate-400 mb-1">X-Auth-Token (stored in localStorage)</label>
          <input
            className="w-full max-w-xl bg-slate-950 border border-slate-700 rounded px-2 py-1 text-sm font-mono"
            value={token}
            onChange={(e) => setTokenState(e.target.value)}
            type="password"
            placeholder="paste your SWARM_OS_TOKEN here"
          />
          <div className="mt-2 flex gap-2">
            <button
              className="px-3 py-1 text-xs rounded bg-emerald-600 hover:bg-emerald-500"
              onClick={() => {
                setToken(token.trim());
                setShowSettings(false);
              }}
            >
              Save
            </button>
            <button
              className="px-3 py-1 text-xs rounded bg-slate-700"
              onClick={() => {
                setToken('');
                setTokenState('');
              }}
            >
              Clear
            </button>
          </div>
        </div>
      )}

      <main className="flex-1 p-4 min-h-0">
        {route.kind === 'list' ? (
          <OrchestratorList onSelect={(id) => setRoute({ kind: 'detail', id })} />
        ) : (
          <OrchestratorView
            orchestratorId={route.id}
            onBack={() => setRoute({ kind: 'list' })}
          />
        )}
      </main>
    </div>
  );
}

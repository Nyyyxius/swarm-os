import { useCallback, useEffect, useState } from 'react';
import { OrchestratorList } from './components/OrchestratorList';
import { OrchestratorView } from './components/OrchestratorView';
import { NotificationPanel } from './components/NotificationPanel';
import { RolesPage } from './components/RolesPage';
import {
  api,
  getToken,
  setToken,
  HttpError,
  type HealthView,
  type InfoView,
} from './api/client';

type Route = { kind: 'list' } | { kind: 'detail'; id: string } | { kind: 'roles' };

/**
 * Parse the current URL hash into a Route. We use the URL fragment so deep
 * links work without needing server-side rewrites:
 *
 *   #/orchestrators/<id>  → detail view
 *   #/roles               → roles dashboard
 *   #/                    → list (also: empty hash)
 */
function parseHash(): Route {
  const h = window.location.hash;
  const m = /^#\/orchestrators\/([a-zA-Z0-9-]+)$/.exec(h);
  if (m && m[1]) return { kind: 'detail', id: m[1] };
  if (h === '#/roles') return { kind: 'roles' };
  return { kind: 'list' };
}

function setHashRoute(route: Route): void {
  let target: string;
  if (route.kind === 'list') target = '#/';
  else if (route.kind === 'roles') target = '#/roles';
  else target = `#/orchestrators/${route.id}`;
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
  // Phase 6: surface a clear "token required" prompt when the stored token
  // is empty or every authenticated probe returns 401. We probe by calling
  // listOrchestrators (cheap auth-gated GET) and surface the result through
  // the settings panel so the operator knows where to grab the first-boot
  // token without having to find it in container logs.
  const [authState, setAuthState] = useState<'unknown' | 'ok' | 'missing' | 'invalid'>('unknown');

  const probeAuth = useCallback(async () => {
    if (!getToken()) {
      setAuthState('missing');
      return;
    }
    try {
      await api.listOrchestrators();
      setAuthState('ok');
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) setAuthState('invalid');
      else setAuthState('ok'); // network/server errors: don't pin as auth issue
    }
  }, []);

  useEffect(() => {
    void api.health().then(setHealth).catch(() => undefined);
    void api.info().then(setInfo).catch(() => undefined);
    void probeAuth();
  }, [probeAuth]);

  useEffect(() => {
    setTokenState(getToken());
  }, [showSettings]);

  // Auto-open settings when no token is stored or it's been rejected.
  useEffect(() => {
    if (authState === 'missing' || authState === 'invalid') setShowSettings(true);
  }, [authState]);

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
        <div className="ml-auto flex gap-2">
          <button
            className={`px-2 py-1 text-xs rounded ${route.kind === 'list' ? 'bg-emerald-700' : 'bg-slate-800 hover:bg-slate-700'}`}
            onClick={() => setRoute({ kind: 'list' })}
          >
            Orchestrators
          </button>
          <button
            className={`px-2 py-1 text-xs rounded ${route.kind === 'roles' ? 'bg-emerald-700' : 'bg-slate-800 hover:bg-slate-700'}`}
            onClick={() => setRoute({ kind: 'roles' })}
          >
            Roles
          </button>
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
          {(authState === 'missing' || authState === 'invalid') && (
            <div className="mb-3 rounded border border-amber-700 bg-amber-950/40 p-3 text-xs text-amber-200">
              <div className="font-semibold mb-1">
                {authState === 'missing' ? 'Token required' : 'Token rejected (401)'}
              </div>
              <div className="leading-relaxed">
                Paste your <code className="text-amber-100">SWARM_OS_TOKEN</code> below.
                The first-boot token is auto-generated and persisted in the
                container at <code className="text-amber-100">/data/token</code>. Retrieve it with:
                <pre className="mt-1 p-2 bg-black/30 rounded font-mono text-[11px] overflow-x-auto">docker exec &lt;container&gt; cat /data/token</pre>
              </div>
            </div>
          )}
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
                void probeAuth();
              }}
            >
              Save
            </button>
            <button
              className="px-3 py-1 text-xs rounded bg-slate-700"
              onClick={() => {
                setToken('');
                setTokenState('');
                setAuthState('missing');
              }}
            >
              Clear
            </button>
          </div>
        </div>
      )}

      <main className="flex-1 p-4 min-h-0">
        {route.kind === 'list' && (
          <OrchestratorList onSelect={(id) => setRoute({ kind: 'detail', id })} />
        )}
        {route.kind === 'roles' && <RolesPage />}
        {route.kind === 'detail' && (
          <OrchestratorView
            orchestratorId={route.id}
            onBack={() => setRoute({ kind: 'list' })}
          />
        )}
      </main>

      <NotificationPanel
        onOpenOrchestrator={(id) => setRoute({ kind: 'detail', id })}
      />
    </div>
  );
}

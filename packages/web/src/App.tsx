import { useEffect, useState } from 'react';
import DesktopShell from './components/desktop/DesktopShell';
import { RolesPage } from './components/RolesPage';

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

/**
 * Phase C — Step 11 : App.tsx is now a thin routing shell. All in-shell
 * state (auth probing, settings drawer, info/health polling) has migrated
 * into `DesktopShell` so the SettingsDrawer can co-locate with the single
 * `useEvents()` consumer (regression-guard for the duplicate WS bug
 * 584d9ec). The inline amber "Token required" banner + settings panel
 * that used to live here are replaced by the drawer's auto-open behaviour
 * driven by `authState === 'missing' | 'invalid'`.
 */
export default function App() {
  const [route, setRoute] = useState<Route>(() => parseHash());

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
      <main className="flex-1 min-h-0 relative">
        <DesktopShell
          routeOrchestratorId={route.kind === 'detail' ? route.id : null}
          onOpenOrchestrator={(id) => setRoute({ kind: 'detail', id })}
          onOpenRoles={() => setRoute({ kind: 'roles' })}
          onCloseRightPanel={() => {
            if (route.kind === 'detail') setRoute({ kind: 'list' });
          }}
        />
        {/* Phase C — Step 10 : RolesPage v2 fullscreen overlay.
            The component owns its `.roles-overlay` positioning (fixed inset
            56px 0 0 0, z-index 60), so we no longer wrap it in a Tailwind
            placeholder. `open` gates rendering; `onClose` flips the hash
            back to `#/` (caller stays sovereign over the route). */}
        <RolesPage
          open={route.kind === 'roles'}
          onClose={() => setRoute({ kind: 'list' })}
        />
      </main>
    </div>
  );
}

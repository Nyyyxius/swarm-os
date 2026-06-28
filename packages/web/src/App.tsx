import { useEffect, useState } from 'react';
import DesktopShell from './components/desktop/DesktopShell';
import MobileShell from './components/mobile/MobileShell';
import { RolesPage } from './components/RolesPage';
import IdeOverlay from './components/desktop/IdeOverlay';
import { SwarmControllerProvider } from './controller/SwarmController';
import { useShellMode } from './hooks/useShellMode';

type Route =
  | { kind: 'list' }
  | { kind: 'detail'; id: string }
  | { kind: 'roles' }
  | { kind: 'ide' };

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
  if (h === '#/ide') return { kind: 'ide' };
  return { kind: 'list' };
}

function setHashRoute(route: Route): void {
  let target: string;
  if (route.kind === 'list') target = '#/';
  else if (route.kind === 'roles') target = '#/roles';
  else if (route.kind === 'ide') target = '#/ide';
  else target = `#/orchestrators/${route.id}`;
  if (window.location.hash !== target) {
    window.location.hash = target;
  }
}

/**
 * App.tsx is the sovereign router AND the aiguillage point. It keeps the
 * hash ⇄ route state in sync, decides desktop vs mobile via `useShellMode`,
 * and mounts the SINGLE `<SwarmControllerProvider>` ABOVE whichever shell
 * is active. The provider (not the shell) owns `useEvents()` so the WS
 * survives a desktop↔mobile swap — there is never a transient second
 * consumer (regression-guard 584d9ec).
 *
 * `#/roles` and `#/ide` are desktop-only overlays in v1; on mobile they are
 * redirected to `#/` (the mobile roles screen lands in a later slice).
 */
export default function App() {
  const [route, setRoute] = useState<Route>(() => parseHash());
  const { isMobile, mode: shellMode, setMode: setShellMode } = useShellMode();

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

  // Mobile v1 has no roles/ide overlay — redirect those routes to the list
  // so a deep-link / bookmark doesn't land on a blank surface.
  useEffect(() => {
    if (isMobile && (route.kind === 'roles' || route.kind === 'ide')) {
      setRoute({ kind: 'list' });
    }
  }, [isMobile, route.kind]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <main className="flex-1 min-h-0 relative">
        <SwarmControllerProvider
          routeOrchestratorId={route.kind === 'detail' ? route.id : null}
          onOpenOrchestrator={(id) => setRoute({ kind: 'detail', id })}
          onOpenRoles={() => setRoute({ kind: 'roles' })}
          onOpenIde={() => setRoute({ kind: 'ide' })}
          onCloseRightPanel={() => {
            if (route.kind === 'detail') setRoute({ kind: 'list' });
          }}
          shellMode={shellMode}
          setShellMode={setShellMode}
        >
          {isMobile ? <MobileShell /> : <DesktopShell />}

          {/* Desktop-only fullscreen overlays. Gated out entirely on mobile
              (the redirect effect above keeps the route off these kinds). */}
          {!isMobile && (
            <>
              <RolesPage
                open={route.kind === 'roles'}
                onClose={() => setRoute({ kind: 'list' })}
              />
              {route.kind === 'ide' && (
                <IdeOverlay onClose={() => setRoute({ kind: 'list' })} />
              )}
            </>
          )}
        </SwarmControllerProvider>
      </main>
    </div>
  );
}

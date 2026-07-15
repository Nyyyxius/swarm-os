import { useEffect, useState } from 'react';
import DesktopShell from './components/desktop/DesktopShell';
import MobileShell from './components/mobile/MobileShell';
import { RolesPage } from './components/RolesPage';
import { PluginsPage } from './components/PluginsPage';
import IdeOverlay from './components/desktop/IdeOverlay';
import { SwarmControllerProvider } from './controller/SwarmController';
import { useShellMode } from './hooks/useShellMode';

type Route =
  | { kind: 'list' }
  | { kind: 'detail'; id: string }
  | { kind: 'roles' }
  | { kind: 'plugins' }
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
  if (h === '#/plugins') return { kind: 'plugins' };
  if (h === '#/ide') return { kind: 'ide' };
  return { kind: 'list' };
}

function setHashRoute(route: Route): void {
  let target: string;
  if (route.kind === 'list') target = '#/';
  else if (route.kind === 'roles') target = '#/roles';
  else if (route.kind === 'plugins') target = '#/plugins';
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

  // Mobile has no IDE overlay (VS Code in an iframe on a phone is not useful),
  // so `#/ide` redirects to the list. `#/roles` IS supported on mobile (the
  // RolesPage overlay adapts responsively).
  useEffect(() => {
    if (isMobile && route.kind === 'ide') {
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
          onOpenPlugins={() => setRoute({ kind: 'plugins' })}
          onOpenIde={() => setRoute({ kind: 'ide' })}
          onCloseRightPanel={() => {
            if (route.kind === 'detail') setRoute({ kind: 'list' });
          }}
          shellMode={shellMode}
          setShellMode={setShellMode}
        >
          {isMobile ? <MobileShell /> : <DesktopShell />}

          {/* RolesPage overlay — supported on both shells (responsive). `open`
              gates rendering, so it's safe to always mount. */}
          <RolesPage
            open={route.kind === 'roles'}
            onClose={() => setRoute({ kind: 'list' })}
          />

          {/* PluginsPage overlay — responsive, safe to always mount (gated by `open`). */}
          <PluginsPage
            open={route.kind === 'plugins'}
            onClose={() => setRoute({ kind: 'list' })}
          />

          {/* IDE overlay is desktop-only (the #/ide redirect keeps mobile off it). */}
          {!isMobile && route.kind === 'ide' && (
            <IdeOverlay onClose={() => setRoute({ kind: 'list' })} />
          )}
        </SwarmControllerProvider>
      </main>
    </div>
  );
}

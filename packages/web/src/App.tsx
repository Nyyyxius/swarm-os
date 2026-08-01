import { useEffect, useState } from 'react';
import DesktopShell from './components/desktop/DesktopShell';
import MobileShell from './components/mobile/MobileShell';
import { RolesPage } from './components/RolesPage';
import { MemoryPage } from './components/MemoryPage';
import { BoardPage } from './components/BoardPage';
import { PluginsPage } from './components/PluginsPage';
import IdeOverlay from './components/desktop/IdeOverlay';
import PluginPanelHost from './components/desktop/PluginPanelHost';
import { SwarmControllerProvider } from './controller/SwarmController';
import { useShellMode } from './hooks/useShellMode';

type Route =
  | { kind: 'list' }
  | { kind: 'detail'; id: string }
  | { kind: 'roles' }
  | { kind: 'memory' }
  | { kind: 'board' }
  | { kind: 'plugins' }
  | { kind: 'ide' }
  | { kind: 'panel'; plugin: string; panel: string };

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
  // Feature B.3 — plugin UI panel: `#/panel/<plugin>/<panelId>`.
  const p = /^#\/panel\/([a-z][a-z0-9-]{1,40})\/([a-z][a-z0-9-]*)$/.exec(h);
  if (p && p[1] && p[2]) return { kind: 'panel', plugin: p[1], panel: p[2] };
  if (h === '#/roles') return { kind: 'roles' };
  if (h === '#/memory') return { kind: 'memory' };
  if (h === '#/board') return { kind: 'board' };
  if (h === '#/plugins') return { kind: 'plugins' };
  if (h === '#/ide') return { kind: 'ide' };
  return { kind: 'list' };
}

function setHashRoute(route: Route): void {
  let target: string;
  if (route.kind === 'list') target = '#/';
  else if (route.kind === 'roles') target = '#/roles';
  else if (route.kind === 'memory') target = '#/memory';
  else if (route.kind === 'board') target = '#/board';
  else if (route.kind === 'plugins') target = '#/plugins';
  else if (route.kind === 'ide') target = '#/ide';
  else if (route.kind === 'panel') target = `#/panel/${route.plugin}/${route.panel}`;
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
          onOpenMemory={() => setRoute({ kind: 'memory' })}
          onOpenBoard={() => setRoute({ kind: 'board' })}
          onOpenPlugins={() => setRoute({ kind: 'plugins' })}
          onOpenIde={() => setRoute({ kind: 'ide' })}
          onOpenPanel={(plugin, panel) => setRoute({ kind: 'panel', plugin, panel })}
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

          {/* MemoryPage overlay — shared knowledge graph. Responsive, safe to
              always mount (gated by `open`), same pattern as RolesPage. */}
          <MemoryPage
            open={route.kind === 'memory'}
            onClose={() => setRoute({ kind: 'list' })}
          />

          {/* BoardPage overlay — durable task board (Kanban). Desktop-only,
              read-only for the web surface (Phase 4). */}
          <BoardPage
            open={route.kind === 'board'}
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

          {/* Plugin UI panel overlay (feature B.3) — responsive, mounted only
              while the panel route is active. */}
          {route.kind === 'panel' && (
            <PluginPanelHost
              pluginName={route.plugin}
              panelId={route.panel}
              onClose={() => setRoute({ kind: 'plugins' })}
            />
          )}
        </SwarmControllerProvider>
      </main>
    </div>
  );
}

import { useEffect, useState } from 'react';
import DesktopShell from './components/desktop/DesktopShell';
import MobileShell from './components/mobile/MobileShell';
import { RolesPage } from './components/RolesPage';
import { MemoryPage } from './components/MemoryPage';
import { BoardPage } from './components/BoardPage';
import { ApprovalsPage } from './components/ApprovalsPage';
import { MonitoringPage } from './components/MonitoringPage';
import { PluginsPage } from './components/PluginsPage';
import { SkillsPage } from './components/SkillsPage';
import { CronsPage } from './components/CronsPage';
import { CodeGraphPage } from './components/CodeGraphPage';
import IdeOverlay from './components/desktop/IdeOverlay';
import PluginPanelHost from './components/desktop/PluginPanelHost';
import { SwarmControllerProvider, useSwarmController } from './controller/SwarmController';
import { useShellMode } from './hooks/useShellMode';
import { type FeatureName } from './api/client';

type Route =
  | { kind: 'list' }
  | { kind: 'detail'; id: string }
  | { kind: 'roles' }
  | { kind: 'memory' }
  | { kind: 'board' }
  | { kind: 'approvals' }
  | { kind: 'monitoring' }
  | { kind: 'graph' }
  | { kind: 'plugins' }
  | { kind: 'skills' }
  /** `#/crons` (id null) or the deep link `#/crons/<cronId>`. */
  | { kind: 'crons'; id: string | null }
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
  // Cron deep link. The class MUST include `_`: ids are `cron_<8 hex>` (and
  // `cron_role_<roleId>` for the migrated ones), so the orchestrator route's
  // `[a-zA-Z0-9-]` would silently drop every one of them back to the list.
  const cr = /^#\/crons\/([a-zA-Z0-9_-]+)$/.exec(h);
  if (cr && cr[1]) return { kind: 'crons', id: cr[1] };
  if (h === '#/crons') return { kind: 'crons', id: null };
  if (h === '#/roles') return { kind: 'roles' };
  if (h === '#/memory') return { kind: 'memory' };
  if (h === '#/board') return { kind: 'board' };
  if (h === '#/approvals') return { kind: 'approvals' };
  if (h === '#/monitoring') return { kind: 'monitoring' };
  if (h === '#/graph') return { kind: 'graph' };
  if (h === '#/plugins') return { kind: 'plugins' };
  if (h === '#/skills') return { kind: 'skills' };
  if (h === '#/ide') return { kind: 'ide' };
  return { kind: 'list' };
}

function setHashRoute(route: Route): void {
  let target: string;
  if (route.kind === 'list') target = '#/';
  else if (route.kind === 'roles') target = '#/roles';
  else if (route.kind === 'memory') target = '#/memory';
  else if (route.kind === 'board') target = '#/board';
  else if (route.kind === 'approvals') target = '#/approvals';
  else if (route.kind === 'monitoring') target = '#/monitoring';
  else if (route.kind === 'graph') target = '#/graph';
  else if (route.kind === 'plugins') target = '#/plugins';
  else if (route.kind === 'skills') target = '#/skills';
  else if (route.kind === 'crons') target = route.id ? `#/crons/${route.id}` : '#/crons';
  else if (route.kind === 'ide') target = '#/ide';
  else if (route.kind === 'panel') target = `#/panel/${route.plugin}/${route.panel}`;
  else target = `#/orchestrators/${route.id}`;
  if (window.location.hash !== target) {
    window.location.hash = target;
  }
}

/**
 * Which built-in feature governs a route (docs/builtin-features.md). A route
 * absent from this map is never feature-gated (list/detail/roles/plugins/
 * skills/crons/panel). `graph` maps to `codegraph`.
 */
const ROUTE_FEATURE: Partial<Record<Route['kind'], FeatureName>> = {
  memory: 'memory',
  board: 'board',
  approvals: 'approvals',
  monitoring: 'monitoring',
  graph: 'codegraph',
  ide: 'ide',
};

interface RoutedOverlaysProps {
  route: Route;
  setRoute: (r: Route) => void;
  isMobile: boolean;
  cronsRoleFilter: string | null;
  setCronsRoleFilter: (r: string | null) => void;
}

/**
 * Shell + route overlays, rendered UNDER the controller so it can read the
 * built-in feature map. Two feature-driven behaviours live here (D10):
 *
 *   1. **Redirect** — a deep-linked route whose feature is KNOWN-disabled bounces
 *      back to the list (same idiom as the mobile-ide redirect in `App`).
 *   2. **Fetch gate** — a feature-gated overlay opens ONLY once the snapshot
 *      confirms the feature enabled. While `features` is `null` (unknown) the
 *      overlay stays closed, so NO page fetch fires on a deep-link before we
 *      know the feature is on — that is what avoids a `FEATURE_DISABLED` frame.
 */
function RoutedOverlays({
  route, setRoute, isMobile, cronsRoleFilter, setCronsRoleFilter,
}: RoutedOverlaysProps) {
  const { features } = useSwarmController();

  const routeFeature = ROUTE_FEATURE[route.kind];
  useEffect(() => {
    if (routeFeature && features && features[routeFeature] === false) {
      setRoute({ kind: 'list' });
    }
  }, [routeFeature, features, setRoute]);

  // Open a gated overlay only when the snapshot is known AND the feature is on.
  const gatedOpen = (kind: Route['kind'], feat: FeatureName): boolean =>
    route.kind === kind && features != null && features[feat] === true;

  return (
    <>
      {isMobile ? <MobileShell /> : <DesktopShell />}

      {/* RolesPage overlay — not feature-gated. Its APPROVALS section is hidden
          when the approvals feature is off (the server keeps accepting
          `approval_json` as an inert field). */}
      <RolesPage
        open={route.kind === 'roles'}
        onClose={() => setRoute({ kind: 'list' })}
        onOpenCrons={(roleId) => {
          setCronsRoleFilter(roleId);
          setRoute({ kind: 'crons', id: null });
        }}
        approvalsVisible={features?.approvals !== false}
      />

      <MemoryPage
        open={gatedOpen('memory', 'memory')}
        onClose={() => setRoute({ kind: 'list' })}
      />

      <BoardPage
        open={gatedOpen('board', 'board')}
        onClose={() => setRoute({ kind: 'list' })}
      />

      <ApprovalsPage
        open={gatedOpen('approvals', 'approvals')}
        onClose={() => setRoute({ kind: 'list' })}
      />

      <MonitoringPage
        open={gatedOpen('monitoring', 'monitoring')}
        onClose={() => setRoute({ kind: 'list' })}
      />

      {/* PluginsPage — not feature-gated (it is where features are managed). */}
      <PluginsPage
        open={route.kind === 'plugins'}
        onClose={() => setRoute({ kind: 'list' })}
      />

      <SkillsPage
        open={route.kind === 'skills'}
        onClose={() => setRoute({ kind: 'list' })}
      />

      <CodeGraphPage
        open={gatedOpen('graph', 'codegraph')}
        onClose={() => setRoute({ kind: 'list' })}
      />

      <CronsPage
        open={route.kind === 'crons'}
        cronId={route.kind === 'crons' ? route.id : null}
        roleFilter={cronsRoleFilter}
        onClearRoleFilter={() => setCronsRoleFilter(null)}
        onSelectCron={(id) => setRoute({ kind: 'crons', id })}
        onClose={() => setRoute({ kind: 'list' })}
      />

      {/* IDE overlay — desktop-only AND feature-gated. */}
      {!isMobile && gatedOpen('ide', 'ide') && (
        <IdeOverlay onClose={() => setRoute({ kind: 'list' })} />
      )}

      {/* Plugin UI panel overlay (feature B.3). */}
      {route.kind === 'panel' && (
        <PluginPanelHost
          pluginName={route.plugin}
          panelId={route.panel}
          onClose={() => setRoute({ kind: 'plugins' })}
        />
      )}
    </>
  );
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
  // Role filter of the crons screen. Deliberately NOT in the hash: the router
  // above compares hashes by strict equality, so `#/crons?role=x` would be
  // rewritten to `#/` on the next sync (docs/crons-agents.md §2.4).
  const [cronsRoleFilter, setCronsRoleFilter] = useState<string | null>(null);

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
          onOpenApprovals={() => setRoute({ kind: 'approvals' })}
          onOpenMonitoring={() => setRoute({ kind: 'monitoring' })}
          onOpenGraph={() => setRoute({ kind: 'graph' })}
          onOpenPlugins={() => setRoute({ kind: 'plugins' })}
          onOpenSkills={() => setRoute({ kind: 'skills' })}
          onOpenCrons={(roleId) => {
            setCronsRoleFilter(roleId ?? null);
            setRoute({ kind: 'crons', id: null });
          }}
          onOpenCron={(cronId) => {
            // Deep link from the RightPanel CONFIG tab. The role filter is
            // CLEARED, not inherited: a filter left over from an earlier visit
            // could hide the very cron this link selects.
            setCronsRoleFilter(null);
            setRoute({ kind: 'crons', id: cronId });
          }}
          onOpenIde={() => setRoute({ kind: 'ide' })}
          onOpenPanel={(plugin, panel) => setRoute({ kind: 'panel', plugin, panel })}
          onCloseRightPanel={() => {
            if (route.kind === 'detail') setRoute({ kind: 'list' });
          }}
          shellMode={shellMode}
          setShellMode={setShellMode}
        >
          {/* Shell + overlays live UNDER the provider so they can read the
              built-in feature map for redirect + fetch-gating (D10). */}
          <RoutedOverlays
            route={route}
            setRoute={setRoute}
            isMobile={isMobile}
            cronsRoleFilter={cronsRoleFilter}
            setCronsRoleFilter={setCronsRoleFilter}
          />
        </SwarmControllerProvider>
      </main>
    </div>
  );
}

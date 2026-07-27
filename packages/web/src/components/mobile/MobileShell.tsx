// packages/web/src/components/mobile/MobileShell.tsx
//
// Mobile shell — Slice 0 skeleton. Pure presentation: it consumes the
// lifted `useSwarmController()` (same single `useEvents` / orchestrators
// poll as the desktop) and renders an iOS-style shell. The prototype's
// `IOSDevice` bezel + viewport-scaling are dropped: on a real phone the
// device *is* the frame, so we fill the viewport.
//
// This slice wires the header + health strip + the auth surface (reusing
// the shared SettingsDrawer, which the controller auto-opens when the token
// is missing/invalid — guaranteeing no blank screen on a fresh phone).
// Monitoring (map / stats) lands in Slice 1, supervision (PTY console,
// actions) in Slice 2.
import './mobile.css';
import { useState } from 'react';
import MapView from '../desktop/MapView';
import SettingsDrawer from '../desktop/SettingsDrawer';
import StatsSheet from './StatsSheet';
import AgentSheet from './AgentSheet';
import MobileToasts from './MobileToasts';
import { NewOrchestratorDialog } from '../NewOrchestratorDialog';
import BroadcastModal from '../desktop/BroadcastModal';
import SpawnWorkerDialog from '../desktop/SpawnWorkerDialog';
import EditConfigDialog from '../desktop/EditConfigDialog';
import { useSwarmController } from '../../controller/SwarmController';
import type { TopBarTeam } from '../desktop/TopBar';

/**
 * Health-card visual bucket. Honest mapping over the real status/health
 * taxonomy (6 CSS buckets) rather than the prototype's 3 — `starting`,
 * `waiting`, `failed`, `bad`, `warn` each render distinctly so the strip
 * never lies about an agent's state.
 */
function cardStatus(t: TopBarTeam): { cls: string; label: string } {
  if (t.status === 'stopped') return { cls: 'stopped', label: 'OFF' };
  if (t.status === 'failed') return { cls: 'bad', label: 'FAIL' };
  if (t.hasWaiting) return { cls: 'waiting', label: 'WAIT' };
  if (t.status === 'starting') return { cls: 'starting', label: 'BOOT' };
  if (t.health === 'bad') return { cls: 'bad', label: 'BAD' };
  if (t.health === 'warn') return { cls: 'warn', label: 'DEG' };
  return { cls: 'ok', label: 'OK' };
}

function fmtCount(n: number): string {
  return n > 999 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export default function MobileShell() {
  const c = useSwarmController();
  const [statsOpen, setStatsOpen] = useState(false);

  const teams = c.topBarTeams;
  const runningTeams = teams.filter((t) => t.status === 'running').length;

  return (
    <div className="mobile-shell">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="m-header">
        <div className="m-brand">
          <span className="m-brand-mark" />
          <span>SWARM<span className="m-brand-dot">·</span>OS</span>
        </div>
        <div className="m-meta">
          <span>{runningTeams}/{teams.length} TEAMS</span>
          <span className="m-sep">·</span>
          <span className="m-meta-strong">{c.totalAgents} AGT</span>
          <button
            type="button"
            className="m-desktop-btn"
            onClick={() => c.setShellMode('desktop')}
            title="Switch to the desktop layout"
          >
            ⤢
          </button>
        </div>
      </header>

      {/* ── Health strip ───────────────────────────────────── */}
      <div className="m-health-scroll">
        {teams.length === 0 && (
          <div className="m-health-empty">No active teams</div>
        )}
        {teams.map((t) => {
          const s = cardStatus(t);
          const active = c.selectedTeamId === t.id;
          return (
            <button
              key={t.id}
              type="button"
              className={`m-health-card ${active ? 'active' : ''}`}
              onClick={() => t.leadId && c.handleSelectTeam(t.leadId)}
            >
              <div className="hc-row1">
                <span className="hc-name">{t.name}</span>
                <span className="hc-status">
                  <span className={`m-dot ${s.cls}`} />
                  {s.label}
                </span>
              </div>
              <div className="hc-row2">
                <span>{1 + t.workerCount} AGT</span>
                <span className="hc-msg">{fmtCount(t.msgCount)}</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* ── Content : real MapView (already touch/pinch/pan + responsive) ── */}
      <main className="m-content">
        <div className="m-map">
          <MapView
            teams={c.mapViewTeams}
            selectedId={c.selectedSessionId}
            onSelect={c.selectAgent}
            onBroadcast={() => c.setBroadcastOpen(true)}
            pulses={c.pulses}
            spawningIds={c.spawningIds}
          />
        </div>

        {/* Waiting-session toasts (actionable) — the heart of the mobile app. */}
        <MobileToasts />
      </main>

      {/* ── Dock ───────────────────────────────────────────── */}
      <nav className="m-dock">
        <button type="button" className="m-dock-btn" onClick={() => setStatsOpen(true)}>
          <span>STATS</span>
        </button>
        <button type="button" className="m-dock-btn" onClick={() => c.setShowNew(true)}>
          <span>+ TEAM</span>
        </button>
        <button type="button" className="m-dock-btn" onClick={() => c.onOpenRoles()}>
          <span>ROLES</span>
        </button>
        <button type="button" className="m-dock-btn" onClick={() => c.onOpenPlugins()}>
          <span>PLUGINS</span>
        </button>
        {/* Update badge, mirrored from the desktop TopBar: same `/info`-borne
            flag (`topBarInfo.updateAvailable`, same object as the version →
            same render), same destination. The dock has no room for a sixth
            slot on a phone, so the dot rides the SETTINGS button — which is
            where the update section lives anyway. */}
        <button
          type="button"
          className="m-dock-btn"
          onClick={() =>
            c.topBarInfo.updateAvailable ? c.openUpdates() : c.setSettingsOpen(true)
          }
          aria-label={
            c.topBarInfo.updateAvailable
              ? `Settings — update available${
                  c.topBarInfo.updateLatest ? `: version ${c.topBarInfo.updateLatest}` : ''
                }`
              : undefined
          }
        >
          {c.topBarInfo.updateAvailable && <span className="m-dot warn" />}
          <span>SETTINGS</span>
        </button>
      </nav>

      {/* ── Sheets ─────────────────────────────────────────── */}
      <StatsSheet open={statsOpen} onClose={() => setStatsOpen(false)} />
      <AgentSheet />

      {/* ── Control-plane dialogs (reused desktop modals) ──── */}
      <NewOrchestratorDialog
        open={c.showNew}
        onClose={() => c.setShowNew(false)}
        onCreate={c.handleCreateOrchestrator}
      />
      <BroadcastModal
        open={c.broadcastOpen}
        orchestrators={c.orchestrators}
        onClose={() => c.setBroadcastOpen(false)}
      />
      <SpawnWorkerDialog
        open={c.spawnFor !== null}
        team={c.spawnFor}
        roles={c.roles}
        onClose={() => c.setSpawnFor(null)}
        onSpawn={c.handleSpawnWorkerSubmit}
      />
      <EditConfigDialog
        open={c.editConfigFor !== null}
        team={c.editConfigFor}
        onClose={() => c.setEditConfigFor(null)}
      />

      {/* ── Auth / settings (shared drawer; auto-opens on bad token) ── */}
      {c.settingsOpen && (
        <SettingsDrawer
          info={c.info}
          health={c.health}
          authState={c.authState}
          wsConnected={c.eventsConnected}
          onClose={() => c.setSettingsOpen(false)}
          onTokenSaved={() => { void c.probeAuth(); }}
          onTokenCleared={c.setAuthMissing}
          shellMode={c.shellMode}
          setShellMode={c.setShellMode}
          focusUpdates={c.updatesFocus}
        />
      )}
    </div>
  );
}

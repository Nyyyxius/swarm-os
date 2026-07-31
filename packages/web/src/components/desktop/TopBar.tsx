// packages/web/src/components/desktop/TopBar.tsx
import { useEffect, useState } from 'react';
import { ICON } from './icons';
import { formatClock, formatMsgCount, formatUptimeShort } from '../../lib/format';
import { useInstanceSettings } from '../../hooks/useInstanceSettings';

/** Forme attendue par la TopBar pour chaque team-pill. */
export interface TopBarTeam {
  id: string;
  name: string;
  purpose: string;
  leadId: string;
  workerCount: number;
  msgCount: number;
  status: string;          // OrchestratorStatus
  health: 'ok' | 'warn' | 'bad' | 'stopped';
  /** true si une session de la team est en `waiting`. */
  hasWaiting?: boolean;
}

/**
 * Sub-line live affichée sous le brand.
 *
 * `startedAt` (ISO string ou null) est passé brut depuis `DesktopShell` ;
 * la TopBar le formate à chaque tick local (cf. §6 de
 * `docs/redesign-desktop/04_topbar-data-binding.md`). Cela évite de
 * re-render le `DesktopShell` à chaque seconde.
 */
export interface TopBarInfo {
  projectName: string;
  version: string;
  startedAt: string | null;
  /**
   * A newer release exists (and was not dismissed). Carried HERE, in the same
   * object as `version`, on purpose: both come from the same `/info` payload
   * and the same `setInfo`, so the badge and the version string can never
   * paint one render apart. On a cold server the badge is simply absent, then
   * appears at the next 60 s tick — never a flash.
   */
  updateAvailable?: boolean;
  /** Version of that release (`0.6.0`), for the badge tooltip. */
  updateLatest?: string | null;
}

interface Props {
  teams: readonly TopBarTeam[];
  selectedTeamId?: string | null;
  /** Step 19 — set of team ids currently flashing (.flash-new). Migrated
   *  from `flashTeamId: string | null` to allow N simultaneous flashes
   *  when teams are created in bursts (multi-tab / seed scripts). */
  flashTeamIds?: ReadonlySet<string>;
  totalAgents: number;
  info: TopBarInfo;
  onSelectTeam: (sessionId: string) => void;
  onNewTeam: () => void;
  onOpenRoles: () => void;
  /** Open the shared memory / knowledge-graph overlay (`#/memory`). Optional so
   *  older call sites (and the badge-focused unit test) keep type-checking. */
  onOpenMemory?: () => void;
  onOpenPlugins: () => void;
  /** Open the VS Code web IDE on the deployment workspace (fullscreen overlay). */
  onOpenIde: () => void;
  onOpenSettings: () => void;
  /** Open SETTINGS on the SYSTEM UPDATE section (update badge). */
  onOpenUpdates: () => void;
}

const EMPTY_FLASH_SET: ReadonlySet<string> = new Set();

export default function TopBar({
  teams, selectedTeamId, flashTeamIds, totalAgents, info,
  onSelectTeam, onNewTeam, onOpenRoles, onOpenMemory, onOpenPlugins, onOpenIde, onOpenSettings,
  onOpenUpdates,
}: Props) {
  const flashSet = flashTeamIds ?? EMPTY_FLASH_SET;
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const i = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(i);
  }, []);
  // Per-instance label — the whole point of the APPEARANCE feature: spot
  // which swarm-os instance is in this tab without reading the URL. Click
  // jumps straight back into the panel to change it.
  const { settings: instanceSettings } = useInstanceSettings();

  // L'uptime est recalculé à chaque tick : le re-render déclenché par
  // `setNow(...)` ré-évalue `formatUptimeShort` qui lit `Date.now()`.
  // `now` est par ailleurs consommé directement par `formatClock(now)`
  // dans le `tb-clock` ci-dessous (donc pas "unused").
  const uptime = formatUptimeShort(info.startedAt);

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" />
        <div className="brand-text">
          SWARM<span style={{ color: 'var(--amber)' }}>·</span>OS
          <div className="sub">
            <b>{info.projectName}</b> · {info.version} · {uptime} up
          </div>
        </div>
        {instanceSettings.instanceLabel && (
          <button
            type="button"
            className="instance-pill"
            onClick={onOpenSettings}
            title="instance label — click to edit"
          >
            {instanceSettings.instanceLabel}
          </button>
        )}
      </div>

      <div className="health-strip">
        {teams.map((t) => {
          const offline = t.health === 'stopped';
          const starting = t.status === 'starting';
          const cls = offline ? 'stopped'
            : t.health === 'warn' ? 'warn'
            : t.health === 'bad'  ? 'bad'
            : 'ok';
          let dotCls: string;
          let label: string;
          if (offline)             { dotCls = 'stopped';  label = 'OFFLINE'; }
          else if (t.hasWaiting)   { dotCls = 'waiting';  label = 'WAITING'; }
          else if (starting)       { dotCls = 'starting'; label = 'STARTING'; }
          else if (t.health === 'warn') { dotCls = 'warn'; label = 'DEGRADED'; }
          else                     { dotCls = 'ok';       label = 'HEALTHY'; }
          const barPct = offline ? 0 : Math.round((t.health === 'warn' ? 0.6 : 0.85) * 100);
          const msgLabel = formatMsgCount(t.msgCount);
          return (
            <div
              key={t.id}
              className={`team-pill ${selectedTeamId === t.id ? 'active' : ''} ${flashSet.has(t.id) ? 'flash-new' : ''}`}
              onClick={() => onSelectTeam(t.leadId)}
              title={`${t.name} — ${t.purpose}`}
            >
              <div className="pill-head">
                <span className="pill-name">
                  {t.name}
                  {t.hasWaiting && (
                    <span className="waiting-flag"
                      title="agent waiting for human input">●</span>
                  )}
                </span>
                <span className="pill-status">
                  <span className={`dot ${dotCls}`} />
                  {label}
                </span>
              </div>
              <div className="pill-body">
                <span className="pill-meta">{1 + t.workerCount} agt</span>
                <div className="pill-bar">
                  <i className={t.hasWaiting ? 'waiting' : cls}
                    style={{ width: `${barPct}%` }} />
                </div>
                <span className="pill-meta">{msgLabel} msg</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="topbar-right">
        <button className="tb-action primary" onClick={onNewTeam}
          title="create new orchestrator">
          {ICON.plus}<span className="label">NEW TEAM</span>
        </button>
        <button className="tb-action" onClick={onOpenRoles} title="manage roles">
          {ICON.template}<span className="label">ROLES</span>
        </button>
        <button className="tb-action" onClick={() => onOpenMemory?.()} title="shared memory / knowledge graph">
          {ICON.fork}<span className="label">MEMORY</span>
        </button>
        <button className="tb-action" onClick={onOpenPlugins} title="manage plugins">
          {ICON.link}<span className="label">PLUGINS</span>
        </button>
        <button className="tb-action" onClick={onOpenIde} title="open workspace IDE (VS Code)">
          {ICON.code}<span className="label">IDE</span>
        </button>
        {/* Update badge — rendered ONLY when there is something to act on
            (`info.updateAvailable`, same object as `info.version` above, so
            same render). A permanently mounted button would be one more piece
            of chrome opening a drawer the cog already opens. */}
        {info.updateAvailable && (
          <button
            className="tb-action"
            onClick={onOpenUpdates}
            title={
              info.updateLatest
                ? `swarm-os v${info.updateLatest} is available — open SETTINGS`
                : 'a new swarm-os version is available — open SETTINGS'
            }
            aria-label={
              info.updateLatest
                ? `Update available: version ${info.updateLatest}`
                : 'Update available'
            }
          >
            {ICON.reload}
            <span className="dot warn" />
            <span className="label">UPDATE</span>
          </button>
        )}
        <button className="tb-action" onClick={onOpenSettings} title="settings / token">
          {ICON.cog}
        </button>
        <div className="tb-clock">
          <span className="agents">{totalAgents} AGENTS</span>
          <span className="agents-sep">·</span>
          <span className="clock">{formatClock(now)}</span>
        </div>
      </div>
    </header>
  );
}

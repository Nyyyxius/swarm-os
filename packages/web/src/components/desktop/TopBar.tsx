// packages/web/src/components/desktop/TopBar.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { ICON } from './icons';
import CommandLauncher, { type LauncherActionId } from './CommandLauncher';
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
  /** Open the durable task board (Kanban) overlay (`#/board`). Optional for
   *  backward compatibility with existing call sites. */
  onOpenBoard?: () => void;
  /** Open the approval-gate queue + history overlay (`#/approvals`). Optional for
   *  backward compatibility with existing call sites. */
  onOpenApprovals?: () => void;
  /** Open the code knowledge graph overlay (`#/graph`). Optional for
   *  backward compatibility with existing call sites. */
  onOpenGraph?: () => void;
  onOpenPlugins: () => void;
  /** Open the skills library management overlay (`#/skills`). */
  onOpenSkills?: () => void;
  /** Open the VS Code web IDE on the deployment workspace (fullscreen overlay). */
  onOpenIde: () => void;
  onOpenSettings: () => void;
  /** Open SETTINGS on the SYSTEM UPDATE section (update badge). */
  onOpenUpdates: () => void;
  /** Open SETTINGS scrollé sur la section APPEARANCE (item du launcher). */
  onOpenAppearance?: () => void;
  /** Vrai quand une modale (couche z-index 100) est ouverte : ⌘K doit rester
   *  inerte, sinon le panneau se monte derrière elle. */
  menuBlocked?: boolean;
}

const EMPTY_FLASH_SET: ReadonlySet<string> = new Set();

export default function TopBar({
  teams, selectedTeamId, flashTeamIds, totalAgents, info,
  onSelectTeam, onNewTeam, onOpenRoles, onOpenMemory, onOpenBoard, onOpenApprovals, onOpenGraph, onOpenPlugins, onOpenSkills, onOpenIde, onOpenSettings,
  onOpenUpdates, onOpenAppearance, menuBlocked,
}: Props) {
  const flashSet = flashTeamIds ?? EMPTY_FLASH_SET;
  const [now, setNow] = useState(new Date());
  // Step 20 — la rangée de destinations a été remplacée par un panneau ⌘K.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  // Stabilisés : la TopBar se re-rend chaque seconde (horloge), et ces deux
  // callbacks sont dans les deps du listener ⌘K du panneau — en version
  // inline, il serait démonté/remonté à chaque tick.
  const openMenu = useCallback(() => setMenuOpen(true), []);
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    // Le panneau démonte l'élément focalisé : sans ça le focus retombe sur
    // <body> et l'opérateur au clavier repart du haut du document.
    menuRef.current?.focus();
  }, []);
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

  // Routage du panneau. Le `switch` est exhaustif sur `LauncherActionId` :
  // un id ajouté à la table du launcher casse la compilation tant qu'il
  // n'est pas routé ici (idiome maison, cf. `lib/sessionStatus.ts`).
  function handlePick(id: LauncherActionId) {
    setMenuOpen(false);
    switch (id) {
      case 'new-team':   onNewTeam(); return;
      case 'roles':      onOpenRoles(); return;
      case 'memory':     onOpenMemory?.(); return;
      case 'board':      onOpenBoard?.(); return;
      case 'approvals':  onOpenApprovals?.(); return;
      case 'code-graph': onOpenGraph?.(); return;
      case 'skills':     onOpenSkills?.(); return;
      case 'plugins':    onOpenPlugins(); return;
      case 'ide':        onOpenIde(); return;
      case 'update':     onOpenUpdates(); return;
      case 'settings':   onOpenSettings(); return;
      case 'appearance': onOpenAppearance?.(); return;
    }
    const _exhaustive: never = id;
    return _exhaustive;
  }

  return (
    <>
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
        {/* Toutes les destinations vivent maintenant dans le panneau ⌘K. La
            pastille update migre ici : le signal doit survivre sans ouvrir le
            menu, et `info.updateAvailable` vient du MÊME objet que
            `info.version` peint dans le brand → jamais un render d'écart. */}
        <button
          ref={menuRef}
          type="button"
          className={`tb-action ${menuOpen ? 'primary' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
          title={
            info.updateAvailable
              ? `open menu (⌘K) — ${info.updateLatest ? `swarm-os v${info.updateLatest} is available` : 'a new version is available'}`
              : 'open menu (⌘K)'
          }
          aria-label={
            info.updateAvailable
              ? (info.updateLatest
                  ? `MENU — update available: version ${info.updateLatest}`
                  : 'MENU — update available')
              : 'MENU'
          }
        >
          {ICON.menu}
          {info.updateAvailable && <span className="dot warn" />}
          <span className="label">MENU</span>
        </button>
        <div className="tb-clock">
          <span className="agents">{totalAgents} AGENTS</span>
          <span className="agents-sep">·</span>
          <span className="clock">{formatClock(now)}</span>
        </div>
      </div>
    </header>

    <CommandLauncher
      open={menuOpen}
      blocked={menuBlocked}
      onOpen={openMenu}
      onClose={closeMenu}
      onPick={handlePick}
      updateAvailable={info.updateAvailable}
      updateLatest={info.updateLatest}
    />
    </>
  );
}

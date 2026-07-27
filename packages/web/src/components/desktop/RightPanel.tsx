// packages/web/src/components/desktop/RightPanel.tsx
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ICON } from './icons';
import ConfigTab, { type ConfigTabTeam } from './ConfigTab';
import Composer, { type ComposerAudience, type ComposerMode } from './Composer';
import ConfirmModal, { type ConfirmModalVariant } from './ConfirmModal';
import ConsoleOverlay from './ConsoleOverlay';
import { Terminal } from '../Terminal';
import {
  formatUptime, formatClockShort, formatRelative,
  statusChipClass, statusLabel,
} from '../../lib/format';
import { formatLoadPercent } from '../../lib/loadPercent';

/** Action déclenchable depuis le panneau droit. */
export type AgentAction =
  | 'stop' | 'start' | 'pause' | 'resume' | 'kill' | 'restart'
  /** Soft-delete a terminal session/team from the map. */
  | 'remove';

/** Forme partielle d'un agent (session) attendue par le RightPanel. */
export interface RightPanelAgent {
  id: string;
  name: string;
  role: string;
  status: string;          // SessionStatus
  pid: number | null;
  startedAt: string | number | null;
  lastActivityAt: string | number | null;
  /** load (0..1) — pour l'instant `undefined` ; affichera "—" via formatLoadPercent. */
  load?: number;
  /** Compteur log lines (xterm gérera plus tard). */
  logLines?: number;
  /** WRITER/READER pip — dérivé du hello frame WS dans Terminal.tsx. */
  writer?: boolean;
  /** Step 7 — propagé à ConfigTab pour la section EXIT REASON. */
  exitCode?: number | null;
  stopReason?: string | null;
  lastError?: string | null;
  /**
   * Multi-provider Lot 3 — the adapter driving THIS agent
   * (`SessionView.provider`). Shown as a chip next to the role because in a
   * mixed team it may differ from `RightPanelTeam.provider`, and knowing which
   * CLI you are looking at changes how you read the console.
   */
  provider?: string;
}

/** Forme partielle d'un team (orchestrator) attendue. */
export interface RightPanelTeam extends ConfigTabTeam {
  id: string;
  name: string;
  leadId: string;
  workerCount: number;
  discordWebhook?: string | null;
  /** Multi-provider Lot 3 — the team's default adapter (`defaultProvider`). */
  provider?: string;
  /**
   * Phase 8 — auto-resume audit. Drives the "Resumed N×" chip in the
   * header so operators can spot restart loops.
   */
  resumeCount?: number;
  lastResumedAt?: string | null;
}

/** Bulle dans la tab MESSAGES. */
export interface MessageBubble {
  from: 'me' | 'them' | 'system' | 'other-team';
  who: string;             // libellé affiché
  text: string;
  ts?: string | number;
  via?: string;
}

export type RightPanelTab = 'console' | 'chat' | 'config';

interface Props {
  selected: RightPanelAgent | null;
  team: RightPanelTeam | null;
  isLead: boolean;
  /** Bulles classifiées (Step 7). */
  messages: readonly MessageBubble[];
  /** Tab active (lift to parent pour persister entre re-mounts). */
  activeTab: RightPanelTab;
  setActiveTab: (t: RightPanelTab) => void;
  onClose: () => void;
  onAction: (agentId: string, action: AgentAction) => void;
  onSend: (
    agentId: string,
    text: string,
    opts: { mode: ComposerMode; audience: ComposerAudience },
  ) => void;
  onSpawnWorker: (team: RightPanelTeam) => void;
  onEditConfig: (team: RightPanelTeam) => void;
  /** Step 7 — callbacks Terminal.tsx → DesktopShell pour writer + logLines. */
  onTerminalRoleChange?: (role: 'writer' | 'reader') => void;
  onTerminalDataFrame?: () => void;
}

export default function RightPanel({
  selected, team, isLead, messages,
  activeTab, setActiveTab,
  onClose, onAction, onSend, onSpawnWorker, onEditConfig,
  onTerminalRoleChange, onTerminalDataFrame,
}: Props) {
  const consoleRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState('');
  const [composerMode, setComposerMode] = useState<ComposerMode>('pty');
  const [audience, setAudience] = useState<ComposerAudience>('agent');
  const [enlarged, setEnlarged] = useState(false);
  const [confirm, setConfirm] = useState<
    { action: AgentAction; label: string; body: string; cls: ConfirmModalVariant } | null
  >(null);

  useEffect(() => {
    setDraft('');
    setComposerMode('pty');
    setAudience('agent');
    setEnlarged(false);        // close the fullscreen console when switching agents.
    setConfirm(null);          // Step 14, défensif : ferme une modale orpheline.
  }, [selected?.id]);

  useEffect(() => {
    if (consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [selected?.id, activeTab]);

  const isClosed = !selected || !team;

  function doSend() {
    const txt = draft.trim();
    if (!txt || !selected) return;
    onSend(selected.id, txt, { mode: composerMode, audience });
    setDraft('');
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      doSend();
    }
  }

  function askConfirm(action: AgentAction) {
    if (!selected || !team) return;
    if (action === 'kill') {
      setConfirm({
        action,
        label: isLead ? 'KILL TEAM' : 'KILL WORKER',
        body: isLead
          ? `KILL ${selected.name} will terminate the whole ${team.name} team (lead + ${team.workerCount} workers) AND remove it from the map. This cannot be undone.`
          : `KILL ${selected.name} will terminate this worker AND remove it from the map. Use STOP instead if you want to keep the row visible.`,
        cls: 'danger',
      });
      return;
    }
    if (action === 'stop') {
      setConfirm({
        action,
        label: isLead ? 'STOP TEAM' : 'STOP WORKER',
        body: isLead
          ? team.workerCount > 0
            ? `STOP ${selected.name} will gracefully shut down the entire ${team.name} team and its ${team.workerCount} ${team.workerCount === 1 ? 'worker' : 'workers'}.`
            : `STOP ${selected.name} will gracefully shut down the ${team.name} team (no workers attached).`
          : `STOP ${selected.name} will gracefully shut down this worker.`,
        cls: 'danger',
      });
      return;
    }
    if (action === 'remove') {
      setConfirm({
        action,
        label: isLead ? 'REMOVE TEAM' : 'REMOVE WORKER',
        body: isLead
          ? `REMOVE ${selected.name} will permanently hide the ${team.name} team and all its sessions from the map. This cannot be undone.`
          : `REMOVE ${selected.name} will permanently hide this worker from the map. This cannot be undone.`,
        cls: 'danger',
      });
      return;
    }
    // Toute autre action passe directement (PAUSE, RESTART, RESUME, etc.).
    onAction(selected.id, action);
  }

  // Step 18 — unique <aside> qui reste monté pour permettre la transition CSS
  // (translateX 280ms). Quand isClosed, on rend l'empty state ; sinon le
  // contenu complet. Le wrapper n'est jamais swappé, donc React n'arrache
  // pas le DOM node et la transition s'applique.
  return (
    <aside
      className={`panel-right${isClosed ? ' closed' : ''}`}
      aria-hidden={isClosed}
    >
      {isClosed || !selected || !team
        ? renderEmpty()
        : renderFull(selected, team)}
    </aside>
  );

  function renderEmpty() {
    return (
      <div className="pr-empty">
        <div className="pr-empty-inner">no agent selected</div>
      </div>
    );
  }

  function renderFull(selected: RightPanelAgent, team: RightPanelTeam) {
    const status = selected.status;
    const stopped =
      status === 'exited' || status === 'killed' ||
      status === 'interrupted' || status === 'stopped';
    const isFailed = status === 'failed';
    const isPaused = status === 'paused';
    // Soft-delete from the map is allowed for the three terminal statuses
    // explicitly chosen by the user; `interrupted` is not removable (it is
    // a transient SVR-RESTART state).
    const removable =
      status === 'killed' || status === 'exited' || status === 'failed';
    const writer = selected.writer !== false;
    const hasDiscord = !!team.discordWebhook;

    return (
      <>
        <div className="pr-head">
        <div className="pr-top">
          <div>
            <div className="pr-id">
              {team.name} :: {isLead ? 'LEAD' : 'WORKER'} :: {selected.id.toUpperCase()}
            </div>
          </div>
          <div className="pr-top-actions">
            {activeTab === 'console' && !stopped && !isFailed && (
              <button className="pr-enlarge"
                onClick={() => setEnlarged(true)}
                title="enlarge console (fullscreen)">{ICON.expand}</button>
            )}
            <button className="pr-close" onClick={onClose} title="close">×</button>
          </div>
        </div>
        <div className="pr-name">
          {selected.name}
          {isLead && <span className="badge">LEAD</span>}
          <span style={{ flex: 1 }} />
          <span className={`chip ${statusChipClass(status)}`}>
            <span className={`dot ${statusChipClass(status)}`} />
            {statusLabel(status)}
          </span>
          {activeTab === 'console' && !stopped && !isFailed && (
            <span className={`chip ${writer ? 'writer' : 'reader'}`}
              title={writer
                ? 'PTY writer — keystrokes will reach the agent'
                : 'PTY reader — passive view, no writes'}>
              <span className={`dot ${writer ? 'ok' : 'stopped'}`} />
              {writer ? 'WRITER' : 'READER'}
            </span>
          )}
        </div>
        <div className="pr-role">
          <span>{selected.role}</span>
          {/* Provider chip — same chrome as the DISCORD / RESUMED chips. Marked
              when this agent diverges from its team's default, which is exactly
              the case a mixed team creates. */}
          {selected.provider && (
            <span
              className="discord-chip"
              title={
                team.provider && team.provider !== selected.provider
                  ? `agent runs on ${selected.provider}; team default is ${team.provider}`
                  : `agent provider: ${selected.provider}`
              }
              style={
                team.provider && team.provider !== selected.provider
                  ? { color: 'var(--warn)', borderColor: 'var(--warn)' }
                  : undefined
              }
            >
              ⬡ {selected.provider.toUpperCase()}
              {team.provider && team.provider !== selected.provider ? ' ·MIXED' : ''}
            </span>
          )}
          {hasDiscord && (
            <span className="discord-chip" title={team.discordWebhook ?? ''}>◇ DISCORD</span>
          )}
          {team.resumeCount !== undefined && team.resumeCount > 0 && (
            <span
              className="discord-chip"
              title={
                team.lastResumedAt
                  ? `last resumed ${formatRelative(team.lastResumedAt)} (${team.lastResumedAt})`
                  : 'team was auto-resumed at least once'
              }
              style={{ color: 'var(--warn)', borderColor: 'var(--warn)' }}
            >
              ↻ RESUMED {team.resumeCount}×
            </span>
          )}
        </div>

        <div className="pr-cfgline">
          <span className="lbl">M</span>
          <span>{team.model.replace('claude-', '')}</span>
          <span className="sep">·</span>
          <span className="lbl">E</span>
          <span>{team.effort}</span>
          <span className="sep">·</span>
          <span className="lbl">P</span>
          <span style={{
            color: team.permissionMode === 'bypassPermissions' ? 'var(--warn)' : 'inherit',
          }}>{team.permissionMode}</span>
          <button className="edit"
            title="rotate model / effort / permission (v2 preview)"
            onClick={() => onEditConfig(team)}>
            {ICON.pencil}
          </button>
        </div>

        <div className="pr-cwd" title="workspace-relative path">
          <span className="lbl">CWD ::</span> {team.cwd}
        </div>

        <div className="pr-stats">
          <div className="pr-stat">
            <div className="v">
              {stopped ? '—' : formatLoadPercent(selected.load)}
            </div>
            <div className="k">LOAD</div>
          </div>
          <div className="pr-stat">
            <div className="v">{stopped ? '—' : formatUptime(selected.startedAt)}</div>
            <div className="k">UPTIME</div>
          </div>
          <div className="pr-stat">
            <div className="v">{(selected.logLines ?? 0).toLocaleString()}</div>
            <div className="k">LOG LINES</div>
          </div>
        </div>

        <div className="pr-meta">
          <span><b>pid</b>={selected.pid ?? '—'}</span>
          <span className="sep">·</span>
          <span>
            <b>started</b>={selected.startedAt ? formatClockShort(selected.startedAt) : '—'}
          </span>
          <span className="sep">·</span>
          <span>
            <b>last_activity</b>=
            {selected.lastActivityAt ? formatRelative(selected.lastActivityAt) : '—'}
          </span>
        </div>
      </div>

      <div className="pr-actions">
        {isPaused ? (
          <button className="pr-action go"
            onClick={() => onAction(selected.id, 'resume')}>
            {ICON.start}<span>RESUME</span>
          </button>
        ) : (
          <button className="pr-action"
            disabled={stopped || isFailed}
            onClick={() => onAction(selected.id, 'pause')}>
            {ICON.pause}<span>PAUSE</span>
          </button>
        )}
        <button className="pr-action primary"
          /* Lead: restart the whole team in place — enabled only when the team
             is terminal. Worker: S5 single-session restart while running. */
          disabled={isLead ? !(stopped || isFailed) : (stopped || isFailed)}
          title={isLead ? 'restart this team in place (same id/config)' : 'restart this worker'}
          onClick={() => onAction(selected.id, 'restart')}>
          {ICON.reload}<span>RESTART</span>
        </button>
        {removable ? (
          <button className="pr-action danger"
            title={isLead
              ? 'remove this team from the map (soft delete)'
              : 'remove this worker from the map (soft delete)'}
            onClick={() => askConfirm('remove')}>
            {ICON.kill}<span>REMOVE</span>
          </button>
        ) : (stopped || isFailed) ? (
          <button className="pr-action go"
            title="relaunch this team in place (same id/config)"
            onClick={() => onAction(selected.id, 'start')}>
            {ICON.start}<span>REACTIVATE</span>
          </button>
        ) : (
          <button className="pr-action danger" onClick={() => askConfirm('stop')}>
            {ICON.stop}<span>STOP</span>
          </button>
        )}
        <button className="pr-action danger" onClick={() => askConfirm('kill')}>
          {ICON.kill}<span>KILL</span>
        </button>
        <button className="pr-action primary"
          disabled={!isLead || stopped || isFailed}
          onClick={() => onSpawnWorker(team)}
          title={isLead ? 'spawn a worker in this team' : 'lead-only action'}>
          {ICON.fork}<span>+ WORKER</span>
        </button>
      </div>

      <div className="pr-tabs">
        <button className={`pr-tab ${activeTab === 'console' ? 'active' : ''}`}
          onClick={() => setActiveTab('console')}>CONSOLE</button>
        <button className={`pr-tab ${activeTab === 'chat' ? 'active' : ''}`}
          onClick={() => setActiveTab('chat')}>MESSAGES</button>
        <button className={`pr-tab ${activeTab === 'config' ? 'active' : ''}`}
          onClick={() => setActiveTab('config')}>CONFIG</button>
      </div>

      <div className="pr-body">
        {activeTab === 'console' && (
          <div className="console" ref={consoleRef}>
            {stopped || isFailed ? (
              <div style={{ color: 'var(--text-mute)', padding: '8px 0' }}>
                {isFailed
                  ? '— agent failed — see EXIT REASON in CONFIG tab —'
                  : '— agent stopped, no log output —'}
              </div>
            ) : enlarged ? (
              // The single live Terminal moves into the fullscreen overlay so it
              // keeps the PTY writer role (one writer per session). See ConsoleOverlay.
              <div style={{ color: 'var(--text-mute)', padding: '8px 0' }}>
                — console opened in fullscreen —
              </div>
            ) : (
              <Terminal
                sessionId={selected.id}
                onRoleChange={onTerminalRoleChange}
                onDataFrame={onTerminalDataFrame}
                hideChrome
              />
            )}
          </div>
        )}

        {activeTab === 'chat' && (
          <div className="messages">
            {messages.length === 0 && (
              <div style={{
                color: 'var(--text-mute)', textAlign: 'center', marginTop: 30,
                fontFamily: 'Geist Mono, monospace', fontSize: 11, letterSpacing: '0.10em',
              }}>
                {stopped ? '— agent stopped —' : '— no messages yet —'}
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`bubble ${m.from === 'me' ? 'me' : 'them'}`}>
                <div className="who">
                  {m.who}
                  {m.via && <span style={{ marginLeft: 8, color: 'var(--text-mute)' }}>· via {m.via}</span>}
                </div>
                <div>{m.text}</div>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'config' && (
          <ConfigTab
            team={team}
            agent={selected}
            isLead={isLead}
            onEdit={() => onEditConfig(team)}
          />
        )}

        {activeTab !== 'config' && (
          <Composer
            selectedName={selected.name}
            teamName={team.name}
            isLead={isLead}
            stopped={stopped || isFailed}
            draft={draft}
            setDraft={setDraft}
            onKey={onKey}
            onSend={doSend}
            composerMode={composerMode}
            setComposerMode={setComposerMode}
            audience={audience}
            setAudience={setAudience}
          />
        )}
      </div>

        {confirm && (
          <ConfirmModal
            label={confirm.label}
            body={confirm.body}
            cls={confirm.cls}
            onCancel={() => setConfirm(null)}
            onConfirm={() => {
              onAction(selected.id, confirm.action);
              setConfirm(null);
            }}
          />
        )}

        {enlarged && activeTab === 'console' && !stopped && !isFailed && (
          <ConsoleOverlay
            sessionId={selected.id}
            onClose={() => setEnlarged(false)}
            onRoleChange={onTerminalRoleChange}
            onDataFrame={onTerminalDataFrame}
            title={selected.name}
            headerExtra={
              <>
                <span className={`chip ${statusChipClass(status)}`}>
                  <span className={`dot ${statusChipClass(status)}`} />
                  {statusLabel(status)}
                </span>
                <span className={`chip ${writer ? 'writer' : 'reader'}`}>
                  <span className={`dot ${writer ? 'ok' : 'stopped'}`} />
                  {writer ? 'WRITER' : 'READER'}
                </span>
              </>
            }
          >
            <Composer
              selectedName={selected.name}
              teamName={team.name}
              isLead={isLead}
              stopped={stopped || isFailed}
              draft={draft}
              setDraft={setDraft}
              onKey={onKey}
              onSend={doSend}
              composerMode={composerMode}
              setComposerMode={setComposerMode}
              audience={audience}
              setAudience={setAudience}
            />
          </ConsoleOverlay>
        )}
      </>
    );
  }
}

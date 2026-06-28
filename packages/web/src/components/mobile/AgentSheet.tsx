// packages/web/src/components/mobile/AgentSheet.tsx
//
// Mobile agent detail sheet — Slice 2 (supervision). Mirrors the desktop
// RightPanel's behaviour exactly: same 7-action matrix + lead/worker gating
// (routed through controller.onAction), same ConfirmModal on destructive
// actions, same live PTY console (writer) via the shared Terminal, same
// Composer (audience × mode, AGENT+MAILBOX disabled). It is pure
// presentation over `useSwarmController()`.
//
// PTY note: the Terminal is mounted ONLY while the sheet is open AND the
// CONSOLE tab is active AND the session is live — so FitAddon never sizes a
// hidden (zero-dim) container, and the single writer role is claimed only
// when the console is actually visible. Enlarge moves the SAME session into
// ConsoleOverlay (one writer per session).
import { useEffect, useState, type KeyboardEvent } from 'react';
import Sheet from './Sheet';
import Composer, { type ComposerAudience, type ComposerMode } from '../desktop/Composer';
import ConfirmModal, { type ConfirmModalVariant } from '../desktop/ConfirmModal';
import ConsoleOverlay from '../desktop/ConsoleOverlay';
import ConfigTab from '../desktop/ConfigTab';
import { Terminal } from '../Terminal';
import {
  statusChipClass, statusLabel, formatUptime, formatClockShort, formatRelative,
} from '../../lib/format';
import { formatLoadPercent } from '../../lib/loadPercent';
import { useSwarmController } from '../../controller/SwarmController';
import type { AgentAction, RightPanelAgent, RightPanelTeam } from '../desktop/RightPanel';

type Tab = 'console' | 'chat' | 'config';

export default function AgentSheet() {
  const c = useSwarmController();
  const selected = c.selectedAgent;
  const team = c.selectedTeam;
  const isLead = c.isLead;
  const open = c.panelOpen;

  const [draft, setDraft] = useState('');
  const [composerMode, setComposerMode] = useState<ComposerMode>('pty');
  const [audience, setAudience] = useState<ComposerAudience>('agent');
  const [enlarged, setEnlarged] = useState(false);
  const [tab, setTab] = useState<Tab>('console');
  const [confirm, setConfirm] = useState<
    { action: AgentAction; label: string; body: string; cls: ConfirmModalVariant } | null
  >(null);

  useEffect(() => {
    setDraft('');
    setComposerMode('pty');
    setAudience('agent');
    setEnlarged(false);
    setConfirm(null);
    setTab('console');
  }, [selected?.id]);

  function doSend() {
    const txt = draft.trim();
    if (!txt || !selected) return;
    c.onSend(selected.id, txt, { mode: composerMode, audience });
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
          ? `KILL ${selected.name} terminates the whole ${team.name} team (lead + ${team.workerCount} workers) AND removes it from the map. Cannot be undone.`
          : `KILL ${selected.name} terminates this worker AND removes it from the map.`,
        cls: 'danger',
      });
      return;
    }
    if (action === 'stop') {
      setConfirm({
        action,
        label: isLead ? 'STOP TEAM' : 'STOP WORKER',
        body: isLead
          ? `STOP ${selected.name} gracefully shuts down the entire ${team.name} team${team.workerCount > 0 ? ` and its ${team.workerCount} worker(s)` : ''}.`
          : `STOP ${selected.name} gracefully shuts down this worker.`,
        cls: 'danger',
      });
      return;
    }
    if (action === 'remove') {
      setConfirm({
        action,
        label: isLead ? 'REMOVE TEAM' : 'REMOVE WORKER',
        body: isLead
          ? `REMOVE ${selected.name} permanently hides the ${team.name} team and all its sessions from the map.`
          : `REMOVE ${selected.name} permanently hides this worker from the map.`,
        cls: 'danger',
      });
      return;
    }
    void c.onAction(selected.id, action);
  }

  return (
    <Sheet open={open} onClose={c.closeRightPanel}>
      {selected && team ? renderBody(selected, team) : null}
    </Sheet>
  );

  function renderBody(selected: RightPanelAgent, team: RightPanelTeam) {
    const status = selected.status;
    const stopped =
      status === 'exited' || status === 'killed' ||
      status === 'interrupted' || status === 'stopped';
    const isFailed = status === 'failed';
    const isPaused = status === 'paused';
    const removable = status === 'killed' || status === 'exited' || status === 'failed';
    const writer = selected.writer !== false;
    const hasDiscord = !!team.discordWebhook;
    const showTerminal = tab === 'console' && !stopped && !isFailed && !enlarged && open;

    return (
      <>
        <div className="m-sheet-head">
          <div className="m-sheet-title-row">
            <span className="m-sheet-id">{team.name} :: {isLead ? 'LEAD' : 'WORKER'}</span>
            <button className="m-sheet-close" onClick={c.closeRightPanel} aria-label="close">×</button>
          </div>
          <div className="m-as-name">
            <span className="m-as-name-txt">{selected.name}</span>
            {isLead && <span className="badge">LEAD</span>}
            <span className="m-spacer" />
            <span className={`chip ${statusChipClass(status)}`}>
              <span className={`dot ${statusChipClass(status)}`} />
              {statusLabel(status)}
            </span>
            {tab === 'console' && !stopped && !isFailed && (
              <span className={`chip ${writer ? 'writer' : 'reader'}`}>
                <span className={`dot ${writer ? 'ok' : 'stopped'}`} />
                {writer ? 'WRITER' : 'READER'}
              </span>
            )}
          </div>
          <div className="m-as-role">
            <span>{selected.role}</span>
            {hasDiscord && <span className="discord-chip">◇ DISCORD</span>}
            {team.resumeCount !== undefined && team.resumeCount > 0 && (
              <span
                className="discord-chip"
                style={{ color: 'var(--warn)', borderColor: 'var(--warn)' }}
                title={team.lastResumedAt ? `last resumed ${formatRelative(team.lastResumedAt)}` : undefined}
              >
                ↻ RESUMED {team.resumeCount}×
              </span>
            )}
          </div>

          <div className="m-as-cfg">
            <span className="m-as-cfg-lbl">M</span><span>{team.model.replace('claude-', '')}</span>
            <span className="m-as-cfg-sep">·</span>
            <span className="m-as-cfg-lbl">E</span><span>{team.effort}</span>
            <span className="m-as-cfg-sep">·</span>
            <span className="m-as-cfg-lbl">P</span>
            <span style={{ color: team.permissionMode === 'bypassPermissions' ? 'var(--warn)' : 'inherit' }}>
              {team.permissionMode}
            </span>
            <button
              type="button"
              className="m-as-edit"
              title="rotate model / effort / permission (v2 preview)"
              onClick={() => c.handleEditConfig(team)}
            >✎</button>
          </div>
          <div className="m-as-cwd"><span className="m-as-cfg-lbl">CWD ::</span> {team.cwd}</div>

          <div className="m-as-stats">
            <div className="m-as-stat">
              <div className="v">{stopped ? '—' : formatLoadPercent(selected.load)}</div>
              <div className="k">LOAD</div>
            </div>
            <div className="m-as-stat">
              <div className="v">{stopped ? '—' : formatUptime(selected.startedAt)}</div>
              <div className="k">UPTIME</div>
            </div>
            <div className="m-as-stat">
              <div className="v">{(selected.logLines ?? 0).toLocaleString()}</div>
              <div className="k">LOG LINES</div>
            </div>
          </div>

          <div className="m-as-meta">
            <span><b>pid</b>={selected.pid ?? '—'}</span>
            <span className="m-as-cfg-sep">·</span>
            <span><b>started</b>={selected.startedAt ? formatClockShort(selected.startedAt) : '—'}</span>
            <span className="m-as-cfg-sep">·</span>
            <span><b>act</b>={selected.lastActivityAt ? formatRelative(selected.lastActivityAt) : '—'}</span>
          </div>
        </div>

        {/* ── Action bar (mirrors RightPanel's 7-action matrix) ── */}
        <div className="m-as-actions">
          {isPaused ? (
            <button className="m-as-action go" onClick={() => void c.onAction(selected.id, 'resume')}>RESUME</button>
          ) : (
            <button className="m-as-action" disabled={stopped || isFailed} onClick={() => void c.onAction(selected.id, 'pause')}>PAUSE</button>
          )}
          <button
            className="m-as-action primary"
            disabled={isLead ? !(stopped || isFailed) : (stopped || isFailed)}
            onClick={() => void c.onAction(selected.id, 'restart')}
          >RESTART</button>
          {removable ? (
            <button className="m-as-action danger" onClick={() => askConfirm('remove')}>REMOVE</button>
          ) : (stopped || isFailed) ? (
            <button className="m-as-action go" onClick={() => void c.onAction(selected.id, 'start')}>REACTIVATE</button>
          ) : (
            <button className="m-as-action danger" onClick={() => askConfirm('stop')}>STOP</button>
          )}
          <button className="m-as-action danger" onClick={() => askConfirm('kill')}>KILL</button>
          {isLead && (
            <button
              className="m-as-action primary"
              disabled={stopped || isFailed}
              onClick={() => c.handleSpawnWorker(team)}
              title="spawn worker (v2 preview)"
            >+ WORKER</button>
          )}
        </div>

        {/* ── Tabs ── */}
        <div className="m-as-tabs">
          <button className={`m-as-tab ${tab === 'console' ? 'active' : ''}`} onClick={() => setTab('console')}>CONSOLE</button>
          <button className={`m-as-tab ${tab === 'chat' ? 'active' : ''}`} onClick={() => setTab('chat')}>MESSAGES</button>
          <button className={`m-as-tab ${tab === 'config' ? 'active' : ''}`} onClick={() => setTab('config')}>CONFIG</button>
          {tab === 'console' && !stopped && !isFailed && (
            <button className="m-as-enlarge" onClick={() => setEnlarged(true)} title="fullscreen console">⤢</button>
          )}
        </div>

        <div className="m-sheet-body m-as-body">
          {tab === 'console' && (
            <div className="m-console">
              {stopped || isFailed ? (
                <div className="m-console-empty">
                  {isFailed ? '— agent failed —' : '— agent stopped, no log output —'}
                </div>
              ) : enlarged ? (
                <div className="m-console-empty">— console opened in fullscreen —</div>
              ) : showTerminal ? (
                <Terminal
                  key={selected.id}
                  sessionId={selected.id}
                  onRoleChange={c.onTerminalRoleChange}
                  onDataFrame={c.onTerminalDataFrame}
                  hideChrome
                />
              ) : null}
            </div>
          )}

          {tab === 'config' && (
            <ConfigTab
              team={team}
              agent={selected}
              isLead={isLead}
              onEdit={() => c.handleEditConfig(team)}
            />
          )}

          {tab === 'chat' && (
            <div className="m-messages">
              {c.messages.length === 0 && (
                <div className="m-console-empty" style={{ textAlign: 'center', marginTop: 24 }}>
                  {stopped ? '— agent stopped —' : '— no messages yet —'}
                </div>
              )}
              {c.messages.map((m, i) => (
                <div key={i} className={`m-bubble ${m.from === 'me' ? 'me' : 'them'}`}>
                  <div className="m-bubble-who">
                    {m.who}
                    {m.via && <span className="m-bubble-via">· via {m.via}</span>}
                  </div>
                  <div>{m.text}</div>
                </div>
              ))}
            </div>
          )}

          {tab !== 'config' && (
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
              void c.onAction(selected.id, confirm.action);
              setConfirm(null);
            }}
          />
        )}

        {enlarged && tab === 'console' && !stopped && !isFailed && (
          <ConsoleOverlay
            sessionId={selected.id}
            onClose={() => setEnlarged(false)}
            onRoleChange={c.onTerminalRoleChange}
            onDataFrame={c.onTerminalDataFrame}
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

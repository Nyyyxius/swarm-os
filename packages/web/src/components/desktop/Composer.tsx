// packages/web/src/components/desktop/Composer.tsx
import type { KeyboardEvent } from 'react';

export type ComposerMode = 'pty' | 'mailbox';
export type ComposerAudience = 'agent' | 'team';

interface Props {
  selectedName: string;
  teamName: string;
  isLead: boolean;
  stopped: boolean;
  draft: string;
  setDraft: (v: string) => void;
  onKey: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  composerMode: ComposerMode;
  setComposerMode: (m: ComposerMode) => void;
  audience: ComposerAudience;
  setAudience: (a: ComposerAudience) => void;
}

export default function Composer({
  selectedName, teamName, isLead, stopped,
  draft, setDraft, onKey, onSend,
  composerMode, setComposerMode,
  audience, setAudience,
}: Props) {
  // Step 7 — gap §4-5 : AGENT+INBOX is disabled v1 (no /sessions/:id/mail
  // endpoint). The button is disabled when audience is AGENT, and we
  // compute an `effectiveMode` that defensively falls back to PTY in
  // case the parent state still holds 'mailbox' from a previous TEAM
  // session. The wire dispatch in DesktopShell.onSend ALSO bails on
  // AGENT/MAILBOX, so this is purely a UX consistency safety-net.
  const inboxDisabled = audience === 'agent';
  const effectiveMode: ComposerMode =
    inboxDisabled && composerMode === 'mailbox' ? 'pty' : composerMode;

  const helper = effectiveMode === 'mailbox'
    ? "MAILBOX :: queued in agent inbox · agent gets 'you have mail' signal on next idle"
    : 'PTY :: bytes written direct to terminal · unblocks an agent waiting on input';
  const teamHelper = audience === 'team'
    ? "Audience: every active session of this team will receive your message as from='human'."
    : 'Audience: this single session only.';

  return (
    <div className="composer">
      <div className="composer-toolbar">
        <div className="composer-toggles">
          <div className="seg" role="group" aria-label="composer mode">
            <button
              className={effectiveMode === 'pty' ? 'on' : ''}
              onClick={() => setComposerMode('pty')}
              title="write to PTY (raw keystrokes)"
            >→ PTY</button>
            <button
              className={effectiveMode === 'mailbox' ? 'on' : ''}
              onClick={() => !inboxDisabled && setComposerMode('mailbox')}
              disabled={inboxDisabled}
              title={inboxDisabled
                ? 'AGENT mailbox available in v2 (gap §4-5) — use TEAM audience to broadcast via mailbox'
                : 'enqueue in mailbox (you-have-mail signal)'}
            >→ INBOX</button>
          </div>
          {isLead && (
            <div className="seg" role="group" aria-label="audience">
              <button
                className={audience === 'agent' ? 'on' : ''}
                onClick={() => setAudience('agent')}
                title="single session"
              >AGENT</button>
              <button
                className={audience === 'team' ? 'on' : ''}
                onClick={() => setAudience('team')}
                title="broadcast to team"
              >TEAM</button>
            </div>
          )}
        </div>
        <span style={{ color: 'var(--text-mute)' }}>⌘+↵ to send</span>
      </div>

      <div className="composer-row">
        <span className={`send-target ${audience === 'team' ? 'broadcast' : ''}`}>
          {audience === 'team' ? 'BROADCAST' : 'CHANNEL'} <span className="arrow">→</span>{' '}
          {audience === 'team' ? `ALL OF ${teamName}` : selectedName}
          <span style={{ color: 'var(--text-mute)', marginLeft: 8 }}>
            :: {effectiveMode === 'pty' ? 'PTY' : 'MAILBOX'}
          </span>
        </span>
      </div>

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        className={effectiveMode === 'mailbox' ? 'mailbox' : ''}
        placeholder={
          stopped
            ? 'agent stopped — reactivate to send'
            : audience === 'team'
              ? 'compose broadcast directive to the entire team…'
              : effectiveMode === 'mailbox'
                ? 'compose mailbox message (agent will be notified on next idle)…'
                : 'compose PTY input (sent as raw keystrokes)…'
        }
        disabled={stopped}
      />
      <div className="composer-helper">
        {helper}
        {isLead && <div style={{ marginTop: 2 }}>{teamHelper}</div>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          className="send-btn"
          disabled={stopped || !draft.trim()}
          onClick={onSend}
        >
          {audience === 'team' ? 'BROADCAST →' : 'SEND →'}
        </button>
      </div>
    </div>
  );
}

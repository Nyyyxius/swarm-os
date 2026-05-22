// packages/web/src/components/desktop/ConfigTab.tsx
import { formatClockShort } from '../../lib/format';

/** Forme partielle d'un team/orch nécessaire pour la tab CONFIG. */
export interface ConfigTabTeam {
  model: string;
  effort: string;
  permissionMode: string;
  cwd: string;
  leadPrompt: string | null;
  leadPreamble: string | null;
  workerPreamble: string | null;
  discordWebhook?: string | null;
}

/** Forme partielle d'un agent (session). */
export interface ConfigTabAgent {
  pid: number | null;
  startedAt: string | number | null;
  status: string;
  exitCode?: number | null;
  /** Step 7 — `interrupted` / `server-restart` etc. when status terminal. */
  stopReason?: string | null;
  /** Step 7 — surfaced as ERROR line when status === 'failed'. */
  lastError?: string | null;
}

interface Props {
  team: ConfigTabTeam;
  agent: ConfigTabAgent;
  isLead: boolean;
  onEdit: () => void;
}

export default function ConfigTab({ team, agent, isLead: _isLead, onEdit }: Props) {
  // Step 7 — harmonisé avec RightPanel.stopped (5 terminal statuses).
  const stopped =
    agent.status === 'exited' ||
    agent.status === 'killed' ||
    agent.status === 'interrupted' ||
    agent.status === 'stopped' ||
    agent.status === 'failed';

  return (
    <div className="cfg">
      <div className="cfg-section">
        <div className="cfg-h">
          <span>RUNTIME CONFIG</span>
          <button className="h-edit" onClick={onEdit}>EDIT</button>
        </div>
        <div className="cfg-kv">
          <span className="k">MODEL</span><span className="v">{team.model}</span>
          <span className="k">EFFORT</span><span className="v">{team.effort}</span>
          <span className="k">PERMISSION</span>
          <span className="v" style={{
            color: team.permissionMode === 'bypassPermissions' ? 'var(--warn)' : 'var(--text)',
          }}>
            {team.permissionMode}
            {team.permissionMode === 'bypassPermissions' && (
              <span style={{ marginLeft: 8, color: 'var(--text-mute)' }}>
                // danger: agent runs unattended
              </span>
            )}
          </span>
          <span className="k">CWD</span><span className="v">{team.cwd}</span>
          <span className="k">PID</span><span className="v">{agent.pid ?? '—'}</span>
          <span className="k">STARTED</span>
          <span className="v">
            {agent.startedAt ? formatClockShort(agent.startedAt) : '—'}
          </span>
          {stopped && (
            <>
              <span className="k">EXIT REASON</span>
              <span className="v" style={{
                color: agent.status === 'failed' ? 'var(--bad)' : 'var(--text-dim)',
              }}>
                {agent.status.toUpperCase()}
                {agent.exitCode != null && ` :: code=${agent.exitCode}`}
                {agent.stopReason && ` · ${agent.stopReason}`}
              </span>
              {agent.lastError && (
                <>
                  <span className="k">ERROR</span>
                  <span className="v" style={{
                    color: 'var(--bad)', whiteSpace: 'pre-wrap',
                  }}>
                    {agent.lastError}
                  </span>
                </>
              )}
            </>
          )}
        </div>
      </div>

      <div className="cfg-section">
        <div className="cfg-h"><span>LEAD PROMPT</span></div>
        <div className="cfg-pre">{team.leadPrompt ?? '— (none) —'}</div>
      </div>

      <div className="cfg-section">
        <div className="cfg-h"><span>LEAD PREAMBLE</span></div>
        <div className="cfg-pre">{team.leadPreamble ?? '— (none) —'}</div>
      </div>

      <div className="cfg-section">
        <div className="cfg-h"><span>WORKER PREAMBLE</span></div>
        <div className="cfg-pre">{team.workerPreamble ?? '— (none) —'}</div>
      </div>

      <div className="cfg-section">
        <div className="cfg-h"><span>CONNECTORS</span></div>
        {team.discordWebhook ? (
          <div className="cfg-kv">
            <span className="k">DISCORD</span>
            <span className="v" style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
              <span className="discord-chip" style={{
                fontSize: 8.5, padding: '1px 6px',
                border: '1px solid rgba(255,176,96,0.4)',
                color: 'var(--amber)', letterSpacing: '0.14em',
              }}>ENABLED</span>
              <span style={{ color: 'var(--text-mute)', fontSize: 10 }}>
                {team.discordWebhook.length > 40
                  ? `${team.discordWebhook.slice(0, 38)}…`
                  : team.discordWebhook}
              </span>
            </span>
          </div>
        ) : (
          <div className="field-help">
            No connectors configured for this role. Edit the role to add a Discord webhook.
          </div>
        )}
      </div>
    </div>
  );
}

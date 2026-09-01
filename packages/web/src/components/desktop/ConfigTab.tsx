// packages/web/src/components/desktop/ConfigTab.tsx
import { formatClockShort, formatCronWhen } from '../../lib/format';

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

/**
 * Forme partielle d'un cron (docs/crons-agents.md §2.4) — sous-ensemble
 * structurel de `CronView` (api/client.ts), suivant la convention de ce
 * fichier : la tab CONFIG déclare ce qu'elle lit, pas la vue serveur entière.
 */
export interface ConfigTabCron {
  id: string;
  name: string;
  /** 5-field expression, displayed verbatim. */
  schedule: string;
  action: 'message' | 'script';
  /**
   * Read off the ARMED server-side job — `null` when the cron is paused or
   * cadence is disabled instance-wide. Never recomputed here: a browser-side
   * `new Cron(expr)` would evaluate in the viewer's timezone.
   */
  nextRun: string | null;
  paused: boolean;
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
  /**
   * Cadences of the team's role, already filtered by the controller. Empty
   * (or absent) hides the whole section — see the CRONS block below.
   */
  crons?: readonly ConfigTabCron[];
  /** Deep-link one cron (`#/crons/<id>`). Absent → rows are not clickable. */
  onOpenCron?: (cronId: string) => void;
}

export default function ConfigTab({
  team, agent, isLead: _isLead, onEdit, crons, onOpenCron,
}: Props) {
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

      {/* CRONS — the detailed list the `pr-crons` header line summarises
          (docs/crons-agents.md §2.4). The section is HIDDEN, not emptied, when
          the team has no cadence: a free-form-role team can hold none at all,
          and an empty "— (none) —" row would add a permanent line of noise to
          a tab most operators open to read the runtime config. The header line
          obeys the same rule, so the two never disagree. */}
      {crons && crons.length > 0 && (
        <div className="cfg-section">
          <div className="cfg-h"><span>CRONS</span></div>
          {/* `cfg-kv` is a 2-column grid, so one cron = two sibling cells
              (name | detail) — not a wrapper div, which would break the grid. */}
          <div className="cfg-kv">
            {crons.flatMap((c) => {
              const open = onOpenCron ? () => onOpenCron(c.id) : undefined;
              const clickable = open ? { cursor: 'pointer' } : {};
              return [
                <span
                  key={`${c.id}-k`}
                  className="k"
                  style={clickable}
                  onClick={open}
                  title={open ? `open ${c.name} in the CRONS screen` : undefined}
                >
                  {c.name.toUpperCase()}
                </span>,
                <span
                  key={`${c.id}-v`}
                  className="v"
                  style={{
                    display: 'inline-flex', gap: 8, alignItems: 'center',
                    flexWrap: 'wrap', ...clickable,
                  }}
                  onClick={open}
                >
                  <span style={{ fontFamily: '"Geist Mono", monospace' }}>{c.schedule}</span>
                  <span className={`tag-pill${c.action === 'script' ? ' script' : ''}`}>
                    {c.action.toUpperCase()}
                  </span>
                  {c.paused ? (
                    <span className="tag-pill paused">PAUSED</span>
                  ) : (
                    <span style={{ color: 'var(--amber)', fontSize: 10 }}>
                      NEXT {formatCronWhen(c.nextRun)}
                    </span>
                  )}
                </span>,
              ];
            })}
          </div>
        </div>
      )}
    </div>
  );
}

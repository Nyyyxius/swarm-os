// packages/web/src/components/desktop/Node.tsx
import NodeShape from './NodeShape';
import type { Shape } from '../../lib/roleShape';
import type { NodePosition } from './layoutTeams';

/** Forme minimale d'un agent pour rendre un Node — sera satisfaite par
 * SessionView (+ shape dérivé via `shapeForRole(session.role)`). */
export interface NodeAgent {
  id: string;
  name: string;
  role: string;
  shape: Shape;
  status: string;
  inbox?: number;
  /**
   * Multi-provider Lot 3 — the adapter driving this agent (`SessionView.provider`).
   * Rendered as a dim suffix on the role line so a mixed team (claude lead,
   * codex workers) is readable straight off the map instead of requiring a
   * click into the right panel. `undefined` on a server that predates Lot 2.
   */
  provider?: string;
}

interface Props {
  agent: NodeAgent;
  pos: NodePosition;
  isLead?: boolean;
  selected?: boolean;
  spawning?: boolean;
  onClick: (agent: NodeAgent) => void;
  onHover?: (agent: NodeAgent | null, pos: NodePosition | null) => void;
}

function statusDotColor(status: string): string {
  if (status === 'running')  return '#6ec48a';
  if (status === 'warn')     return '#e8b04a';
  if (status === 'waiting')  return '#ffb060';
  if (status === 'idle')     return '#b6a48b';
  if (status === 'starting') return '#d98a3a';
  if (status === 'failed')   return '#e0654a';
  if (
    status === 'stopped' || status === 'exited' ||
    status === 'killed'  || status === 'interrupted'
  ) return '#5a4d3f';
  return '#b6a48b';
}

function ringClass(status: string, isLead: boolean, selected: boolean): string {
  let cls = 'node-ring';
  if (isLead) cls += ' lead';
  if (selected) cls += ' selected';
  if (status === 'stopped' || status === 'exited' || status === 'killed') cls += ' stopped';
  if (status === 'failed') cls += ' failed';
  if (status === 'starting') cls += ' starting';
  if (status === 'interrupted') cls += ' interrupted';
  return cls;
}

export default function Node({
  agent, pos, isLead = false, selected = false, spawning = false,
  onClick, onHover,
}: Props) {
  const r = isLead ? 26 : 20;
  const status = agent.status;
  const stopped =
    status === 'stopped' || status === 'exited' ||
    status === 'killed'  || status === 'interrupted';
  const waiting = status === 'waiting';
  const failed = status === 'failed';
  const inboxCount = agent.inbox ?? 0;

  return (
    <g
      className={`node ${spawning ? 'spawning' : ''}`}
      transform={`translate(${pos.x}, ${pos.y})`}
      onClick={(e) => { e.stopPropagation(); onClick(agent); }}
      onMouseEnter={() => onHover?.(agent, pos)}
      onMouseLeave={() => onHover?.(null, null)}
    >
      <circle
        className={`node-glow ${isLead ? 'lead' : ''} ${stopped ? 'stopped' : ''} ${waiting ? 'waiting' : ''} ${failed ? 'failed' : ''}`}
        r={r + 8}
      />
      {waiting && <circle className="node-ring-pulse" r={r + 5} />}
      <circle className={ringClass(status, isLead, selected)} r={r} />
      <NodeShape shape={agent.shape} r={r} stopped={stopped} />
      <circle
        className="node-status-dot"
        cx={r * 0.78} cy={-r * 0.78} r={2.6}
        fill={statusDotColor(status)}
      />
      {inboxCount > 0 && (
        <g>
          <circle className="node-inbox-bg" cx={-r * 0.82} cy={-r * 0.82} r={6} />
          <text className="node-inbox-txt" x={-r * 0.82} y={-r * 0.82 + 2.6}>
            {inboxCount > 9 ? '9+' : inboxCount}
          </text>
        </g>
      )}
      <text className="node-label" y={r + 16}>{agent.name}</text>
      <text className="node-role" y={r + 28}>
        {agent.role}
        {agent.provider && (
          <tspan className="node-provider">{` · ${agent.provider.toUpperCase()}`}</tspan>
        )}
      </text>
      {status === 'interrupted' && (
        <text className="node-svr-restart" y={r + 40}>·· SVR-RESTART ··</text>
      )}
      {status === 'starting' && (
        <text className="node-svr-restart" y={r + 40}>·· STARTING ··</text>
      )}
    </g>
  );
}

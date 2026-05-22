// packages/web/src/components/desktop/layoutTeams.ts

export const VBW = 1200;
export const VBH = 900;
export const CENTER: { x: number; y: number } = { x: VBW / 2, y: VBH / 2 };
export const LEAD_RADIUS = 320;
export const WORKER_RADIUS = 150;
export const WORKER_SPREAD = 1.55;

/** Forme minimale exigée par `layoutTeams`. Sera satisfaite plus tard par un
 * adapter `OrchestratorView` → `MapTeam` (Step 6). */
export interface MapAgent {
  id: string;
}

export interface MapTeam {
  id: string;
  angle: number;
  lead: MapAgent;
  workers: MapAgent[];
}

export interface NodePosition {
  x: number;
  y: number;
  teamId: string;
  leadId?: string;
}

export function layoutTeams(teams: readonly MapTeam[]): Record<string, NodePosition> {
  const positions: Record<string, NodePosition> = {};
  teams.forEach((team) => {
    const lx = CENTER.x + Math.cos(team.angle) * LEAD_RADIUS;
    const ly = CENTER.y + Math.sin(team.angle) * LEAD_RADIUS;
    positions[team.lead.id] = { x: lx, y: ly, teamId: team.id };
    const n = team.workers.length;
    team.workers.forEach((w, i) => {
      const outward = team.angle;
      const offset = n === 1 ? 0 : (i / (n - 1) - 0.5) * WORKER_SPREAD;
      const a = outward + offset;
      const wx = lx + Math.cos(a) * WORKER_RADIUS;
      const wy = ly + Math.sin(a) * WORKER_RADIUS;
      positions[w.id] = { x: wx, y: wy, teamId: team.id, leadId: team.lead.id };
    });
  });
  return positions;
}

// packages/web/src/lib/roleShape.ts
// Mapping figé role → forme SVG du node sur la MapView. Cf.
// docs/ui-redesign-desktop.md §1.3.

export type Shape =
  | 'diamond'
  | 'diamondS'
  | 'triangle'
  | 'square'
  | 'dot'
  | 'halfmoon'
  | 'circle';

export const ROLE_SHAPE: Record<string, Shape> = {
  ORCHESTRATOR: 'diamond',
  RESEARCHER: 'circle',
  BUILDER: 'triangle',
  CRITIC: 'diamondS',
  ANALYST: 'halfmoon',
  MEMORY: 'dot',
  TOOLS: 'square',
};

export function shapeForRole(role: string): Shape {
  return ROLE_SHAPE[role] ?? 'circle';
}

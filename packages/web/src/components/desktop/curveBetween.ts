// packages/web/src/components/desktop/curveBetween.ts

export interface Point {
  x: number;
  y: number;
}

/**
 * Renvoie un attribut SVG `d` pour une courbe quadratique de Bézier reliant
 * `a` à `b`, avec contrôle perpendiculaire à `curve` × longueur.
 *
 * Utilisé pour les edges (lead-link / team / intra) et les `offsetPath` des
 * pulses sur la MapView.
 */
export function curveBetween(a: Point, b: Point, curve = 0.16): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const nx = -dy;
  const ny = dx;
  const len = Math.sqrt(nx * nx + ny * ny) || 1;
  const cx = mx + (nx / len) * curve * Math.sqrt(dx * dx + dy * dy);
  const cy = my + (ny / len) * curve * Math.sqrt(dx * dx + dy * dy);
  return `M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`;
}

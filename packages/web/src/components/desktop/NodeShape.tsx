// packages/web/src/components/desktop/NodeShape.tsx
import type { Shape } from '../../lib/roleShape';

interface Props {
  shape: Shape;
  r: number;
  stopped?: boolean;
}

export default function NodeShape({ shape, r, stopped = false }: Props) {
  const fill = stopped ? '#3a3128' : '#f3e9dc';
  const s = r * 0.55;
  if (shape === 'diamond') {
    return (
      <rect className="node-shape" x={-s / 1.4} y={-s / 1.4}
        width={s * 1.4} height={s * 1.4} fill={fill} transform="rotate(45)" />
    );
  }
  if (shape === 'diamondS') {
    return (
      <rect className="node-shape" x={-s / 1.8} y={-s / 1.8}
        width={s * 1.1} height={s * 1.1} fill="none" stroke={fill}
        strokeWidth="1" transform="rotate(45)" />
    );
  }
  if (shape === 'triangle') {
    const p = s * 0.95;
    return (
      <polygon className="node-shape"
        points={`0,${-p} ${p * 0.866},${p * 0.5} ${-p * 0.866},${p * 0.5}`}
        fill={fill} />
    );
  }
  if (shape === 'square') {
    return (
      <rect className="node-shape" x={-s * 0.7} y={-s * 0.7}
        width={s * 1.4} height={s * 1.4} fill={fill} />
    );
  }
  if (shape === 'dot') {
    return <circle className="node-shape" r={s * 0.55} fill={fill} />;
  }
  if (shape === 'halfmoon') {
    return (
      <g>
        <circle className="node-shape" r={s * 0.8} fill="none"
          stroke={fill} strokeWidth="1" />
        <path className="node-shape"
          d={`M 0,${-s * 0.8} A ${s * 0.8} ${s * 0.8} 0 0 1 0,${s * 0.8} Z`}
          fill={fill} />
      </g>
    );
  }
  // fallback "circle"
  return <circle r={s * 0.6} fill={fill} />;
}

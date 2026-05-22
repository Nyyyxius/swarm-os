// packages/web/src/components/desktop/Sparkline.tsx

interface Props {
  values: readonly number[];
  color?: string;
  strokeOpacity?: number;
  fillOpacity?: number;
  height?: number;
}

export default function Sparkline({
  values, color = 'var(--amber)',
  strokeOpacity = 0.9, fillOpacity = 0.12, height = 16,
}: Props) {
  if (!values || values.length === 0) return null;
  const w = 100;
  const h = height;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const pts = values.map<[number, number]>((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return [x, y];
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  const area = `${line} L ${w} ${h} L 0 ${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={area} fill={color} opacity={fillOpacity} />
      <path d={line} fill="none" stroke={color}
        strokeOpacity={strokeOpacity} strokeWidth="1"
        vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

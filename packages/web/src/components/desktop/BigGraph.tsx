// packages/web/src/components/desktop/BigGraph.tsx

interface Props {
  data: readonly number[];
}

export default function BigGraph({ data }: Props) {
  const w = 100;
  const h = 100;
  if (!data.length) return null;
  const max = Math.max(...data, 1);
  const pts = data.map<[number, number]>((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - (v / max) * h;
    return [x, y];
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  const area = `${line} L ${w} ${h} L 0 ${h} Z`;
  const last = pts[pts.length - 1];

  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none"
      style={{ width: '100%', height: '100%' }}>
      <defs>
        <linearGradient id="bg-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   style={{ stopColor: 'var(--amber)', stopOpacity: 0.4 }} />
          <stop offset="100%" style={{ stopColor: 'var(--amber)', stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      {[25, 50, 75].map((y) => (
        <line key={y} x1="0" y1={y} x2={w} y2={y}
          stroke="rgba(255, 200, 140, 0.06)" strokeWidth="0.4"
          vectorEffect="non-scaling-stroke" />
      ))}
      <path d={area} fill="url(#bg-fill)" />
      <path d={line} fill="none" style={{ stroke: 'var(--amber)' }}
        strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
      {last && (
        <circle cx={last[0]} cy={last[1]} r="1.5"
          style={{ fill: 'var(--amber)' }} />
      )}
    </svg>
  );
}

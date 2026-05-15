interface Props {
  status: string;
}

const COLORS: Record<string, string> = {
  starting: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  running: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  waiting: 'bg-yellow-500/20 text-yellow-200 border-yellow-500/40',
  stopping: 'bg-orange-500/20 text-orange-300 border-orange-500/40',
  stopped: 'bg-slate-500/20 text-slate-300 border-slate-500/40',
  exited: 'bg-slate-500/20 text-slate-300 border-slate-500/40',
  killed: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  failed: 'bg-red-500/20 text-red-300 border-red-500/40',
  interrupted: 'bg-purple-500/20 text-purple-300 border-purple-500/40',
};

export function StatusBadge({ status }: Props) {
  const cls = COLORS[status] ?? 'bg-slate-700/30 text-slate-300 border-slate-600/40';
  return (
    <span className={`inline-block text-xs font-mono px-2 py-0.5 rounded border ${cls}`}>
      {status}
    </span>
  );
}

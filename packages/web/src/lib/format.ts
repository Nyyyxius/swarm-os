// packages/web/src/lib/format.ts
// Helpers de formatage portés du prototype v2.

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/**
 * Format "HH:MM:SS" d'un uptime depuis un timestamp ms ou ISO string.
 * Renvoie "—" si invalide.
 *
 * `now` est injectable pour permettre aux consommateurs branchés sur
 * `useNow(1000)` de re-rendre déterministiquement à chaque seconde sans
 * dépendre de l'horloge réelle au moment de la fonction (et pour faciliter
 * les tests). Défaut : `Date.now()` (rétrocompat avec les anciens callers).
 */
export function formatUptime(
  startedAt: number | string | null | undefined,
  now: number = Date.now(),
): string {
  if (startedAt == null) return '—';
  const ts = typeof startedAt === 'string' ? Date.parse(startedAt) : startedAt;
  if (!Number.isFinite(ts)) return '—';
  const secs = Math.max(0, Math.floor((now - ts) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** "Ns ago" / "Nm ago" / "Nh ago" / "Nd ago". */
export function formatRelative(ts: number | string): string {
  const t = typeof ts === 'string' ? Date.parse(ts) : ts;
  if (!Number.isFinite(t)) return '—';
  const dt = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (dt < 60) return `${dt}s ago`;
  if (dt < 3600) return `${Math.floor(dt / 60)}m ago`;
  if (dt < 86400) return `${Math.floor(dt / 3600)}h ago`;
  return `${Math.floor(dt / 86400)}d ago`;
}

/** "HH:MM" — clock court (pour pr-meta started). */
export function formatClockShort(ts: number | string): string {
  const t = typeof ts === 'string' ? Date.parse(ts) : ts;
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "HH:MM:SS" — clock long (pour TopBar). */
export function formatClock(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Format compact du compteur de messages pour la pill TopBar.
 *  - n ≤ 999            → "N"          (ex: "42")
 *  - 1_000 ≤ n < 1_000_000  → "X.Yk"   (1 décimale ex: "1.2k", "12.3k", "999.9k")
 *  - n ≥ 1_000_000      → "X.YM"      (au cas où ; pas attendu en v1)
 *
 * Aligné v2 `app.jsx:105` (`t.msgCount > 999 ? (t.msgCount/1000).toFixed(1) + "k" : t.msgCount`).
 * On garde la convention v2 (point décimal, pas de séparateur de milliers
 * en dessous du seuil) pour ne pas casser l'identité visuelle.
 */
export function formatMsgCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n > 999_999) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n > 999)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Format uptime compact pour la TopBar brand-sub. Renvoie :
 *   "0m"          si < 1 min
 *   "Xm"          si < 1 h
 *   "Xh Ym"       si < 24 h
 *   "Xd Yh"       au-delà
 *   "—"           si invalide / null
 *
 * Aligné v2 `data.jsx:462-473` (helper proto `formatUptime`).
 */
export function formatUptimeShort(
  startedAt: string | number | null | undefined,
): string {
  if (startedAt == null) return '—';
  const ts = typeof startedAt === 'string' ? Date.parse(startedAt) : startedAt;
  if (!Number.isFinite(ts)) return '—';
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return '0m';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 24) return `${hrs}h ${rem}m`;
  const days = Math.floor(hrs / 24);
  const hrem = hrs % 24;
  return `${days}d ${hrem}h`;
}

/**
 * Map un status (SessionStatus côté backend + variantes mock du proto) vers
 * un label uppercase. Les buckets serveur (S3 `mapSessionStatusToVisual`)
 * restent la source de vérité ; cette fonction est utilisée par les chips
 * et tooltips qui veulent le texte brut.
 */
export function statusLabel(s: string): string {
  const table: Record<string, string> = {
    running: 'RUNNING',
    waiting: 'WAITING',
    warn: 'DEGRADED',
    idle: 'IDLE',
    starting: 'STARTING',
    paused: 'PAUSED',
    stopped: 'STOPPED',
    exited: 'EXITED',
    killed: 'KILLED',
    interrupted: 'INTERRUPTED',
    failed: 'FAILED',
  };
  return table[s] ?? s.toUpperCase();
}

/**
 * Map un status vers la classe CSS de chip (warm-black theme).
 * Buckets : ok | warn | bad | stopped | waiting | starting.
 */
export type ChipClass = 'ok' | 'warn' | 'bad' | 'stopped' | 'waiting' | 'starting';

export function statusChipClass(s: string): ChipClass {
  if (s === 'stopped' || s === 'exited' || s === 'killed' || s === 'interrupted') return 'stopped';
  if (s === 'failed') return 'bad';
  if (s === 'warn') return 'warn';
  if (s === 'waiting') return 'waiting';
  if (s === 'starting') return 'starting';
  return 'ok';
}

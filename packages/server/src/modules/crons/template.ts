/**
 * Tiny template renderer for `action='message'` cron templates (modules/crons).
 *
 * Tokens (case-insensitive):
 *  - {{fire}}      → fire time truncated to the minute, e.g. `2026-06-18T20:00Z`.
 *                    Recommended idempotency key (`cycle_window_id`): unique per
 *                    tick, identical for the whole minute, in a compact ISO form
 *                    convenient as a per-window deduplication key.
 *  - {{now}}       → full ISO-8601 of the fire time (with ms).
 *  - {{window:Nh}} → fire time floored to an N-hour grid (anchored at the unix
 *  - {{window:Nm}}   epoch / UTC midnight), rendered to-the-minute. Use for
 *                    fixed coarse windows; N must divide evenly to align with
 *                    wall-clock boundaries (e.g. 6h → 00,06,12,18 UTC).
 *
 * Unknown / malformed tokens are left verbatim — rendering never throws, so a
 * typo in a cron's message can't take the scheduler down.
 */

const TOKEN_RE = /\{\{\s*([a-z]+)(?::(\d+)([hm]))?\s*\}\}/gi;

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Compact UTC ISO to the minute: `YYYY-MM-DDTHH:mmZ`. */
function toMinuteIso(d: Date): string {
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`
  );
}

export function renderTemplate(tpl: string, fire: Date): string {
  return tpl.replace(TOKEN_RE, (match, rawName: string, num?: string, unit?: string) => {
    const token = rawName.toLowerCase();
    if (token === 'fire') return toMinuteIso(fire);
    if (token === 'now') return fire.toISOString();
    if (token === 'window' && num && unit) {
      const n = Number(num);
      if (!Number.isFinite(n) || n <= 0) return match;
      const stepMs = unit.toLowerCase() === 'h' ? n * 3_600_000 : n * 60_000;
      const floored = new Date(Math.floor(fire.getTime() / stepMs) * stepMs);
      return toMinuteIso(floored);
    }
    return match;
  });
}

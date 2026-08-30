/**
 * Lot 15 — the daily cost export, as a document
 * (docs/monitoring-agents.md, § Lot 15).
 *
 * `GET /metrics/costs/export` hands an operator the ledger
 * `modules/orchestrator/cost-rollup` has been filling: one line per agent per
 * UTC day, over a window of up to 90 days. This module is the whole of it that
 * is not I/O — the query-string rules and the two serializations — so the route
 * is a dozen lines and every edge here is testable without an HTTP server.
 *
 * ONE DATASET, TWO ENCODINGS. The JSON rows carry the CSV header's field names
 * verbatim — `tokens_in`, not `tokensIn`. Snake_case is not the house style for
 * a wire shape, and that is precisely the point: the two formats must be the
 * same data, so that a script and a spreadsheet reading the same window can be
 * diffed against each other. Renaming a field on one side silently breaks that
 * property, which is why the header and the row type are generated from the
 * same list of column names.
 *
 * WHAT THE NUMBERS MEAN, since a CSV has no room to say it:
 *   - `day` is UTC, the rollup's clock.
 *   - the four token columns are the DELTAS of that day, so summing a column
 *     over the window gives the window's total. They are not running totals.
 *   - `cost_usd` was priced WHEN THE ROW WAS WRITTEN and never re-priced — it
 *     is what the day cost at the day's rates. Empty (CSV) / `null` (JSON)
 *     means the model could not be priced then; it never means `$0`.
 */

/**
 * The columns, in order. The CSV header, the CSV cell order and the JSON keys
 * all derive from this one array — see the module header.
 */
export const COST_EXPORT_COLUMNS = [
  'day',
  'orchestrator_id',
  'team',
  'session_id',
  'agent',
  'tokens_in',
  'tokens_out',
  'cache_read',
  'cache_write',
  'cost_usd',
] as const;

/**
 * The CSV header line, byte for byte. The shipped web half is written against
 * this exact string; a column renamed or reordered here is a broken contract,
 * not a refactor.
 */
export const COST_EXPORT_HEADER = COST_EXPORT_COLUMNS.join(',');

/** Window when the caller does not ask for one. */
export const COST_EXPORT_DEFAULT_DAYS = 30;

/**
 * Hard ceiling on the window, and the same figure the roll-up's retention keeps
 * — asking for more could only ever return the same rows. It is also what makes
 * a plain in-memory array the right answer: 90 days of a large fleet is tens of
 * thousands of lines, not millions, so nothing here streams.
 */
export const COST_EXPORT_MAX_DAYS = 90;

/** The two wire formats. Mirrors `web`'s `CostExportFormat`. */
export type CostExportFormat = 'csv' | 'json';

/** One exported line. Field names ARE the CSV header — see the module header. */
export interface CostExportRow {
  day: string;
  orchestrator_id: string;
  team: string;
  session_id: string;
  agent: string;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number | null;
}

/** Accepted query, or the message the 400 carries. */
export type CostExportQuery =
  | { ok: true; format: CostExportFormat; days: number }
  | { ok: false; error: string };

/**
 * Validate `?format=&days=`.
 *
 * Two deliberately different failure modes, because the two parameters fail for
 * different reasons:
 *
 *  - `format` is a CHOICE. An unrecognised one is a caller bug — silently
 *    serving CSV to something that asked for `xlsx` would look like success and
 *    be parsed as garbage. → 400. Absent, however, is not a mistake: an operator
 *    pasting the bare URL into a browser gets the spreadsheet flavour, which is
 *    the one a human wants.
 *  - `days` is a SIZE. Out of range is a request for more than exists, and the
 *    honest answer to "give me a year" is the 90 days we keep, not a refusal —
 *    so it is CLAMPED, not rejected. Only a `days` that is not a positive whole
 *    number at all (`abc`, `0`, `-3`, `1.5`) is a caller bug. → 400.
 */
export function parseCostExportQuery(query: {
  format?: unknown;
  days?: unknown;
}): CostExportQuery {
  const rawFormat = firstValue(query.format);
  let format: CostExportFormat;
  if (rawFormat === undefined || rawFormat === '') {
    format = 'csv';
  } else if (rawFormat === 'csv' || rawFormat === 'json') {
    format = rawFormat;
  } else {
    return { ok: false, error: 'format must be one of csv, json' };
  }

  const rawDays = firstValue(query.days);
  let days = COST_EXPORT_DEFAULT_DAYS;
  if (rawDays !== undefined && rawDays !== '') {
    // `Number` and not `parseInt`: `parseInt('30abc')` is 30, and a caller who
    // sent `30abc` did not mean 30.
    const parsed = Number(rawDays);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return { ok: false, error: `days must be a whole number between 1 and ${COST_EXPORT_MAX_DAYS}` };
    }
    days = Math.min(parsed, COST_EXPORT_MAX_DAYS);
  }

  return { ok: true, format, days };
}

/** Express gives `?days=1&days=2` as an array; take the first, ignore the rest. */
function firstValue(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

/**
 * The first UTC day of a `days`-wide window ending TODAY, inclusive both ends —
 * `days=1` is today alone, `days=30` is today plus the 29 before it.
 *
 * Inclusive because "the last 30 days" is what the button says, and an operator
 * comparing two exports a day apart should see 30 dates in each.
 */
export function costExportSinceDay(days: number, now: number = Date.now()): string {
  const startMs = now - (Math.max(1, days) - 1) * 86_400_000;
  return new Date(startMs).toISOString().slice(0, 10);
}

/**
 * `swarm-costs-2026-08-30.csv` — the day the export was TAKEN, in UTC.
 *
 * Only reaches a caller who hits the URL directly (the web builds its own
 * filename, in the operator's local date, from `lib/costExport.ts`). UTC here
 * because the server has no business guessing a browser's timezone.
 */
export function costExportFilename(format: CostExportFormat, now: number = Date.now()): string {
  return `swarm-costs-${new Date(now).toISOString().slice(0, 10)}.${format}`;
}

/**
 * RFC 4180 quoting, applied only where it is needed.
 *
 * A team called `alpha` must come out as `alpha`, not `"alpha"` — a CSV that
 * quotes everything is legal and unreadable in a diff. Quotes go on only for the
 * three characters that would otherwise change the shape of the file: a comma
 * (a new column), a double quote (an escape), a newline (a new row). Inside
 * quotes, `"` doubles.
 *
 * Names are operator-supplied, so this is the boundary where a team named
 * `ops,prod` stops being an injection into the grid.
 */
export function csvCell(value: string): string {
  // Formula-injection guard: `team` and `agent` are AGENT-CONTROLLED names (a
  // lead names its workers), and a cell starting with = + - @ is executed as a
  // formula by Excel/Sheets on open. The apostrophe prefix is the standard
  // spreadsheet "treat as text" marker; it must be applied BEFORE the quoting
  // test so a prefixed value that also contains a comma still gets quoted.
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** `null` → empty cell. NOT `0`: an unpriced day is not a free one. */
function csvNumber(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '' : String(value);
}

/**
 * Serialize the window as CSV: the header, then one line per row, each line
 * terminated by `\n` (the empty window is therefore the header alone, followed
 * by its newline — a valid one-line CSV, not an empty file that a spreadsheet
 * would refuse to open).
 */
export function toCostExportCsv(rows: readonly CostExportRow[]): string {
  const lines = [COST_EXPORT_HEADER];
  for (const row of rows) {
    lines.push(
      [
        csvCell(row.day),
        csvCell(row.orchestrator_id),
        csvCell(row.team),
        csvCell(row.session_id),
        csvCell(row.agent),
        String(row.tokens_in),
        String(row.tokens_out),
        String(row.cache_read),
        String(row.cache_write),
        csvNumber(row.cost_usd),
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The JSON body: `{days, rows}`. `days` is the EFFECTIVE window (after the
 * clamp), so a client that asked for 365 can see it got 90 without diffing the
 * dates itself.
 */
export function toCostExportJson(
  days: number,
  rows: readonly CostExportRow[],
): { days: number; rows: readonly CostExportRow[] } {
  return { days, rows };
}

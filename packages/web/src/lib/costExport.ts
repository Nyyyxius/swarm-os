// Saving the daily cost export to a local file — the browser half of
// `GET /metrics/costs/export` (docs/monitoring-agents.md, Lot 15).
//
// Split from `api.exportCosts` on purpose: the client fetches BYTES and this
// module turns bytes into a file on the operator's disk. That seam is what
// makes the failure path sane — the request either resolves with a document
// or rejects with an `HttpError`, and nothing touches the DOM until there is
// something worth saving. (The alternative, a `window.open` of the URL, cannot
// carry the auth header and lands the operator on an empty tab or a 404 page
// — the one outcome this feature must never produce.)
//
// Nothing here formats money or interprets a row: the export is the SERVER's
// document, saved verbatim. The web never re-derives what the CSV says.

import type { CostExportFormat } from '../api/client';

/**
 * The window the sidebar button asks for. 30 days is what the server defaults
 * to anyway; sending it explicitly means the URL in a bug report says what was
 * actually requested instead of relying on the server's default of the day.
 *
 * The endpoint caps at 90 — the `title` on the control points there for
 * anyone who wants the longer window (a URL away, no second button).
 */
export const COST_EXPORT_DAYS = 30;

/** Native `title` for the EXPORT controls. Names the window AND its ceiling. */
export const COST_EXPORT_TITLE =
  `daily cost rows, last ${COST_EXPORT_DAYS} days (?days=90 for more)`;

/** Content type of the saved file, so the OS opens it with the right app. */
export function costExportMime(format: CostExportFormat): string {
  return format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8';
}

/**
 * `swarm-costs-2026-08-30.csv` — the day the export was TAKEN, not the range
 * it covers.
 *
 * An operator ends up with a folder of these, and the only ordering that makes
 * sense there is chronological by capture: `days` is a rolling window, so two
 * exports a week apart genuinely hold different data under an identical
 * "last 30 days" description. ISO order (`YYYY-MM-DD`) so the filenames sort
 * lexicographically, which is how a file manager will sort them.
 *
 * LOCAL date, not UTC: the operator clicking at 9 pm on the 30th in Montréal
 * is filing this under the 30th, whatever `Z` says it is.
 */
export function costExportFilename(
  format: CostExportFormat,
  at: Date = new Date(),
): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `swarm-costs-${day}.${format}`;
}

/**
 * Hand the document to the browser as a download. Same idiom as
 * `api.exportSkill` / `exportPack`: a blob: URL on a detached `<a download>`,
 * clicked and revoked immediately (the click is synchronous, the navigation is
 * already committed by the time the URL goes away).
 *
 * `at` is injectable for the same reason `formatRelative` takes a `now`:
 * a filename derived from the wall clock is otherwise untestable.
 */
export function saveCostExport(
  text: string,
  format: CostExportFormat,
  at: Date = new Date(),
): void {
  const blob = new Blob([text], { type: costExportMime(format) });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = costExportFilename(format, at);
  a.click();
  URL.revokeObjectURL(url);
}

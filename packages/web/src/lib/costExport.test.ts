// Lot 15 — saving the daily cost export (docs/monitoring-agents.md).
//
// Two things are worth pinning here, and both are about the FILE rather than
// the request: an operator who exports twice must end up with two files they
// can tell apart, and the bytes that reach the disk must be the server's
// document unchanged.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  COST_EXPORT_DAYS, COST_EXPORT_TITLE, costExportFilename, costExportMime,
  saveCostExport,
} from './costExport';

describe('costExportFilename', () => {
  it('names the file after the LOCAL day it was taken, ISO-ordered', () => {
    // Local components, so this reads as the 30th wherever the suite runs —
    // which is the point of the function not using `toISOString()`.
    const at = new Date(2026, 7, 30, 21, 15);
    expect(costExportFilename('csv', at)).toBe('swarm-costs-2026-08-30.csv');
    expect(costExportFilename('json', at)).toBe('swarm-costs-2026-08-30.json');
  });

  it('zero-pads month and day so the names sort lexicographically', () => {
    const at = new Date(2026, 0, 5);
    expect(costExportFilename('csv', at)).toBe('swarm-costs-2026-01-05.csv');
  });
});

describe('costExportMime', () => {
  it('labels each format so the OS opens it with the right app', () => {
    expect(costExportMime('csv')).toBe('text/csv;charset=utf-8');
    expect(costExportMime('json')).toBe('application/json;charset=utf-8');
  });
});

describe('COST_EXPORT_TITLE', () => {
  it('names the window it fetches AND the cap, since there is no control for it', () => {
    expect(COST_EXPORT_DAYS).toBe(30);
    expect(COST_EXPORT_TITLE).toBe('daily cost rows, last 30 days (?days=90 for more)');
  });
});

describe('saveCostExport', () => {
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;

  afterEach(() => {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    vi.restoreAllMocks();
  });

  it('downloads the server document verbatim under the dated name', async () => {
    const blobs: Blob[] = [];
    const created = vi.fn((b: Blob) => {
      blobs.push(b);
      return 'blob:fake';
    });
    const revoked = vi.fn();
    // jsdom implements neither; and the anchor click is spied rather than let
    // through, because a real one would try to navigate the test document.
    // The two functions are patched onto the real `URL` (rather than the whole
    // global being swapped) so `new URL(...)` keeps working everywhere else.
    URL.createObjectURL = created as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revoked as unknown as typeof URL.revokeObjectURL;
    const clicks: { download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
      function (this: HTMLAnchorElement) {
        clicks.push({ download: this.download });
      },
    );

    const csv = 'day,orchestrator_id,team\n2026-08-30,o1,ATLAS\n';
    saveCostExport(csv, 'csv', new Date(2026, 7, 30));

    expect(clicks).toEqual([{ download: 'swarm-costs-2026-08-30.csv' }]);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]!.type).toBe('text/csv;charset=utf-8');
    // The whole contract of the feature: what the server wrote is what lands
    // on the disk — no re-serialisation, no reformatting, no reordering.
    await expect(blobs[0]!.text()).resolves.toBe(csv);
    // The blob: URL is released — a monitoring page left open for days must
    // not leak one document per export.
    expect(revoked).toHaveBeenCalledWith('blob:fake');
  });
});

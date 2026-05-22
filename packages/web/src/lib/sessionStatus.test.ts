// S3 — Unit tests for the session/orchestrator → visual mapping.

import { describe, it, expect } from 'vitest';
import {
  mapSessionStatusToVisual,
  mapOrchestratorStatusToVisual,
  enrichWithIdle,
  IDLE_VISUAL_THRESHOLD_MS,
  VISUAL_CLASSES,
  type SessionStatus,
  type OrchestratorStatus,
  type VisualStatus,
} from './sessionStatus';

/**
 * Exhaustivity guard: enumerate ALL session statuses literally so that
 * adding a new variant upstream forces this test (and the switch in
 * sessionStatus.ts) to be updated. The `satisfies` keeps the array
 * length-typed but still flagged by TS if a member is missing.
 */
const ALL_SESSION_STATUSES = [
  'starting',
  'running',
  'paused',
  'waiting',
  'exited',
  'killed',
  'interrupted',
  'failed',
] as const satisfies readonly SessionStatus[];

const ALL_ORCH_STATUSES = [
  'starting',
  'running',
  'stopping',
  'stopped',
  'failed',
] as const satisfies readonly OrchestratorStatus[];

interface Row {
  status: SessionStatus;
  visual: VisualStatus;
  label: string;
  pulse: boolean;
  hasTooltip: boolean;
}

const SESSION_TABLE: Row[] = [
  { status: 'starting', visual: 'idle', label: 'STARTING', pulse: false, hasTooltip: false },
  { status: 'running', visual: 'running', label: 'RUNNING', pulse: false, hasTooltip: false },
  { status: 'waiting', visual: 'warn', label: 'WAITING', pulse: true, hasTooltip: true },
  { status: 'paused', visual: 'warn', label: 'PAUSED', pulse: false, hasTooltip: true },
  { status: 'exited', visual: 'stopped', label: 'EXITED', pulse: false, hasTooltip: true },
  { status: 'killed', visual: 'stopped', label: 'KILLED', pulse: false, hasTooltip: true },
  {
    status: 'interrupted',
    visual: 'stopped',
    label: 'INTERRUPTED',
    pulse: false,
    hasTooltip: true,
  },
  { status: 'failed', visual: 'bad', label: 'FAILED', pulse: false, hasTooltip: true },
];

describe('mapSessionStatusToVisual', () => {
  for (const row of SESSION_TABLE) {
    it(`maps "${row.status}" → visual=${row.visual}, pulse=${row.pulse}`, () => {
      const d = mapSessionStatusToVisual(row.status);
      expect(d.visual).toBe(row.visual);
      expect(d.label).toBe(row.label);
      expect(d.pulse).toBe(row.pulse);
      if (row.hasTooltip) {
        expect(d.tooltip).toBeTruthy();
      } else {
        expect(d.tooltip).toBeUndefined();
      }
    });
  }

  it('only "waiting" pulses', () => {
    const pulsing = ALL_SESSION_STATUSES.filter(
      (s) => mapSessionStatusToVisual(s).pulse,
    );
    expect(pulsing).toEqual(['waiting']);
  });

  it('"failed" is the only `bad` visual', () => {
    const bad = ALL_SESSION_STATUSES.filter(
      (s) => mapSessionStatusToVisual(s).visual === 'bad',
    );
    expect(bad).toEqual(['failed']);
  });

  it('exited / killed / interrupted share the `stopped` visual but distinct labels', () => {
    const exited = mapSessionStatusToVisual('exited');
    const killed = mapSessionStatusToVisual('killed');
    const interrupted = mapSessionStatusToVisual('interrupted');
    expect(exited.visual).toBe('stopped');
    expect(killed.visual).toBe('stopped');
    expect(interrupted.visual).toBe('stopped');
    expect(new Set([exited.label, killed.label, interrupted.label]).size).toBe(3);
    expect(new Set([exited.tooltip, killed.tooltip, interrupted.tooltip]).size).toBe(3);
  });

  it('covers all 8 SessionStatus values (exhaustive)', () => {
    expect(ALL_SESSION_STATUSES).toHaveLength(8);
    for (const s of ALL_SESSION_STATUSES) {
      expect(() => mapSessionStatusToVisual(s)).not.toThrow();
    }
  });
});

describe('mapOrchestratorStatusToVisual', () => {
  it('maps all 5 OrchestratorStatus values', () => {
    expect(ALL_ORCH_STATUSES).toHaveLength(5);
    for (const s of ALL_ORCH_STATUSES) {
      const d = mapOrchestratorStatusToVisual(s);
      expect(d.visual).toBeTruthy();
      expect(d.label).toBe(s.toUpperCase());
    }
  });

  it('"stopping" maps to idle (transient)', () => {
    expect(mapOrchestratorStatusToVisual('stopping').visual).toBe('idle');
  });

  it('"failed" maps to bad', () => {
    expect(mapOrchestratorStatusToVisual('failed').visual).toBe('bad');
  });

  it('"running" maps to running', () => {
    expect(mapOrchestratorStatusToVisual('running').visual).toBe('running');
  });
});

describe('enrichWithIdle (S6)', () => {
  // Fixed reference instant — tests subtract offsets from it to build
  // synthetic `lastActivityAt` ISO strings. Avoids `Date.now()` reads so
  // the suite stays deterministic without faking timers.
  const NOW = Date.parse('2025-01-01T12:00:00.000Z');
  const iso = (offsetMs: number) => new Date(NOW - offsetMs).toISOString();

  it('exports a 30 s threshold by default', () => {
    expect(IDLE_VISUAL_THRESHOLD_MS).toBe(30_000);
  });

  it('keeps `running` when activity is fresh (< threshold)', () => {
    const d = enrichWithIdle(
      { status: 'running', lastActivityAt: iso(5_000) },
      NOW,
    );
    expect(d.visual).toBe('running');
    expect(d.label).toBe('RUNNING');
    expect(d.pulse).toBe(false);
  });

  it('keeps `running` exactly at the threshold (strictly greater check)', () => {
    const d = enrichWithIdle(
      { status: 'running', lastActivityAt: iso(IDLE_VISUAL_THRESHOLD_MS) },
      NOW,
    );
    expect(d.visual).toBe('running');
  });

  it('downgrades `running` to `idle` when stale (> threshold)', () => {
    const d = enrichWithIdle(
      { status: 'running', lastActivityAt: iso(35_000) },
      NOW,
    );
    expect(d.visual).toBe('idle');
    expect(d.label).toBe('IDLE');
    expect(d.pulse).toBe(false);
    expect(d.tooltip).toMatch(/35\s*s/);
  });

  it('reports the age (in seconds) in the tooltip', () => {
    const d = enrichWithIdle(
      { status: 'running', lastActivityAt: iso(47_500) },
      NOW,
    );
    expect(d.tooltip).toMatch(/47\s*s/);
  });

  it('NEVER overrides `waiting` (human input pending)', () => {
    const d = enrichWithIdle(
      { status: 'waiting', lastActivityAt: iso(60_000) },
      NOW,
    );
    expect(d.visual).toBe('warn');
    expect(d.label).toBe('WAITING');
    expect(d.pulse).toBe(true);
  });

  it('NEVER overrides `paused` (S5 — operator pause)', () => {
    const d = enrichWithIdle(
      { status: 'paused', lastActivityAt: iso(120_000) },
      NOW,
    );
    expect(d.visual).toBe('warn');
    expect(d.label).toBe('PAUSED');
  });

  it('NEVER overrides terminal states', () => {
    const stale = iso(120_000);
    expect(
      enrichWithIdle({ status: 'failed', lastActivityAt: stale }, NOW).visual,
    ).toBe('bad');
    expect(
      enrichWithIdle({ status: 'killed', lastActivityAt: stale }, NOW).visual,
    ).toBe('stopped');
    expect(
      enrichWithIdle({ status: 'exited', lastActivityAt: stale }, NOW).visual,
    ).toBe('stopped');
    expect(
      enrichWithIdle({ status: 'interrupted', lastActivityAt: stale }, NOW)
        .visual,
    ).toBe('stopped');
  });

  it('preserves the native `idle` visual of `starting`', () => {
    const d = enrichWithIdle(
      { status: 'starting', lastActivityAt: iso(120_000) },
      NOW,
    );
    expect(d.visual).toBe('idle');
    expect(d.label).toBe('STARTING');
  });

  it('garbage `lastActivityAt` does not crash and falls back to running', () => {
    const d = enrichWithIdle(
      { status: 'running', lastActivityAt: 'not-a-date' },
      NOW,
    );
    expect(d.visual).toBe('running');
    expect(d.label).toBe('RUNNING');
  });

  it('empty `lastActivityAt` falls back to running', () => {
    const d = enrichWithIdle(
      { status: 'running', lastActivityAt: '' },
      NOW,
    );
    expect(d.visual).toBe('running');
  });

  it('future `lastActivityAt` (clock skew) is treated as fresh', () => {
    const d = enrichWithIdle(
      { status: 'running', lastActivityAt: iso(-60_000) },
      NOW,
    );
    expect(d.visual).toBe('running');
  });

  it('respects a custom threshold', () => {
    const fresh = enrichWithIdle(
      { status: 'running', lastActivityAt: iso(3_000) },
      NOW,
      5_000,
    );
    expect(fresh.visual).toBe('running');
    const stale = enrichWithIdle(
      { status: 'running', lastActivityAt: iso(10_000) },
      NOW,
      5_000,
    );
    expect(stale.visual).toBe('idle');
  });
});

describe('VISUAL_CLASSES', () => {
  it('defines a Tailwind class string for every visual bucket', () => {
    const buckets: VisualStatus[] = ['idle', 'running', 'warn', 'bad', 'stopped'];
    for (const b of buckets) {
      expect(VISUAL_CLASSES[b]).toMatch(/bg-/);
      expect(VISUAL_CLASSES[b]).toMatch(/text-/);
    }
  });

  it('`bad` uses a red family (distinct from stopped)', () => {
    expect(VISUAL_CLASSES.bad).toContain('red');
    expect(VISUAL_CLASSES.stopped).not.toContain('red');
  });
});

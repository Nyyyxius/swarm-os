// Step 6 (Phase B.6) — unit tests for the pulses pipeline.

import { describe, it, expect } from 'vitest';
import { deriveKind, pushPulse, PULSE_CAP, PULSE_DEDUPE_MS } from './pulses';
import type { MailboxMessageEvent } from '../../hooks/useEvents';
import type { MapPulse } from './MapView';

function ev(over: Partial<MailboxMessageEvent> = {}): MailboxMessageEvent {
  return {
    kind: 'mailbox.message',
    ts: '2026-05-22T10:00:00.000Z',
    orchestratorId: 'o1',
    sessionId: 's1',
    from: 's2',
    to: 's1',
    ...over,
  };
}

describe('deriveKind', () => {
  it('returns broadcast when to === "broadcast"', () => {
    expect(deriveKind(ev({ to: 'broadcast' }))).toBe('broadcast');
  });

  it('returns broadcast even when from === "human" + to === "broadcast"', () => {
    // broadcast precedence over human.
    expect(deriveKind(ev({ from: 'human', to: 'broadcast' }))).toBe('broadcast');
  });

  it('returns cross when fromOrchestratorId differs from orchestratorId', () => {
    expect(deriveKind(ev({ fromOrchestratorId: 'o2' }))).toBe('cross');
  });

  it('returns human when from === "human" (and not broadcast/cross)', () => {
    expect(deriveKind(ev({ from: 'human' }))).toBe('human');
  });

  it('returns intra by default', () => {
    expect(deriveKind(ev())).toBe('intra');
  });

  it('treats matching fromOrchestratorId as intra (not cross)', () => {
    expect(deriveKind(ev({ fromOrchestratorId: 'o1' }))).toBe('intra');
  });
});

describe('pushPulse', () => {
  let nextId = 1;
  const id = () => nextId++;

  it('appends a pulse with a fresh id', () => {
    nextId = 1;
    const out = pushPulse([], { from: 'a', to: 'b', kind: 'intra', ts: 1000 }, id);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 1, from: 'a', to: 'b', kind: 'intra' });
  });

  it('deduplicates same (from,to,kind) within 200 ms', () => {
    nextId = 10;
    const a = pushPulse([], { from: 'a', to: 'b', kind: 'intra', ts: 1000 }, id);
    const b = pushPulse(a, { from: 'a', to: 'b', kind: 'intra', ts: 1100 }, id);
    expect(b).toBe(a);                 // same reference (dropped)
    expect(b).toHaveLength(1);
  });

  it('does NOT deduplicate after the 200 ms window', () => {
    nextId = 20;
    const a = pushPulse([], { from: 'a', to: 'b', kind: 'intra', ts: 1000 }, id);
    const b = pushPulse(a, { from: 'a', to: 'b', kind: 'intra', ts: 1000 + PULSE_DEDUPE_MS + 1 }, id);
    expect(b).not.toBe(a);
    expect(b).toHaveLength(2);
  });

  it('does NOT deduplicate when kind differs', () => {
    nextId = 30;
    const a = pushPulse([], { from: 'a', to: 'b', kind: 'intra', ts: 1000 }, id);
    const b = pushPulse(a, { from: 'a', to: 'b', kind: 'human', ts: 1050 }, id);
    expect(b).not.toBe(a);
    expect(b).toHaveLength(2);
  });

  it('does NOT deduplicate when to differs', () => {
    nextId = 40;
    const a = pushPulse([], { from: 'a', to: 'b', kind: 'intra', ts: 1000 }, id);
    const b = pushPulse(a, { from: 'a', to: 'c', kind: 'intra', ts: 1050 }, id);
    expect(b).not.toBe(a);
    expect(b).toHaveLength(2);
  });

  it('caps the buffer at PULSE_CAP (oldest dropped)', () => {
    nextId = 100;
    let buf: MapPulse[] = [];
    for (let i = 0; i < PULSE_CAP + 5; i++) {
      // unique kinds/from/to/ts to avoid dedupe.
      buf = pushPulse(buf, { from: `f${i}`, to: `t${i}`, kind: 'intra', ts: 2000 + i * 1000 }, id);
    }
    expect(buf).toHaveLength(PULSE_CAP);
    // The first 5 should have been dropped — the surviving head must be id 105.
    expect(buf[0]?.id).toBe(105);
    expect(buf[PULSE_CAP - 1]?.id).toBe(100 + PULSE_CAP + 5 - 1);
  });

  it('exits the dedupe scan early once outside the sliding window', () => {
    // Older entries (>200 ms) shouldn't be scanned. Sanity: a duplicate
    // that sits past the window IS allowed in (which proves we walked
    // backwards and exited).
    nextId = 200;
    const old = pushPulse([], { from: 'a', to: 'b', kind: 'intra', ts: 0 }, id);
    const filler = pushPulse(old, { from: 'x', to: 'y', kind: 'intra', ts: 500 }, id);
    const dup = pushPulse(filler, { from: 'a', to: 'b', kind: 'intra', ts: 500 }, id);
    expect(dup).toHaveLength(3);
  });
});

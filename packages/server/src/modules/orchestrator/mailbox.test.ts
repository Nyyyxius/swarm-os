import { describe, it, expect } from 'vitest';
import { Mailbox } from './mailbox.js';

/**
 * Phase 7 — bounded mailbox semantics (plan §11).
 *
 * Pure in-memory class — no setup/teardown needed beyond a fresh instance
 * per test.
 */

describe('Mailbox.push', () => {
  it('keeps a message under the cap and returns the new size', () => {
    const m = new Mailbox({ maxSize: 3 });
    const r = m.push('a', { from: 's', content: '1' });
    expect(r).toEqual({ dropped: false, queueSize: 1 });
    expect(m.size('a')).toBe(1);
  });

  it('drops the oldest when pushing over the cap', () => {
    const m = new Mailbox({ maxSize: 2 });
    m.push('a', { from: 's', content: '1' });
    m.push('a', { from: 's', content: '2' });
    const r = m.push('a', { from: 's', content: '3' });
    expect(r).toEqual({ dropped: true, queueSize: 2 });
    const peeked = m.peek('a');
    expect(peeked.map((x) => x.content)).toEqual(['2', '3']);
  });

  it('keeps exactly the cap after pushing cap+5 messages', () => {
    const cap = 100;
    const m = new Mailbox({ maxSize: cap });
    let drops = 0;
    for (let i = 0; i < cap + 5; i++) {
      const r = m.push('a', { from: 's', content: `m${i}` });
      if (r.dropped) drops++;
    }
    expect(m.size('a')).toBe(cap);
    expect(drops).toBe(5);
    // Oldest five should have been evicted — the first remaining is `m5`.
    expect(m.peek('a')[0]?.content).toBe('m5');
  });

  it('mints id + ts when missing', () => {
    const m = new Mailbox();
    m.push('a', { from: 's', content: 'x' });
    const [msg] = m.peek('a');
    expect(msg?.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(msg?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('rejects a non-positive maxSize at construction', () => {
    expect(() => new Mailbox({ maxSize: 0 })).toThrow();
    expect(() => new Mailbox({ maxSize: -1 })).toThrow();
    expect(() => new Mailbox({ maxSize: 1.5 })).toThrow();
  });
});

describe('Mailbox.read', () => {
  it('drains the queue', () => {
    const m = new Mailbox();
    m.push('a', { from: 's', content: '1' });
    m.push('a', { from: 's', content: '2' });
    const out = m.read('a');
    expect(out.map((x) => x.content)).toEqual(['1', '2']);
    expect(m.size('a')).toBe(0);
  });

  it('returns [] for an unknown sid', () => {
    const m = new Mailbox();
    expect(m.read('nobody')).toEqual([]);
  });
});

describe('Mailbox.peek', () => {
  it('returns a snapshot without draining', () => {
    const m = new Mailbox();
    m.push('a', { from: 's', content: '1' });
    expect(m.peek('a').map((x) => x.content)).toEqual(['1']);
    expect(m.size('a')).toBe(1);
  });

  it('returns a copy that callers cannot mutate the queue with', () => {
    const m = new Mailbox();
    m.push('a', { from: 's', content: '1' });
    const snap = m.peek('a');
    snap.length = 0;
    expect(m.size('a')).toBe(1);
  });
});

describe('Mailbox.removeSession / clearAll', () => {
  it('removeSession drops one queue', () => {
    const m = new Mailbox();
    m.push('a', { from: 's', content: 'x' });
    m.push('b', { from: 's', content: 'y' });
    m.removeSession('a');
    expect(m.size('a')).toBe(0);
    expect(m.size('b')).toBe(1);
  });

  it('clearAll wipes everything', () => {
    const m = new Mailbox();
    m.push('a', { from: 's', content: 'x' });
    m.push('b', { from: 's', content: 'y' });
    m.clearAll();
    expect(m.size('a')).toBe(0);
    expect(m.size('b')).toBe(0);
  });
});

/**
 * Phase update_system S1 — cumulative `messagesTotal` counter (one push =
 * one increment, monotone, never reset).
 */
describe('Mailbox.messagesTotal', () => {
  it('starts at zero on a fresh mailbox', () => {
    const m = new Mailbox();
    expect(m.messagesTotal).toBe(0);
  });

  it('increments by one for a single push', () => {
    const m = new Mailbox();
    m.push('a', { from: 's', content: '1' });
    expect(m.messagesTotal).toBe(1);
  });

  it('counts pushes across distinct recipients (global, not per-inbox)', () => {
    const m = new Mailbox();
    m.push('a', { from: 's', content: '1' });
    m.push('b', { from: 's', content: '2' });
    m.push('c', { from: 's', content: '3' });
    expect(m.messagesTotal).toBe(3);
  });

  it('counts repeated pushes to the same recipient (no dedup)', () => {
    const m = new Mailbox();
    m.push('a', { from: 's', content: '1' });
    m.push('a', { from: 's', content: '2' });
    m.push('a', { from: 's', content: '3' });
    expect(m.messagesTotal).toBe(3);
  });

  it('still increments when a push triggers a drop-oldest', () => {
    const m = new Mailbox({ maxSize: 2 });
    m.push('a', { from: 's', content: '1' });
    m.push('a', { from: 's', content: '2' });
    const r = m.push('a', { from: 's', content: '3' });
    expect(r.dropped).toBe(true);
    // Three pushes total — the drop is a cap effect, not a bus failure.
    expect(m.messagesTotal).toBe(3);
  });

  it('is unaffected by read()', () => {
    const m = new Mailbox();
    m.push('a', { from: 's', content: '1' });
    m.push('a', { from: 's', content: '2' });
    m.read('a');
    expect(m.messagesTotal).toBe(2);
  });

  it('is unaffected by peek()', () => {
    const m = new Mailbox();
    m.push('a', { from: 's', content: '1' });
    m.peek('a');
    expect(m.messagesTotal).toBe(1);
  });

  it('is unaffected by removeSession()', () => {
    const m = new Mailbox();
    m.push('a', { from: 's', content: '1' });
    m.push('a', { from: 's', content: '2' });
    m.removeSession('a');
    expect(m.messagesTotal).toBe(2);
  });

  it('is unaffected by clearAll()', () => {
    const m = new Mailbox();
    m.push('a', { from: 's', content: '1' });
    m.push('b', { from: 's', content: '2' });
    m.clearAll();
    expect(m.messagesTotal).toBe(2);
  });

  it('handles 1000 sequential pushes (sanity / perf gross check)', () => {
    const m = new Mailbox({ maxSize: 1000 });
    for (let i = 0; i < 1000; i++) {
      m.push('a', { from: 's', content: `m${i}` });
    }
    expect(m.messagesTotal).toBe(1000);
  });
});

/**
 * Phase update_system S8 — instantaneous Σ queue lengths across every
 * session in the mailbox. Backs `/metrics/bus` queue_depth.
 */
describe('Mailbox.totalSize', () => {
  it('returns 0 on an empty mailbox', () => {
    const m = new Mailbox();
    expect(m.totalSize()).toBe(0);
  });

  it('sums queue lengths across multiple sessions', () => {
    const m = new Mailbox();
    m.push('a', { from: 's', content: '1' });
    m.push('a', { from: 's', content: '2' });
    m.push('a', { from: 's', content: '3' });
    m.push('b', { from: 's', content: 'x' });
    m.push('b', { from: 's', content: 'y' });
    expect(m.totalSize()).toBe(5);
  });

  it('decreases when an inbox is drained via read()', () => {
    const m = new Mailbox();
    m.push('a', { from: 's', content: '1' });
    m.push('a', { from: 's', content: '2' });
    m.push('b', { from: 's', content: '3' });
    expect(m.totalSize()).toBe(3);
    m.read('a');
    expect(m.totalSize()).toBe(1);
  });

  it('decreases when removeSession() drops a queue', () => {
    const m = new Mailbox();
    m.push('a', { from: 's', content: '1' });
    m.push('b', { from: 's', content: '2' });
    m.removeSession('a');
    expect(m.totalSize()).toBe(1);
  });

  it('drops to 0 after clearAll()', () => {
    const m = new Mailbox();
    m.push('a', { from: 's', content: '1' });
    m.push('b', { from: 's', content: '2' });
    m.clearAll();
    expect(m.totalSize()).toBe(0);
  });

  it('respects the maxSize cap — never exceeds N sessions × maxSize', () => {
    const m = new Mailbox({ maxSize: 5 });
    for (let i = 0; i < 50; i++) m.push('a', { from: 's', content: `m${i}` });
    for (let i = 0; i < 50; i++) m.push('b', { from: 's', content: `m${i}` });
    // Each inbox capped at 5 → totalSize = 10.
    expect(m.totalSize()).toBe(10);
  });
});

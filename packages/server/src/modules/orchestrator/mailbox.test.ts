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

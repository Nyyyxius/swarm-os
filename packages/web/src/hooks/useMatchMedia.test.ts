// Tests for useMatchMedia — the synchronous-at-first-paint media subscription
// underpinning the desktop↔mobile aiguillage. jsdom has no matchMedia, so we
// install a controllable stub.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMatchMedia } from './useMatchMedia';

interface FakeMql {
  matches: boolean;
  listeners: Set<() => void>;
}

function installMatchMedia(initial: Record<string, boolean>) {
  const registry = new Map<string, FakeMql>();
  const get = (q: string): FakeMql => {
    let m = registry.get(q);
    if (!m) {
      m = { matches: !!initial[q], listeners: new Set() };
      registry.set(q, m);
    }
    return m;
  };
  window.matchMedia = vi.fn((q: string) => {
    const m = get(q);
    return {
      get matches() { return m.matches; },
      media: q,
      addEventListener: (_: string, cb: () => void) => m.listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => m.listeners.delete(cb),
      addListener: (cb: () => void) => m.listeners.add(cb),
      removeListener: (cb: () => void) => m.listeners.delete(cb),
      onchange: null,
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  }) as unknown as typeof window.matchMedia;
  return {
    set(q: string, v: boolean) {
      const m = get(q);
      m.matches = v;
      act(() => { m.listeners.forEach((cb) => cb()); });
    },
  };
}

describe('useMatchMedia', () => {
  beforeEach(() => {
    // @ts-expect-error reset between tests
    delete window.matchMedia;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the initial match synchronously (no flash)', () => {
    installMatchMedia({ '(max-width: 820px)': true });
    const { result } = renderHook(() => useMatchMedia('(max-width: 820px)'));
    expect(result.current).toBe(true);
  });

  it('updates when the query toggles', () => {
    const mm = installMatchMedia({ '(max-width: 820px)': false });
    const { result } = renderHook(() => useMatchMedia('(max-width: 820px)'));
    expect(result.current).toBe(false);
    mm.set('(max-width: 820px)', true);
    expect(result.current).toBe(true);
  });

  it('returns false when matchMedia is unavailable', () => {
    // window.matchMedia intentionally left undefined (deleted in beforeEach)
    const { result } = renderHook(() => useMatchMedia('(max-width: 820px)'));
    expect(result.current).toBe(false);
  });
});

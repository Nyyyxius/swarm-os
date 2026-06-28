// Tests for useShellMode — the aiguillage criterion + manual override.
//
// Criterion: auto = (pointer: coarse) && (max-width: 820px). A persistent
// localStorage override (auto|desktop|mobile) takes priority. These guard
// the two regressions that matter: (1) a fine-pointer machine in a narrow
// window must NOT flip to mobile; (2) the override must win over detection.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useShellMode } from './useShellMode';

const COARSE = '(pointer: coarse)';
const NARROW = '(max-width: 820px)';

function installMatchMedia(matches: Record<string, boolean>) {
  window.matchMedia = vi.fn((q: string) => ({
    matches: !!matches[q],
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList) as unknown as typeof window.matchMedia;
}

describe('useShellMode', () => {
  beforeEach(() => {
    localStorage.clear();
    // @ts-expect-error reset between tests
    delete window.matchMedia;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('auto: coarse pointer AND narrow → mobile', () => {
    installMatchMedia({ [COARSE]: true, [NARROW]: true });
    const { result } = renderHook(() => useShellMode());
    expect(result.current.isMobile).toBe(true);
  });

  it('auto: narrow but FINE pointer (desktop window dragged narrow) → desktop', () => {
    installMatchMedia({ [COARSE]: false, [NARROW]: true });
    const { result } = renderHook(() => useShellMode());
    expect(result.current.isMobile).toBe(false);
  });

  it('auto: coarse but wide (tablet landscape) → desktop', () => {
    installMatchMedia({ [COARSE]: true, [NARROW]: false });
    const { result } = renderHook(() => useShellMode());
    expect(result.current.isMobile).toBe(false);
  });

  it('override "desktop" beats a mobile-looking device', () => {
    installMatchMedia({ [COARSE]: true, [NARROW]: true });
    localStorage.setItem('swarm-os.shell-mode', 'desktop');
    const { result } = renderHook(() => useShellMode());
    expect(result.current.mode).toBe('desktop');
    expect(result.current.isMobile).toBe(false);
  });

  it('override "mobile" beats a desktop-looking device', () => {
    installMatchMedia({ [COARSE]: false, [NARROW]: false });
    localStorage.setItem('swarm-os.shell-mode', 'mobile');
    const { result } = renderHook(() => useShellMode());
    expect(result.current.mode).toBe('mobile');
    expect(result.current.isMobile).toBe(true);
  });

  it('setMode persists the override to localStorage', () => {
    installMatchMedia({ [COARSE]: true, [NARROW]: true });
    const { result } = renderHook(() => useShellMode());
    expect(result.current.isMobile).toBe(true);
    act(() => result.current.setMode('desktop'));
    expect(localStorage.getItem('swarm-os.shell-mode')).toBe('desktop');
    expect(result.current.isMobile).toBe(false);
  });
});

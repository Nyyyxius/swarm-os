import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Desktop ↔ mobile shell aiguillage.
 *
 * Detection criterion (NOT width alone — the desktop already degrades
 * gracefully down to ~1080px, so `max-width:768px` would confuse "narrow
 * window" with "touch device"):
 *
 *     auto = (pointer: coarse) && (max-width: 820px)
 *
 * `pointer: coarse` keeps a fine-pointer machine on desktop even when its
 * window is dragged narrow or devtools is docked; 820px includes iPad
 * portrait. A persistent manual override (`swarm-os.shell-mode` =
 * auto|desktop|mobile) takes priority — it is the only real guard against
 * an accidental hot-swap killing an active PTY writer.
 *
 * Anti-flash: the initial value is computed synchronously in the lazy
 * `useState` initializer (matchMedia is sync at first paint). Auto-mode
 * changes are debounced ~300ms to avoid thrash during a resize/rotation.
 */
export type ShellMode = 'auto' | 'desktop' | 'mobile';

const STORAGE_KEY = 'swarm-os.shell-mode';
const COARSE = '(pointer: coarse)';
const NARROW = '(max-width: 820px)';
const DEBOUNCE_MS = 300;

function hasMM(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

function readMode(): ShellMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'desktop' || v === 'mobile' || v === 'auto') return v;
  } catch {
    /* ignore — private mode / disabled storage */
  }
  return 'auto';
}

function computeAuto(): boolean {
  if (!hasMM()) return false;
  return window.matchMedia(COARSE).matches && window.matchMedia(NARROW).matches;
}

function resolveIsMobile(mode: ShellMode): boolean {
  if (mode === 'desktop') return false;
  if (mode === 'mobile') return true;
  return computeAuto();
}

export function useShellMode(): {
  isMobile: boolean;
  mode: ShellMode;
  setMode: (m: ShellMode) => void;
} {
  const [mode, setModeState] = useState<ShellMode>(() => readMode());
  const [isMobile, setIsMobile] = useState<boolean>(() => resolveIsMobile(readMode()));
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-detection: recompute on media change, debounced. The listener is
  // always attached (cheap) but only flips the result while in auto mode.
  useEffect(() => {
    if (!hasMM()) return;
    const coarse = window.matchMedia(COARSE);
    const narrow = window.matchMedia(NARROW);
    const recompute = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        setIsMobile(resolveIsMobile(mode));
      }, DEBOUNCE_MS);
    };
    coarse.addEventListener('change', recompute);
    narrow.addEventListener('change', recompute);
    return () => {
      coarse.removeEventListener('change', recompute);
      narrow.removeEventListener('change', recompute);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [mode]);

  // Override change → recompute immediately (no debounce, deliberate).
  useEffect(() => {
    setIsMobile(resolveIsMobile(mode));
  }, [mode]);

  // Cross-tab sync of the override.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setModeState(readMode());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setMode = useCallback((m: ShellMode) => {
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch {
      /* ignore */
    }
    setModeState(m);
  }, []);

  return { isMobile, mode, setMode };
}

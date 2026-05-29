/**
 * Per-instance visual settings — runtime tweaks (accent, label, font-size,
 * density, bg tint) persisted server-side + cached in localStorage.
 *
 * Why both stores: the server is the source of truth (shared across all tabs
 * and users of the same instance — this is what enables visual differentiation
 * between PROD / DEV / LAB), while localStorage acts as an instant-read cache
 * so the first paint doesn't flash the default theme before the GET resolves.
 *
 * Apply order on mount:
 *   1. `applyCachedInstanceSettings()` runs SYNC from `main.tsx` before React
 *      ever paints — reads localStorage, applies CSS vars + title.
 *   2. The hook mounts, fires `GET /settings`, and if the server's
 *      `updatedAt` is newer than what we had cached, re-applies + persists.
 *   3. Every `setSettings(patch)` writes the server first (PATCH), then
 *      reflects locally (CSS vars + localStorage). On network failure the
 *      local state is rolled back and the error surfaces via `state.error`.
 *
 * Multi-tab sync within the same browser is best-effort via the `storage`
 * event; cross-browser sync relies on the next GET.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  api,
  INSTANCE_SETTINGS_DEFAULTS,
  type InstanceSettingsView,
  type InstanceSettingsPatch,
  type InstanceBgTint,
} from '../api/client';

const CACHE_KEY = 'swarm-os.instance-settings';

interface BgTintPalette {
  bg: string;
  bg2: string;
}

const BG_TINT_PALETTES: Record<InstanceBgTint, BgTintPalette> = {
  warm: { bg: '#0d0a08', bg2: '#16110d' },
  neutral: { bg: '#0a0a0b', bg2: '#131316' },
  cool: { bg: '#080a0d', bg2: '#0e1116' },
};

function readCache(): InstanceSettingsView | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<InstanceSettingsView>;
    if (typeof parsed.accent !== 'string') return null;
    return { ...INSTANCE_SETTINGS_DEFAULTS, ...parsed };
  } catch {
    return null;
  }
}

function writeCache(s: InstanceSettingsView): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(s));
  } catch {
    /* quota / private mode — ignore, server still has it */
  }
}

/**
 * Write the settings into the actual DOM: CSS vars on `:root`, density
 * data-attribute, and `document.title`. Pure side-effect; no React.
 */
export function applyInstanceSettings(s: InstanceSettingsView): void {
  const root = document.documentElement;
  root.style.setProperty('--amber', s.accent);
  const tint = BG_TINT_PALETTES[s.bgTint] ?? BG_TINT_PALETTES.warm;
  root.style.setProperty('--bg', tint.bg);
  root.style.setProperty('--bg-2', tint.bg2);
  root.style.fontSize = `${s.fontSize}px`;
  root.dataset.density = s.density;
  document.title = s.instanceLabel ? `${s.instanceLabel} — swarm-os` : 'swarm-os';
}

/**
 * Synchronous bootstrap to call BEFORE React renders (from `main.tsx`).
 * Applies whatever is in localStorage so the first frame is correctly
 * themed; falls back to defaults if no cache yet.
 */
export function applyCachedInstanceSettings(): void {
  applyInstanceSettings(readCache() ?? INSTANCE_SETTINGS_DEFAULTS);
}

// ---- Module-level subscribable store ---------------------------------------
// useSyncExternalStore needs a single source of truth so all hook callers
// re-render together (the SettingsDrawer panel vs. the top-bar pill).

interface StoreState {
  settings: InstanceSettingsView;
  loading: boolean;
  error: string | null;
}

let storeState: StoreState = {
  settings: readCache() ?? INSTANCE_SETTINGS_DEFAULTS,
  loading: true,
  error: null,
};
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): StoreState {
  return storeState;
}

function setStoreState(next: StoreState): void {
  storeState = next;
  for (const cb of listeners) cb();
}

/**
 * Cross-tab sync: when another tab writes the cache, re-apply locally.
 * Bound once (idempotent: same handler — the second `addEventListener`
 * call with the same reference is a no-op).
 */
function onStorage(e: StorageEvent): void {
  if (e.key !== CACHE_KEY || !e.newValue) return;
  const incoming = readCache();
  if (!incoming) return;
  applyInstanceSettings(incoming);
  setStoreState({ ...storeState, settings: incoming });
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', onStorage);
}

let fetchInFlight = false;

/**
 * Fetch the server's view and reconcile with whatever's cached. We trust the
 * server unconditionally — if the cache and server disagree, server wins,
 * even when its `updatedAt` is older (it's authoritative because reset to
 * defaults is also a server-side action).
 */
async function loadFromServer(): Promise<void> {
  if (fetchInFlight) return;
  fetchInFlight = true;
  try {
    const res = await api.getInstanceSettings();
    applyInstanceSettings(res.settings);
    writeCache(res.settings);
    setStoreState({ settings: res.settings, loading: false, error: null });
  } catch (err) {
    setStoreState({
      ...storeState,
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    fetchInFlight = false;
  }
}

let bootRequested = false;
function ensureLoaded(): void {
  if (bootRequested) return;
  bootRequested = true;
  void loadFromServer();
}

export interface UseInstanceSettingsResult extends StoreState {
  /** Apply a partial update — PATCH server, then mirror locally. Throws on failure. */
  setSettings: (patch: InstanceSettingsPatch) => Promise<void>;
  /** Reset to in-code defaults (server-side). Throws on failure. */
  resetSettings: () => Promise<void>;
  /** Re-fetch from server (manual refresh). */
  refresh: () => Promise<void>;
}

export function useInstanceSettings(): UseInstanceSettingsResult {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    ensureLoaded();
  }, []);

  const setSettings = useCallback(async (patch: InstanceSettingsPatch) => {
    const previous = storeState.settings;
    try {
      const res = await api.patchInstanceSettings(patch);
      applyInstanceSettings(res.settings);
      writeCache(res.settings);
      setStoreState({ settings: res.settings, loading: false, error: null });
    } catch (err) {
      // Roll back: re-apply the prior state so the UI doesn't show a value
      // the server never accepted.
      applyInstanceSettings(previous);
      setStoreState({
        ...storeState,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }, []);

  const resetSettings = useCallback(async () => {
    try {
      const res = await api.resetInstanceSettings();
      applyInstanceSettings(res.settings);
      writeCache(res.settings);
      setStoreState({ settings: res.settings, loading: false, error: null });
    } catch (err) {
      setStoreState({
        ...storeState,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }, []);

  return { ...state, setSettings, resetSettings, refresh: loadFromServer };
}

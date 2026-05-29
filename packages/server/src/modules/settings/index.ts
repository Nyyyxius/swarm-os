/**
 * Per-instance visual settings — single-row store backing the APPEARANCE
 * panel of the web SettingsDrawer.
 *
 * The point of this module is to let an operator differentiate multiple
 * swarm-os instances running in parallel (prod / dev / lab) at a glance:
 * each instance can pick its own label and accent. Settings are per-instance
 * (not per-user) so all tabs on the same server see the same theme.
 *
 * Persistence: singleton row `instance_settings(id='current')` in SQLite.
 * The row is created lazily on first PATCH — until then, `get()` returns the
 * defaults defined below. Defaults are also exported so the web client can
 * hydrate identically on the very first render before the server is reached.
 */
import type { SwarmDb, InstanceSettingsRow } from '../db/index.js';

export type BgTint = 'warm' | 'neutral' | 'cool';
export type Density = 'compact' | 'regular' | 'comfy';

export interface InstanceSettings {
  /** Optional short label shown in the top-bar pill (e.g. "PROD", "DEV-A"). */
  instanceLabel: string | null;
  /** Accent color hex, applied as `--amber` override on `:root`. */
  accent: string;
  /** Background tint preset, drives `--bg`/`--bg-2`. */
  bgTint: BgTint;
  /** Base UI font-size in px. */
  fontSize: number;
  /** UI density preset; consumed via `data-density` on `<html>`. */
  density: Density;
  /**
   * Dark-mode flag. Stored for forward-compat, but v1 only supports dark —
   * the toggle in the UI is grayed out. Flipping it has no visual effect yet.
   */
  darkMode: boolean;
  /** ISO 8601 timestamp of the last PATCH (or DEFAULT_UPDATED_AT before first PATCH). */
  updatedAt: string;
}

export type InstanceSettingsPatch = Partial<Omit<InstanceSettings, 'updatedAt'>>;

export const VALID_BG_TINTS: readonly BgTint[] = ['warm', 'neutral', 'cool'];
export const VALID_DENSITIES: readonly Density[] = ['compact', 'regular', 'comfy'];
export const FONT_SIZE_MIN = 11;
export const FONT_SIZE_MAX = 16;
export const INSTANCE_LABEL_MAX_LEN = 16;
export const ACCENT_HEX_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Sentinel `updatedAt` used when the DB row is absent. Stable so the web
 * client can recognize "I'm still on defaults" vs. "user has saved something".
 * The epoch is fine — any real PATCH writes the current ISO string.
 */
const DEFAULT_UPDATED_AT = '1970-01-01T00:00:00.000Z';

export const DEFAULT_INSTANCE_SETTINGS: InstanceSettings = {
  instanceLabel: null,
  accent: '#ffb060',
  bgTint: 'warm',
  fontSize: 13,
  density: 'regular',
  darkMode: true,
  updatedAt: DEFAULT_UPDATED_AT,
};

function rowToSettings(row: InstanceSettingsRow): InstanceSettings {
  return {
    instanceLabel: row.instance_label,
    accent: row.accent,
    bgTint: row.bg_tint as BgTint,
    fontSize: row.font_size,
    density: row.density as Density,
    darkMode: row.dark_mode === 1,
    updatedAt: row.updated_at,
  };
}

function settingsToRow(s: InstanceSettings): InstanceSettingsRow {
  return {
    id: 'current',
    instance_label: s.instanceLabel,
    accent: s.accent,
    bg_tint: s.bgTint,
    font_size: s.fontSize,
    density: s.density,
    dark_mode: s.darkMode ? 1 : 0,
    updated_at: s.updatedAt,
  };
}

export class SettingsStore {
  constructor(private readonly db: SwarmDb) {}

  /** Returns the persisted row, or the in-code defaults when none exists yet. */
  get(): InstanceSettings {
    const row = this.db.getInstanceSettings();
    return row ? rowToSettings(row) : { ...DEFAULT_INSTANCE_SETTINGS };
  }

  /**
   * Apply a partial patch on top of the current settings (defaults if none).
   * Validation must already have happened in the route layer — this method
   * trusts its inputs. Returns the new full settings object.
   */
  update(patch: InstanceSettingsPatch): InstanceSettings {
    const current = this.get();
    const next: InstanceSettings = {
      instanceLabel:
        patch.instanceLabel !== undefined ? patch.instanceLabel : current.instanceLabel,
      accent: patch.accent ?? current.accent,
      bgTint: patch.bgTint ?? current.bgTint,
      fontSize: patch.fontSize ?? current.fontSize,
      density: patch.density ?? current.density,
      darkMode: patch.darkMode ?? current.darkMode,
      updatedAt: new Date().toISOString(),
    };
    this.db.upsertInstanceSettings(settingsToRow(next));
    return next;
  }

  /** Reset to in-code defaults; writes the row so the change persists across restarts. */
  reset(): InstanceSettings {
    const next: InstanceSettings = {
      ...DEFAULT_INSTANCE_SETTINGS,
      updatedAt: new Date().toISOString(),
    };
    this.db.upsertInstanceSettings(settingsToRow(next));
    return next;
  }
}

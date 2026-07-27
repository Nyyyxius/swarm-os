/**
 * Per-instance operator preferences — single-row store backing the APPEARANCE
 * panel of the web SettingsDrawer.
 *
 * The point of this module is to let an operator differentiate multiple
 * swarm-os instances running in parallel (prod / dev / lab) at a glance:
 * each instance can pick its own label and accent. Settings are per-instance
 * (not per-user) so all tabs on the same server see the same theme.
 *
 * This module was purely visual until update detection landed:
 * `dismissedUpdateVersion` is NOT a visual knob, it is an operator decision
 * about a specific release. It lives here because it is per-instance, one row,
 * and already the place "what this operator chose for this instance" is kept —
 * a second singleton table would be ceremony, not clarity. The one consequence
 * to remember is spelled out on `reset()`.
 *
 * The second non-visual tenant is the OpenRouter API key (multi-provider Lot
 * 6b) — a real credential, and the reason this module now has a masking
 * discipline rather than being a plain row mapper. Read the block above
 * `openrouterApiKey` before touching it.
 *
 * Persistence: singleton row `instance_settings(id='current')` in SQLite.
 * The row is created lazily on first PATCH — until then, `get()` returns the
 * defaults defined below. Defaults are also exported so the web client can
 * hydrate identically on the very first render before the server is reached.
 */
import type { SwarmDb, InstanceSettingsRow } from '../db/index.js';
import { PASSWORD_SENTINEL } from '../plugins/config-schema.js';

/**
 * Re-exported, not re-declared: the masked value the settings routes emit must
 * be the SAME string the plugin config form already round-trips, or the web
 * would end up with two "•••" that differ by a codepoint and a form that
 * silently overwrites a secret with a lookalike.
 */
export { PASSWORD_SENTINEL };

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
  /**
   * Release version the operator dismissed — the badge stays hidden for
   * exactly that version and reappears for the next one. `null` = nothing
   * dismissed. NOT visual (see the module header); written by the update
   * service, never by the appearance panel.
   */
  dismissedUpdateVersion: string | null;
  /**
   * OpenRouter API key — **MASKED**, always either `PASSWORD_SENTINEL` (a key
   * is stored) or `null` (none). The plaintext is NEVER part of this object:
   * `SettingsStore.getOpenRouterApiKey()` is the only way to obtain it, and the
   * literal type here is what makes a misuse visible in an editor.
   *
   * Masking lives in the STORE, not in a route, on purpose. `get()` is served
   * verbatim by `GET /settings`, mirrored into the browser's localStorage by
   * `useInstanceSettings`, and read by the plugin façade — a redaction applied
   * at one route would leak through the next reader added.
   *
   * On the WRITE side (`InstanceSettingsPatch`) the same field accepts the
   * plaintext, the sentinel (= "I didn't retype it, keep what you have") or
   * `null`/`''` (= delete), exactly like a plugin password field.
   */
  openrouterApiKey: typeof PASSWORD_SENTINEL | null;
  /** ISO 8601 timestamp of the last PATCH (or DEFAULT_UPDATED_AT before first PATCH). */
  updatedAt: string;
}

/**
 * The row as it really is, credential included. Internal to this module —
 * nothing outside it should be able to hold this shape by accident.
 */
type StoredSettings = Omit<InstanceSettings, 'openrouterApiKey'> & {
  openrouterApiKey: string | null;
};

export type InstanceSettingsPatch = Partial<
  Omit<InstanceSettings, 'updatedAt' | 'openrouterApiKey'>
> & {
  /**
   * Plaintext key to store, `PASSWORD_SENTINEL` to keep the stored one, or
   * `null` to delete it. Absent = untouched.
   *
   * The sentinel alone cannot express deletion — that is precisely why `null`
   * is a distinct case and not folded into "empty means unchanged".
   */
  openrouterApiKey?: string | null;
};

export const VALID_BG_TINTS: readonly BgTint[] = ['warm', 'neutral', 'cool'];
export const VALID_DENSITIES: readonly Density[] = ['compact', 'regular', 'comfy'];
export const FONT_SIZE_MIN = 11;
export const FONT_SIZE_MAX = 16;
export const INSTANCE_LABEL_MAX_LEN = 16;
export const ACCENT_HEX_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Bounds for the OpenRouter key. Real ones are `sk-or-v1-<64 hex>` (73 chars),
 * so 512 leaves room for whatever OpenRouter does next while refusing a
 * pasted file.
 */
export const OPENROUTER_KEY_MAX_LEN = 512;
/**
 * Printable ASCII, no whitespace. This value is written into a 0600 env file
 * that the agent's remote shell SOURCES (`session.ts:_writeSecretEnvFile`);
 * `shellQuote` already makes any byte inert there, so this regex is defence in
 * depth plus a paste check — a key carrying a space or a newline is a truncated
 * copy that would fail authentication at spawn time with nothing to point at.
 */
export const OPENROUTER_KEY_RE = /^[\x21-\x7e]+$/;

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
  dismissedUpdateVersion: null,
  openrouterApiKey: null,
  updatedAt: DEFAULT_UPDATED_AT,
};

const DEFAULT_STORED_SETTINGS: StoredSettings = {
  ...DEFAULT_INSTANCE_SETTINGS,
  openrouterApiKey: null,
};

function rowToSettings(row: InstanceSettingsRow): StoredSettings {
  return {
    instanceLabel: row.instance_label,
    accent: row.accent,
    bgTint: row.bg_tint as BgTint,
    fontSize: row.font_size,
    density: row.density as Density,
    darkMode: row.dark_mode === 1,
    // `?? null` and not `row.x`: a row written before the migration reads back
    // as `undefined` on some driver paths, and `undefined` would serialize the
    // key away instead of saying "nothing dismissed".
    dismissedUpdateVersion: row.dismissed_update_version ?? null,
    openrouterApiKey: row.openrouter_api_key ?? null,
    updatedAt: row.updated_at,
  };
}

function settingsToRow(s: StoredSettings): InstanceSettingsRow {
  return {
    id: 'current',
    instance_label: s.instanceLabel,
    accent: s.accent,
    bg_tint: s.bgTint,
    font_size: s.fontSize,
    density: s.density,
    dark_mode: s.darkMode ? 1 : 0,
    dismissed_update_version: s.dismissedUpdateVersion,
    openrouter_api_key: s.openrouterApiKey,
    updated_at: s.updatedAt,
  };
}

/**
 * The single choke point between the stored row and everything that serves it.
 * Replaces the credential with the sentinel — the plugin mechanic
 * (`redactConfigForRead`, `plugins/config-schema.ts`) applied to a typed field:
 * a non-empty stored value becomes `PASSWORD_SENTINEL`, an absent one stays
 * `null` so the UI can tell "configured" from "not configured".
 */
function maskSettings(s: StoredSettings): InstanceSettings {
  return {
    ...s,
    openrouterApiKey:
      s.openrouterApiKey && s.openrouterApiKey.length > 0 ? PASSWORD_SENTINEL : null,
  };
}

/**
 * Resolve the credential for a write: `undefined` (absent) and the sentinel
 * both mean "keep what is stored", `null`/`''` mean delete, anything else is a
 * new key. Trimmed, because a pasted key drags a newline along and a stored
 * `"sk-…\n"` fails authentication with no visible cause.
 *
 * Mirrors `mergeConfigForWrite` (`plugins/config-schema.ts`) — with the one
 * thing that helper cannot express: deletion.
 */
function resolveApiKeyWrite(
  incoming: string | null | undefined,
  stored: string | null,
): string | null {
  if (incoming === undefined) return stored;
  if (incoming === PASSWORD_SENTINEL) return stored;
  if (incoming === null) return null;
  const trimmed = incoming.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export class SettingsStore {
  constructor(private readonly db: SwarmDb) {}

  /**
   * Returns the persisted row **with the OpenRouter key masked**, or the in-code
   * defaults when none exists yet. This is what every route serves; the
   * plaintext credential is only reachable through `getOpenRouterApiKey()`.
   */
  get(): InstanceSettings {
    return maskSettings(this._read());
  }

  /**
   * The OpenRouter API key in clear, or `null` when none is stored.
   *
   * SYNCHRONOUS and uncached on purpose: `OpencodeProvider.buildSpawn` is pure
   * and synchronous, and `resolveApiKey()` must see a rotation on the very next
   * spawn without a restart (this deployment is never recreated for a config
   * change). better-sqlite3 makes both free — this is one indexed read of one
   * row.
   *
   * The ONLY legitimate caller is the opencode adapter's key source. Never put
   * the result in a log, an event, or an HTTP response.
   */
  getOpenRouterApiKey(): string | null {
    const key = this._read().openrouterApiKey;
    return key && key.length > 0 ? key : null;
  }

  /** The stored row, credential included. Private — see `get()`. */
  private _read(): StoredSettings {
    const row = this.db.getInstanceSettings();
    return row ? rowToSettings(row) : { ...DEFAULT_STORED_SETTINGS };
  }

  /**
   * Apply a partial patch on top of the current settings (defaults if none).
   * Validation must already have happened in the route layer — this method
   * trusts its inputs. Returns the new full settings object, **masked** (same
   * contract as `get()`, so a route can hand it straight back).
   */
  update(patch: InstanceSettingsPatch): InstanceSettings {
    const current = this._read();
    const next: StoredSettings = {
      instanceLabel:
        patch.instanceLabel !== undefined ? patch.instanceLabel : current.instanceLabel,
      accent: patch.accent ?? current.accent,
      bgTint: patch.bgTint ?? current.bgTint,
      fontSize: patch.fontSize ?? current.fontSize,
      density: patch.density ?? current.density,
      darkMode: patch.darkMode ?? current.darkMode,
      dismissedUpdateVersion:
        patch.dismissedUpdateVersion !== undefined
          ? patch.dismissedUpdateVersion
          : current.dismissedUpdateVersion,
      openrouterApiKey: resolveApiKeyWrite(patch.openrouterApiKey, current.openrouterApiKey),
      updatedAt: new Date().toISOString(),
    };
    this.db.upsertInstanceSettings(settingsToRow(next));
    return maskSettings(next);
  }

  /**
   * Reset the APPEARANCE to in-code defaults; writes the row so the change
   * persists across restarts.
   *
   * `dismissedUpdateVersion` is deliberately PRESERVED: this button lives in
   * the appearance panel and means "undo my theme", so having it silently
   * resurrect an update badge the operator had dismissed would be a surprise
   * with no visible cause.
   *
   * `openrouterApiKey` is preserved for a stronger version of the same reason:
   * a theme reset that silently revoked a credential would take every opencode
   * team offline with no visible cause and nothing to correlate it to. Deleting
   * the key has its own explicit gesture (PATCH with `null`).
   */
  reset(): InstanceSettings {
    const current = this._read();
    const next: StoredSettings = {
      ...DEFAULT_STORED_SETTINGS,
      dismissedUpdateVersion: current.dismissedUpdateVersion,
      openrouterApiKey: current.openrouterApiKey,
      updatedAt: new Date().toISOString(),
    };
    this.db.upsertInstanceSettings(settingsToRow(next));
    return maskSettings(next);
  }
}

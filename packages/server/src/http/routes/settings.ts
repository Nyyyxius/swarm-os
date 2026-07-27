/**
 * `GET/PATCH /settings` — the per-instance singleton row.
 *
 * Since Lot 6b this route also carries the **OpenRouter API key** used by the
 * `opencode` provider, and it is the reason the header below exists.
 *
 * WHY HERE rather than a dedicated `/providers/openrouter/credentials`:
 *  - the value lives in the same `instance_settings` row this route already
 *    serves; a second route would be a second door onto one column;
 *  - a dedicated route would STILL have to publish "is a key configured?" on
 *    `/settings` (or the drawer needs a second fetch before it can render the
 *    form), i.e. two endpoints for one field;
 *  - the web drawer already holds this payload in a module-level store
 *    (`useInstanceSettings`), so the field renders and saves through the
 *    existing PATCH / rollback / error plumbing with no new client machinery.
 *
 * WHAT KEEPS IT SAFE is not this route: `SettingsStore.get()` returns the key
 * already masked as `PASSWORD_SENTINEL`, so no response built from it can leak
 * the credential — including future ones nobody has written yet.
 */
import { Router, type Request, type Response } from 'express';
import {
  type SettingsStore,
  type InstanceSettingsPatch,
  ACCENT_HEX_RE,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  INSTANCE_LABEL_MAX_LEN,
  OPENROUTER_KEY_MAX_LEN,
  OPENROUTER_KEY_RE,
  PASSWORD_SENTINEL,
  VALID_BG_TINTS,
  VALID_DENSITIES,
} from '../../modules/settings/index.js';

interface SettingsBody {
  instanceLabel?: unknown;
  accent?: unknown;
  bgTint?: unknown;
  fontSize?: unknown;
  density?: unknown;
  darkMode?: unknown;
  openrouterApiKey?: unknown;
}

/**
 * Build a validated patch from the request body. Returns `{ ok: false, error }`
 * on the first invalid field — partial application would be confusing UX,
 * better to make the operator fix and retry the whole change.
 */
function parsePatch(
  body: SettingsBody,
): { ok: true; value: InstanceSettingsPatch } | { ok: false; error: string } {
  const patch: InstanceSettingsPatch = {};

  if (body.instanceLabel !== undefined) {
    if (body.instanceLabel === null || body.instanceLabel === '') {
      patch.instanceLabel = null;
    } else if (typeof body.instanceLabel !== 'string') {
      return { ok: false, error: 'instanceLabel must be a string or null' };
    } else {
      const trimmed = body.instanceLabel.trim();
      if (trimmed.length === 0) {
        patch.instanceLabel = null;
      } else if (trimmed.length > INSTANCE_LABEL_MAX_LEN) {
        return {
          ok: false,
          error: `instanceLabel must be ≤ ${INSTANCE_LABEL_MAX_LEN} chars`,
        };
      } else {
        patch.instanceLabel = trimmed;
      }
    }
  }

  if (body.accent !== undefined) {
    if (typeof body.accent !== 'string' || !ACCENT_HEX_RE.test(body.accent)) {
      return { ok: false, error: 'accent must be a #rrggbb hex string' };
    }
    patch.accent = body.accent.toLowerCase();
  }

  if (body.bgTint !== undefined) {
    if (
      typeof body.bgTint !== 'string' ||
      !VALID_BG_TINTS.includes(body.bgTint as (typeof VALID_BG_TINTS)[number])
    ) {
      return { ok: false, error: `bgTint must be one of ${VALID_BG_TINTS.join('|')}` };
    }
    patch.bgTint = body.bgTint as (typeof VALID_BG_TINTS)[number];
  }

  if (body.fontSize !== undefined) {
    if (
      typeof body.fontSize !== 'number' ||
      !Number.isInteger(body.fontSize) ||
      body.fontSize < FONT_SIZE_MIN ||
      body.fontSize > FONT_SIZE_MAX
    ) {
      return {
        ok: false,
        error: `fontSize must be an integer between ${FONT_SIZE_MIN} and ${FONT_SIZE_MAX}`,
      };
    }
    patch.fontSize = body.fontSize;
  }

  if (body.density !== undefined) {
    if (
      typeof body.density !== 'string' ||
      !VALID_DENSITIES.includes(body.density as (typeof VALID_DENSITIES)[number])
    ) {
      return { ok: false, error: `density must be one of ${VALID_DENSITIES.join('|')}` };
    }
    patch.density = body.density as (typeof VALID_DENSITIES)[number];
  }

  if (body.darkMode !== undefined) {
    if (typeof body.darkMode !== 'boolean') {
      return { ok: false, error: 'darkMode must be a boolean' };
    }
    patch.darkMode = body.darkMode;
  }

  // OpenRouter credential. Three intents, and they must stay distinguishable:
  //   sentinel  → the operator did not retype it, keep the stored key;
  //   null / '' → delete it (the sentinel alone cannot express this);
  //   anything else → store it.
  // The error messages never echo the value back — a 400 that quotes a
  // mistyped credential puts it in a log or a screenshot.
  if (body.openrouterApiKey !== undefined) {
    if (body.openrouterApiKey === null) {
      patch.openrouterApiKey = null;
    } else if (typeof body.openrouterApiKey !== 'string') {
      return { ok: false, error: 'openrouterApiKey must be a string or null' };
    } else {
      const trimmed = body.openrouterApiKey.trim();
      if (trimmed.length === 0) {
        patch.openrouterApiKey = null;
      } else if (trimmed === PASSWORD_SENTINEL) {
        // Passed straight through for the store to interpret as "keep". MUST be
        // tested before the charset check below: the sentinel is U+2022, i.e.
        // deliberately outside the printable-ASCII set a real key lives in, so
        // validating it as a key would 400 every save that leaves the masked
        // field untouched — a form that refuses to save anything else.
        patch.openrouterApiKey = PASSWORD_SENTINEL;
      } else if (trimmed.length > OPENROUTER_KEY_MAX_LEN) {
        return {
          ok: false,
          error: `openrouterApiKey must be ≤ ${OPENROUTER_KEY_MAX_LEN} chars`,
        };
      } else if (!OPENROUTER_KEY_RE.test(trimmed)) {
        // Rejected rather than stored: this value ends up in a 0600 env file
        // sourced by the agent's remote shell. `shellQuote` already makes it
        // inert, so this is defence in depth AND a paste check — an embedded
        // space or newline is a truncated copy, and it would fail
        // authentication at spawn time with nothing pointing back here.
        return {
          ok: false,
          error:
            'openrouterApiKey must be printable ASCII with no spaces — check for a truncated paste',
        };
      } else {
        patch.openrouterApiKey = trimmed;
      }
    }
  }

  return { ok: true, value: patch };
}

export function createSettingsRouter(store: SettingsStore): Router {
  const router = Router();

  router.get('/settings', (_req: Request, res: Response) => {
    res.json({ settings: store.get() });
  });

  router.patch('/settings', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as SettingsBody;
    const parsed = parsePatch(body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    res.json({ settings: store.update(parsed.value) });
  });

  router.post('/settings/reset', (_req: Request, res: Response) => {
    res.json({ settings: store.reset() });
  });

  return router;
}

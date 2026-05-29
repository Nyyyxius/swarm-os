import { Router, type Request, type Response } from 'express';
import {
  type SettingsStore,
  type InstanceSettingsPatch,
  ACCENT_HEX_RE,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  INSTANCE_LABEL_MAX_LEN,
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

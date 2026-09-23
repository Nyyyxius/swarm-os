/**
 * `featureGate(features, name)` — Express middleware that 404s when a built-in
 * feature is disabled (docs/builtin-features.md D5).
 *
 * The contract mirrors the plugin `if (store)` guards: a disabled feature
 * answers `404 {error:'FEATURE_DISABLED', feature}` so the web hooks can tell
 * "turned off" apart from a genuine 500. It reads `features.isEnabled(name)`,
 * which is synchronous (a Map lookup) — this is the per-request gating point.
 *
 * NOT mounted on any router in Lot 1: it is created and unit-tested here; the
 * feature lots (3-8) mount it on their routers.
 */

import type { RequestHandler } from 'express';
import type { FeatureRegistry, FeatureName } from '../modules/features/registry.js';

export function featureGate(features: FeatureRegistry, name: FeatureName): RequestHandler {
  return (_req, res, next) => {
    if (features.isEnabled(name)) {
      next();
      return;
    }
    res.status(404).json({ error: 'FEATURE_DISABLED', feature: name });
  };
}

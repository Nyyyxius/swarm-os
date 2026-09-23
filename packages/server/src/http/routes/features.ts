/**
 * Built-in feature control-plane REST (mounted AFTER auth, like `/plugins`).
 *
 * Surface (docs/builtin-features.md D10):
 *  - `GET    /features`               → list every feature + its state
 *  - `POST   /features/:name/enable`  → enable (install+enable on `uninstalled`)
 *  - `POST   /features/:name/disable` → disable (data kept)
 *  - `DELETE /features/:name`         → uninstall + purge
 *
 * Simpler than the plugins router: there is no installer, no source/version, no
 * capability grant. Almost every transition here is valid and idempotent —
 * enable on `enabled` re-runs `start()`, disable on `disabled` re-runs `stop()`,
 * and enable on `uninstalled` is the documented install+enable — so the usual
 * reject is an UNKNOWN name (404).
 *
 * The ONE exception is the `approvals` 409 guard (docs/builtin-features.md D9):
 * `POST /features/approvals/disable` and `DELETE /features/approvals` are refused
 * with `409 APPROVALS_IN_USE` — naming the teams — while a live team could still
 * block on a human (see `listBlockingApprovalTeams`), because disabling approvals
 * removes the only remote unblock path. The operator switches those roles/teams
 * to bypass (or stops them) first, or confirms when none is concerned.
 */

import { Router, type Request, type Response } from 'express';
import {
  FeatureRegistry,
  FEATURE_NAMES,
  type FeatureName,
  type FeatureView,
} from '../../modules/features/registry.js';

const KNOWN = new Set<FeatureName>(FEATURE_NAMES);

function isFeatureName(x: string): x is FeatureName {
  return KNOWN.has(x as FeatureName);
}

/** Optional collaborators the router needs beyond the registry itself. */
export interface FeaturesRouterDeps {
  /**
   * D9 guard: names of the live teams that could still request an approval. When
   * it returns a non-empty list, disabling/uninstalling `approvals` is refused
   * with 409. Absent (tests / no spawner) → the guard is inert (disable passes).
   */
  listBlockingApprovalTeams?: () => string[];
}

export function createFeaturesRouter(
  features: FeatureRegistry,
  deps: FeaturesRouterDeps = {},
): Router {
  const router = Router();

  const viewOf = (name: FeatureName): FeatureView | undefined =>
    features.list().find((v) => v.name === name);

  /**
   * D9 — for `approvals` disable/uninstall, refuse (409) while a live team could
   * still block on a human. Returns `true` when it has answered the response
   * (caller must return), `false` to proceed. Any other feature: never blocks.
   */
  const approvalsGuardBlocks = (name: FeatureName, res: Response): boolean => {
    if (name !== 'approvals') return false;
    const teams = deps.listBlockingApprovalTeams?.() ?? [];
    if (teams.length === 0) return false;
    res.status(409).json({
      error: 'APPROVALS_IN_USE',
      teams,
      message: `Cannot turn off approvals: ${teams.length} live team(s) run in a permission mode that can request approval (${teams.join(
        ', ',
      )}). Disabling approvals removes the only remote way to unblock a waiting agent — switch these teams/roles to a bypass mode (or stop them) first.`,
    });
    return true;
  };

  router.get('/features', (_req: Request, res: Response) => {
    res.json({ features: features.list() });
  });

  router.post('/features/:name/enable', (req: Request<{ name: string }>, res: Response) => {
    const { name } = req.params;
    if (!isFeatureName(name)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    void features
      .enable(name)
      .then(() => res.json({ feature: viewOf(name) }))
      .catch((err: unknown) =>
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) }),
      );
  });

  router.post('/features/:name/disable', (req: Request<{ name: string }>, res: Response) => {
    const { name } = req.params;
    if (!isFeatureName(name)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    // D9: approvals disable is refused (409) while a non-bypass role/team is
    // running — disabling removes the last remote path to unblock an agent.
    if (approvalsGuardBlocks(name, res)) return;
    void features
      .disable(name)
      .then(() => res.json({ feature: viewOf(name) }))
      .catch((err: unknown) =>
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) }),
      );
  });

  router.delete('/features/:name', (req: Request<{ name: string }>, res: Response) => {
    const { name } = req.params;
    if (!isFeatureName(name)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    // D9: same 409 guard as disable above — uninstall also removes the remote
    // unblock path (and purges the queue), so it must not sneak past the guard.
    if (approvalsGuardBlocks(name, res)) return;
    void features
      .uninstall(name)
      .then(() => res.json({ feature: viewOf(name) }))
      .catch((err: unknown) =>
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) }),
      );
  });

  return router;
}

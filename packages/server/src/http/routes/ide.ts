import { Router, type Request, type Response } from 'express';
import type { Config } from '../../config.js';
import type { FeatureRegistry } from '../../modules/features/registry.js';

/**
 * `GET /ide-info` — hands the VS Code web (serve-web) connection details to an
 * already-authenticated web client (this router is mounted AFTER the
 * X-Auth-Token middleware). The editor is reverse-proxied under `basePath` on
 * the SAME origin as the app, so the client builds a same-origin iframe URL:
 *
 *   `${basePath}/?folder=${folder}&tkn=${token}`
 *
 * This inherits the app's existing TLS / ingress (no second port). The proxied
 * `<basePath>/*` is guarded by serve-web's `--connection-token` (== the
 * returned `token`), not by X-Auth-Token — an iframe navigation cannot send
 * the X-Auth-Token header.
 */
export function createIdeRouter(config: Config, features?: FeatureRegistry): Router {
  const router = Router();

  router.get('/ide-info', (_req: Request, res: Response) => {
    // The registry (not the boot-only env var) now governs the IDE's state, so
    // a hot toggle is honoured on the next `/ide-info` fetch. Same 404
    // `IDE_DISABLED` contract — the web `IdeOverlay` already handles it. Fail
    // open when no registry is wired (unit tests): behave as enabled.
    if (features && !features.isEnabled('ide')) {
      res.status(404).json({
        error: 'IDE_DISABLED',
        message: 'VS Code web is not enabled on this instance',
      });
      return;
    }
    res.json({
      basePath: config.ideBasePath,
      folder: config.workspaceRoot,
      token: config.ideToken,
    });
  });

  return router;
}

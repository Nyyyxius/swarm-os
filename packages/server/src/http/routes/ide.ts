import { Router, type Request, type Response } from 'express';
import type { Config } from '../../config.js';

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
export function createIdeRouter(config: Config): Router {
  const router = Router();

  router.get('/ide-info', (_req: Request, res: Response) => {
    if (!config.ideEnabled) {
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

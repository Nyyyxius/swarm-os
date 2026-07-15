/**
 * Plugin management REST routes (mounted AFTER auth, like `/roles`).
 *
 * J1 surface: list / get / scan / enable / disable / permissions / config /
 * uninstall. Install-from-source (npm/git/upload) and upgrade land in J3.
 */

import { Router, type Request, type Response } from 'express';
import * as path from 'node:path';
import type { PluginHost } from '../../modules/plugins/host.js';
import { PluginActivationError, PluginNotFoundError } from '../../modules/plugins/host.js';
import { loadManifest } from '../../modules/plugins/manifest.js';
import {
  parseConfigSchema,
  validateConfig,
  redactConfigForRead,
  mergeConfigForWrite,
} from '../../modules/plugins/config-schema.js';

interface EnableBody {
  grantedCapabilities?: unknown;
}
interface PermissionsBody {
  grantedCapabilities?: unknown;
}

function parseCapabilities(x: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (x == null) return { ok: true, value: [] };
  if (!Array.isArray(x) || !x.every((c) => typeof c === 'string')) {
    return { ok: false, error: 'grantedCapabilities must be an array of strings' };
  }
  return { ok: true, value: x as string[] };
}

export function createPluginsRouter(host: PluginHost, pluginsDir: string): Router {
  const router = Router();

  router.get('/plugins', (_req: Request, res: Response) => {
    res.json({ plugins: host.list() });
  });

  router.get('/plugins/:name', (req: Request<{ name: string }>, res: Response) => {
    try {
      const plugin = host.viewOf(req.params.name);
      let manifest: unknown = null;
      let config: Record<string, unknown> = {};
      try {
        const m = loadManifest(path.join(pluginsDir, req.params.name));
        manifest = m;
        // Redact password fields before the config ever leaves the server.
        const schema = parseConfigSchema(m.configSchema);
        config = redactConfigForRead(schema, host.getRawConfig(req.params.name));
      } catch {
        /* folder gone / invalid — return the row view without a manifest */
      }
      res.json({ plugin, manifest, config });
    } catch (err) {
      if (err instanceof PluginNotFoundError) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/plugins/scan', (_req: Request, res: Response) => {
    void host
      .scan()
      .then((plugins) => res.json({ plugins }))
      .catch((err: unknown) =>
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) }),
      );
  });

  router.post('/plugins/:name/enable', (req: Request<{ name: string }>, res: Response) => {
    const body = (req.body ?? {}) as EnableBody;
    const caps = parseCapabilities(body.grantedCapabilities);
    if (!caps.ok) {
      res.status(400).json({ error: caps.error });
      return;
    }
    const granted = body.grantedCapabilities === undefined ? undefined : caps.value;
    void host
      .enable(req.params.name, granted)
      .then((plugin) => res.json({ plugin }))
      .catch((err: unknown) => {
        if (err instanceof PluginNotFoundError) {
          res.status(404).json({ error: 'not found' });
          return;
        }
        if (err instanceof PluginActivationError) {
          res.status(422).json({
            error: err.message,
            last_error: err.view.lastError,
            plugin: err.view,
          });
          return;
        }
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
  });

  router.post('/plugins/:name/disable', (req: Request<{ name: string }>, res: Response) => {
    void host
      .disable(req.params.name)
      .then((plugin) => res.json({ plugin }))
      .catch((err: unknown) => {
        if (err instanceof PluginNotFoundError) {
          res.status(404).json({ error: 'not found' });
          return;
        }
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
  });

  router.put('/plugins/:name/permissions', (req: Request<{ name: string }>, res: Response) => {
    const body = (req.body ?? {}) as PermissionsBody;
    const caps = parseCapabilities(body.grantedCapabilities);
    if (!caps.ok) {
      res.status(400).json({ error: caps.error });
      return;
    }
    void host
      .setPermissions(req.params.name, caps.value)
      .then((plugin) => res.json({ plugin }))
      .catch((err: unknown) => {
        if (err instanceof PluginNotFoundError) {
          res.status(404).json({ error: 'not found' });
          return;
        }
        if (err instanceof PluginActivationError) {
          res.status(422).json({
            error: err.message,
            last_error: err.view.lastError,
            plugin: err.view,
          });
          return;
        }
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
  });

  router.put('/plugins/:name/config', (req: Request<{ name: string }>, res: Response) => {
    const body = (req.body ?? {}) as unknown;
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'config body must be a JSON object' });
      return;
    }
    // J2 — validate against the manifest's configSchema (when declared) and
    // preserve password fields the operator left as the masking sentinel.
    let config: Record<string, unknown> = body as Record<string, unknown>;
    let schema = null;
    try {
      schema = parseConfigSchema(loadManifest(path.join(pluginsDir, req.params.name)).configSchema);
    } catch {
      /* folder gone / invalid manifest — store verbatim (no schema to check) */
    }
    if (schema) {
      const merged = mergeConfigForWrite(schema, body as Record<string, unknown>, host.getRawConfig(req.params.name));
      const result = validateConfig(schema, merged);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      config = result.value;
    }
    void host
      .setConfig(req.params.name, config)
      .then((plugin) => res.json({ plugin }))
      .catch((err: unknown) => {
        if (err instanceof PluginNotFoundError) {
          res.status(404).json({ error: 'not found' });
          return;
        }
        if (err instanceof PluginActivationError) {
          res.status(422).json({
            error: err.message,
            last_error: err.view.lastError,
            plugin: err.view,
          });
          return;
        }
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
  });

  router.delete('/plugins/:name', (req: Request<{ name: string }>, res: Response) => {
    const purge = req.query.purge === 'true' || req.query.purge === '1';
    void host
      .uninstall(req.params.name, purge)
      .then(() => res.status(204).end())
      .catch((err: unknown) => {
        if (err instanceof PluginNotFoundError) {
          res.status(404).json({ error: 'not found' });
          return;
        }
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
  });

  return router;
}

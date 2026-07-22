/**
 * Plugin management REST routes (mounted AFTER auth, like `/roles`).
 *
 * J1/J2 surface: list / get / scan / enable / disable / permissions / config /
 * uninstall. J3 adds install-from-source (npm/git/upload/dir), upgrade, and a
 * reserved marketplace `catalog` placeholder.
 */

import express, { Router, type Request, type Response } from 'express';
import * as path from 'node:path';
import type { PluginHost } from '../../modules/plugins/host.js';
import { PluginActivationError, PluginNotFoundError } from '../../modules/plugins/host.js';
import {
  PluginInstaller,
  InstallValidationError,
  InstallSourceError,
  UploadRequiresNewUploadError,
  type InstallSource,
} from '../../modules/plugins/installer.js';
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

/** Map an installer error to its HTTP status + JSON body. Returns false if unhandled. */
function sendInstallerError(res: Response, err: unknown): boolean {
  if (err instanceof PluginNotFoundError) {
    res.status(404).json({ error: 'not found' });
    return true;
  }
  if (err instanceof UploadRequiresNewUploadError) {
    res.status(409).json({ error: err.message, code: 'UPLOAD_REQUIRES_NEW_UPLOAD' });
    return true;
  }
  if (err instanceof InstallValidationError) {
    res.status(422).json({ error: err.message, last_error: err.message });
    return true;
  }
  if (err instanceof InstallSourceError) {
    res.status(502).json({ error: err.message, last_error: err.message });
    return true;
  }
  if (err instanceof PluginActivationError) {
    res.status(422).json({ error: err.message, last_error: err.view.lastError, plugin: err.view });
    return true;
  }
  return false;
}

/** Validate + narrow the `POST /plugins/install` body to an InstallSource. */
function parseInstallSource(
  body: unknown,
): { ok: true; value: InstallSource } | { ok: false; error: string } {
  if (body == null || typeof body !== 'object') {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  const src = b.source;
  if (src === 'npm') {
    if (typeof b.spec !== 'string' || b.spec.trim() === '') {
      return { ok: false, error: 'npm source requires a non-empty "spec"' };
    }
    return { ok: true, value: { kind: 'npm', spec: b.spec.trim() } };
  }
  if (src === 'git') {
    if (typeof b.url !== 'string' || b.url.trim() === '') {
      return { ok: false, error: 'git source requires a non-empty "url"' };
    }
    const ref = typeof b.ref === 'string' && b.ref.trim() !== '' ? b.ref.trim() : undefined;
    // Optional: install a plugin that lives in a SUBDIRECTORY of the repo. The
    // installer copies only <clone>/<subdir> into the plugin root (anti-traversal
    // enforced there). `ref` is a branch or tag (shallow clone), never a SHA.
    const subdir =
      typeof b.subdir === 'string' && b.subdir.trim() !== '' ? b.subdir.trim() : undefined;
    return { ok: true, value: { kind: 'git', url: b.url.trim(), ref, subdir } };
  }
  if (src === 'dir') {
    if (typeof b.dir !== 'string' || b.dir.trim() === '') {
      return { ok: false, error: 'dir source requires a non-empty "dir"' };
    }
    return { ok: true, value: { kind: 'dir', dir: b.dir.trim() } };
  }
  return { ok: false, error: "source must be one of 'npm' | 'git' | 'dir'" };
}

export function createPluginsRouter(
  host: PluginHost,
  pluginsDir: string,
  installer?: PluginInstaller,
): Router {
  const router = Router();

  router.get('/plugins', (_req: Request, res: Response) => {
    res.json({ plugins: host.list() });
  });

  // Marketplace placeholder (source_kind 'registry' reserved) — 501 until J4+.
  router.get('/plugins/catalog', (_req: Request, res: Response) => {
    res.status(501).json({
      error: 'plugin marketplace is not implemented',
      code: 'NOT_IMPLEMENTED',
      catalog: [],
    });
  });

  // Install from npm / git / dir. Registered before `GET /plugins/:name` is
  // irrelevant (POST), but grouped with the other write ops for readability.
  router.post('/plugins/install', (req: Request, res: Response) => {
    if (!installer) {
      res.status(503).json({ error: 'installer unavailable' });
      return;
    }
    const parsed = parseInstallSource(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    void installer
      .install(parsed.value)
      .then((r) =>
        res.json({ plugin: r.view, isUpgrade: r.isUpgrade, newCapabilities: r.newCapabilities }),
      )
      .catch((err: unknown) => {
        if (sendInstallerError(res, err)) return;
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
  });

  // Upload a `.tgz` (npm pack format). Raw body ONLY on this route: the global
  // `express.json` ignores these content-types (so the stream is untouched) and
  // its ~128 KB cap is the wrong bound — `express.raw` caps at 50 MB and a
  // too-large body surfaces as `entity.too.large` → 413 via the app error
  // handler (main.ts). A JSON content-type isn't a Buffer here → clean 415.
  router.post(
    '/plugins/upload',
    express.raw({ type: ['application/gzip', 'application/octet-stream'], limit: '50mb' }),
    (req: Request, res: Response) => {
      if (!installer) {
        res.status(503).json({ error: 'installer unavailable' });
        return;
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(415).json({
          error: 'upload body must be a .tgz sent as application/gzip',
          code: 'UNSUPPORTED_MEDIA_TYPE',
        });
        return;
      }
      const name = typeof req.query.name === 'string' ? req.query.name : undefined;
      void installer
        .install({ kind: 'upload', tgz: req.body, name })
        .then((r) =>
          res.json({ plugin: r.view, isUpgrade: r.isUpgrade, newCapabilities: r.newCapabilities }),
        )
        .catch((err: unknown) => {
          if (sendInstallerError(res, err)) return;
          res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        });
    },
  );

  router.post('/plugins/:name/upgrade', (req: Request<{ name: string }>, res: Response) => {
    if (!installer) {
      res.status(503).json({ error: 'installer unavailable' });
      return;
    }
    void installer
      .upgrade(req.params.name)
      .then((r) =>
        res.json({ plugin: r.view, isUpgrade: r.isUpgrade, newCapabilities: r.newCapabilities }),
      )
      .catch((err: unknown) => {
        if (sendInstallerError(res, err)) return;
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
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

/**
 * Plugin manifest — `plugin.json` schema + loader.
 *
 * Validated with the SERVER's zod (v4). The manifest DECLARES what a plugin
 * wants; the operator grants a subset in the UI. Everything here is a static
 * check performed before we ever `import()` a plugin's code.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { PLUGIN_CAPABILITIES, type PluginCapability } from './api-types.js';

/**
 * Host API contract version. A manifest with `apiVersion > HOST_API_VERSION`
 * is refused at enable — the host cannot honour a newer contract. Evolutions
 * of `SwarmPluginApi` stay ADDITIVE while this equals 1.
 */
export const HOST_API_VERSION = 1;

/** `name` doubles as the prefix for routes/tools/events — keep it URL/SQL-safe. */
export const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;

/**
 * Names that would collide with a built-in route/tool namespace. Refused at
 * install AND re-checked at load so a hand-dropped folder can't smuggle one in.
 */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'team',
  'swarm',
  'discord',
  'plugins',
  'api',
  'ws',
  'health',
  'info',
  'ide',
  'hooks',
  'metrics',
  'orchestrators',
  'sessions',
  'roles',
  'settings',
  'backup',
  'preambles',
]);

/**
 * `main` must be a plain relative path INSIDE the plugin dir — reject absolute
 * paths and any `..` traversal before it reaches `import()`.
 */
function isSafeMain(main: string): boolean {
  if (main.length === 0) return false;
  if (path.isAbsolute(main)) return false;
  const normalized = path.normalize(main);
  if (normalized.startsWith('..')) return false;
  if (normalized.split(/[\\/]/).includes('..')) return false;
  return true;
}

const capabilitySchema = z.enum(
  PLUGIN_CAPABILITIES as unknown as [PluginCapability, ...PluginCapability[]],
);

/**
 * A permissive sub-JSON-Schema slot. J1 stores it verbatim; J2 adds the
 * form generator + validator. Kept `unknown` here so an author can ship a
 * `configSchema` today without the host rejecting the manifest.
 */
const configSchemaSlot = z.record(z.string(), z.unknown()).optional();

export const manifestSchema = z
  .object({
    name: z
      .string()
      .regex(PLUGIN_NAME_RE, 'name must match ^[a-z][a-z0-9-]{1,40}$')
      .refine((n) => !RESERVED_NAMES.has(n), {
        message: 'name is reserved by a built-in namespace',
      }),
    version: z.string().min(1),
    displayName: z.string().optional(),
    description: z.string().optional(),
    main: z.string().refine(isSafeMain, {
      message: 'main must be a relative path inside the plugin (no absolute / no "..")',
    }),
    apiVersion: z.number().int().positive(),
    capabilities: z.array(capabilitySchema).default([]),
    configSchema: configSchemaSlot,
    agentAssets: z.object({ dir: z.string() }).optional(),
    connectors: z
      .array(
        z.object({
          type: z.string(),
          label: z.string(),
          schema: configSchemaSlot,
        }),
      )
      .optional(),
    uiPanels: z.array(z.unknown()).optional(),
  })
  // Tolerate forward-compatible fields authored against a newer host.
  .passthrough();

export type PluginManifest = z.infer<typeof manifestSchema>;

/** File name of the manifest inside a plugin directory. */
export const MANIFEST_FILE = 'plugin.json';

/**
 * Read + validate `<dir>/plugin.json`. Throws a descriptive `Error` on a
 * missing file, malformed JSON, or a schema violation — callers translate
 * that into `last_error` / an HTTP 422.
 */
export function loadManifest(dir: string): PluginManifest {
  const file = path.join(dir, MANIFEST_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`manifest not found: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.join('.') || '(root)';
    throw new Error(`invalid manifest: ${where} — ${first?.message ?? 'schema error'}`);
  }
  return result.data;
}

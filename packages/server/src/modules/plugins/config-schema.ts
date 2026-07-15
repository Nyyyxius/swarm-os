/**
 * Plugin config schema — a hand-rolled SUBSET of JSON Schema (plan §J2).
 *
 * A manifest may declare `configSchema` to drive an auto-generated UI form and
 * to validate `PUT /plugins/:name/config`. We intentionally support only a flat
 * object of scalar props (`string | number | boolean | enum`) — enough for the
 * tokens/toggles/URLs a plugin needs, without dragging in a full JSON Schema
 * validator.
 *
 * Password fields (`format: 'password'`) are masked on READ with a sentinel:
 *   - GET returns the sentinel `'•••'` in place of the stored secret.
 *   - A PUT whose field still equals the sentinel KEEPS the previously stored
 *     value (the operator didn't retype the secret) — same mechanic the plan
 *     reuses for connector tokens.
 */

export const PASSWORD_SENTINEL = '•••';

export type PluginConfigPropType = 'string' | 'number' | 'boolean';

export interface PluginConfigProp {
  type: PluginConfigPropType;
  /** Allowed values (string or number props only). Renders a <select>. */
  enum?: Array<string | number>;
  default?: string | number | boolean;
  title?: string;
  description?: string;
  /** `'password'` masks the value on read (string props only). */
  format?: 'password';
}

export interface PluginConfigSchema {
  type: 'object';
  properties: Record<string, PluginConfigProp>;
  required?: string[];
}

// ---------------------------------------------------------------------------
// Parse / validate the schema itself (from the manifest's untyped slot)
// ---------------------------------------------------------------------------

function isRecord(x: unknown): x is Record<string, unknown> {
  return x != null && typeof x === 'object' && !Array.isArray(x);
}

/**
 * Validate + narrow the manifest's `configSchema` slot into a
 * `PluginConfigSchema`. Returns `null` when absent or malformed (a malformed
 * schema simply disables form generation + validation rather than blocking the
 * plugin — the value is still stored verbatim).
 */
export function parseConfigSchema(raw: unknown): PluginConfigSchema | null {
  if (!isRecord(raw)) return null;
  if (raw.type !== 'object') return null;
  if (!isRecord(raw.properties)) return null;

  const properties: Record<string, PluginConfigProp> = {};
  for (const [key, val] of Object.entries(raw.properties)) {
    if (!isRecord(val)) return null;
    const type = val.type;
    if (type !== 'string' && type !== 'number' && type !== 'boolean') return null;
    const prop: PluginConfigProp = { type };
    if (Array.isArray(val.enum)) {
      const en = val.enum.filter(
        (e): e is string | number => typeof e === 'string' || typeof e === 'number',
      );
      if (en.length > 0) prop.enum = en;
    }
    if (
      typeof val.default === 'string' ||
      typeof val.default === 'number' ||
      typeof val.default === 'boolean'
    ) {
      prop.default = val.default;
    }
    if (typeof val.title === 'string') prop.title = val.title;
    if (typeof val.description === 'string') prop.description = val.description;
    if (val.format === 'password' && type === 'string') prop.format = 'password';
    properties[key] = prop;
  }

  const schema: PluginConfigSchema = { type: 'object', properties };
  if (Array.isArray(raw.required)) {
    schema.required = raw.required.filter((r): r is string => typeof r === 'string');
  }
  return schema;
}

// ---------------------------------------------------------------------------
// Validate an incoming config object against a schema
// ---------------------------------------------------------------------------

export type ValidateResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Validate `input` against `schema`. Unknown keys are dropped. Missing props
 * fall back to `default`; missing `required` props without a default fail.
 * Returns the normalised object (defaults applied, types coerced where safe).
 */
export function validateConfig(
  schema: PluginConfigSchema,
  input: unknown,
): ValidateResult {
  if (!isRecord(input)) {
    return { ok: false, error: 'config must be a JSON object' };
  }
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    const present = Object.prototype.hasOwnProperty.call(input, key);
    let value = present ? input[key] : undefined;

    if (value === undefined || value === null) {
      if (prop.default !== undefined) {
        out[key] = prop.default;
        continue;
      }
      if (schema.required?.includes(key)) {
        return { ok: false, error: `missing required property '${key}'` };
      }
      continue;
    }

    // Type check.
    if (prop.type === 'string' && typeof value !== 'string') {
      return { ok: false, error: `property '${key}' must be a string` };
    }
    if (prop.type === 'boolean' && typeof value !== 'boolean') {
      return { ok: false, error: `property '${key}' must be a boolean` };
    }
    if (prop.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, error: `property '${key}' must be a finite number` };
      }
    }
    // Enum check.
    if (prop.enum && !prop.enum.includes(value as string | number)) {
      return {
        ok: false,
        error: `property '${key}' must be one of ${prop.enum.join(', ')}`,
      };
    }
    out[key] = value;
  }
  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// Password sentinel handling
// ---------------------------------------------------------------------------

/**
 * Produce a READ-safe view of `config`: every `format:'password'` field that
 * holds a non-empty stored value is replaced by the sentinel so the secret
 * never leaves the server.
 */
export function redactConfigForRead(
  schema: PluginConfigSchema | null,
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema) return { ...config };
  const out: Record<string, unknown> = { ...config };
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (prop.format === 'password') {
      const cur = out[key];
      if (typeof cur === 'string' && cur.length > 0) out[key] = PASSWORD_SENTINEL;
    }
  }
  return out;
}

/**
 * Merge a validated INCOMING config over the PREVIOUS stored config, preserving
 * password fields that the operator left as the sentinel (i.e. didn't retype).
 */
export function mergeConfigForWrite(
  schema: PluginConfigSchema | null,
  incoming: Record<string, unknown>,
  previous: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...incoming };
  if (!schema) return out;
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (prop.format === 'password' && out[key] === PASSWORD_SENTINEL) {
      // Sentinel echoed back untouched — keep the previously stored secret.
      if (Object.prototype.hasOwnProperty.call(previous, key)) {
        out[key] = previous[key];
      } else {
        delete out[key];
      }
    }
  }
  return out;
}

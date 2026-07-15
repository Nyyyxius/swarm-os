import { useCallback, useEffect, useState } from 'react';
import { api, HttpError } from '../../api/client';

/**
 * Auto-generated plugin config form (J2).
 *
 * Fetches `GET /plugins/:name` (manifest + redacted config), renders one input
 * per `configSchema` property, and saves via `PUT /plugins/:name/config`.
 *
 * Password fields (`format:'password'`) arrive already masked as the sentinel
 * `•••`; leaving a field on the sentinel preserves the stored secret server-
 * side (see `config-schema.ts`), so the form just round-trips whatever the
 * server returns.
 */

const PASSWORD_SENTINEL = '•••';

type ConfigPropType = 'string' | 'number' | 'boolean';

interface ConfigProp {
  type: ConfigPropType;
  enum?: Array<string | number>;
  default?: string | number | boolean;
  title?: string;
  description?: string;
  format?: 'password';
}

interface ConfigSchema {
  type: 'object';
  properties: Record<string, ConfigProp>;
  required?: string[];
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x != null && typeof x === 'object' && !Array.isArray(x);
}

/** Loosely parse the manifest's configSchema into the client-side subset. */
function parseSchema(manifest: unknown): ConfigSchema | null {
  if (!isRecord(manifest)) return null;
  const raw = manifest.configSchema;
  if (!isRecord(raw) || raw.type !== 'object' || !isRecord(raw.properties)) return null;
  const properties: Record<string, ConfigProp> = {};
  for (const [key, val] of Object.entries(raw.properties)) {
    if (!isRecord(val)) continue;
    const type = val.type;
    if (type !== 'string' && type !== 'number' && type !== 'boolean') continue;
    const prop: ConfigProp = { type };
    if (Array.isArray(val.enum)) {
      prop.enum = val.enum.filter(
        (e): e is string | number => typeof e === 'string' || typeof e === 'number',
      );
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
  const schema: ConfigSchema = { type: 'object', properties };
  if (Array.isArray(raw.required)) {
    schema.required = raw.required.filter((r): r is string => typeof r === 'string');
  }
  return schema;
}

function messageOf(err: unknown): string {
  if (err instanceof HttpError) {
    const body = err.body as { error?: string } | undefined;
    return body?.error || err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

interface Props {
  pluginName: string;
  /** Bump to force a refetch (e.g. after enable/reload). */
  rev?: number;
}

export function PluginConfigForm({ pluginName, rev = 0 }: Props) {
  const [schema, setSchema] = useState<ConfigSchema | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSaved(false);
    api
      .getPlugin(pluginName)
      .then(({ manifest, config }) => {
        if (cancelled) return;
        const s = parseSchema(manifest);
        setSchema(s);
        // Seed missing keys with their declared defaults.
        const seeded: Record<string, unknown> = { ...(config ?? {}) };
        if (s) {
          for (const [key, prop] of Object.entries(s.properties)) {
            if (seeded[key] === undefined && prop.default !== undefined) {
              seeded[key] = prop.default;
            }
          }
        }
        setValues(seeded);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(messageOf(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pluginName, rev]);

  const setField = useCallback((key: string, v: unknown) => {
    setValues((prev) => ({ ...prev, [key]: v }));
    setSaved(false);
  }, []);

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.setPluginConfig(pluginName, values);
      setSaved(true);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="field-help">loading config…</div>;
  if (!schema || Object.keys(schema.properties).length === 0) return null;

  const entries = Object.entries(schema.properties);

  return (
    <div className="role-section">
      <h3>
        <span>CONFIG</span>
      </h3>
      {error && (
        <div className="field-warn" role="alert" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}
      {entries.map(([key, prop]) => {
        const label = prop.title ?? key;
        const required = schema.required?.includes(key) ?? false;
        const value = values[key];
        return (
          <div className="field" key={key} style={{ marginBottom: 12 }}>
            <label>
              {(label + (required ? ' *' : '')).toUpperCase()}
            </label>
            {prop.type === 'boolean' ? (
              <input
                type="checkbox"
                checked={value === true}
                onChange={(e) => setField(key, e.target.checked)}
                style={{ width: 'auto', justifySelf: 'start' }}
              />
            ) : prop.enum ? (
              <select
                value={value == null ? '' : String(value)}
                onChange={(e) => {
                  const raw = e.target.value;
                  setField(key, prop.type === 'number' ? Number(raw) : raw);
                }}
              >
                <option value="" disabled>
                  — select —
                </option>
                {prop.enum.map((opt) => (
                  <option key={String(opt)} value={String(opt)}>
                    {String(opt)}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={
                  prop.format === 'password'
                    ? 'password'
                    : prop.type === 'number'
                      ? 'number'
                      : 'text'
                }
                value={value == null ? '' : String(value)}
                placeholder={
                  prop.format === 'password' && value === PASSWORD_SENTINEL
                    ? 'stored (leave to keep)'
                    : undefined
                }
                onChange={(e) => {
                  const raw = e.target.value;
                  setField(key, prop.type === 'number' ? (raw === '' ? '' : Number(raw)) : raw);
                }}
              />
            )}
            {prop.description && <span className="field-help">{prop.description}</span>}
          </div>
        );
      })}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 16 }}>
        <button className="btn" onClick={() => void save()} disabled={saving}>
          {saving ? 'SAVING…' : 'SAVE CONFIG'}
        </button>
        {saved && <span className="field-help" style={{ color: 'var(--ok)' }}>saved ✓</span>}
      </div>
    </div>
  );
}

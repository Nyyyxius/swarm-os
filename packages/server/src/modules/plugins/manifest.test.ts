import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  manifestSchema,
  loadManifest,
  HOST_API_VERSION,
  RESERVED_NAMES,
  PLUGIN_NAME_RE,
} from './manifest.js';

function base() {
  return {
    name: 'my-plugin',
    version: '1.0.0',
    main: 'dist/index.js',
    apiVersion: 1,
    capabilities: ['events', 'db-kv'],
  };
}

describe('plugin manifest schema', () => {
  it('accepts a well-formed manifest', () => {
    const r = manifestSchema.safeParse(base());
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.name).toBe('my-plugin');
      expect(r.data.capabilities).toEqual(['events', 'db-kv']);
    }
  });

  it('defaults capabilities to [] when omitted', () => {
    const { capabilities: _omit, ...rest } = base();
    const r = manifestSchema.safeParse(rest);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.capabilities).toEqual([]);
  });

  it('rejects an uppercase / invalid name', () => {
    expect(manifestSchema.safeParse({ ...base(), name: 'MyPlugin' }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base(), name: '1plugin' }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base(), name: 'a' }).success).toBe(false); // too short (min 2)
    expect(manifestSchema.safeParse({ ...base(), name: 'x'.repeat(60) }).success).toBe(false);
  });

  it('matches the documented name regex', () => {
    expect(PLUGIN_NAME_RE.test('echo')).toBe(true);
    expect(PLUGIN_NAME_RE.test('slack-bridge')).toBe(true);
    expect(PLUGIN_NAME_RE.test('Echo')).toBe(false);
    expect(PLUGIN_NAME_RE.test('-echo')).toBe(false);
  });

  it('rejects reserved names', () => {
    for (const name of RESERVED_NAMES) {
      expect(manifestSchema.safeParse({ ...base(), name }).success).toBe(false);
    }
    // Spot-check a couple explicitly.
    expect(manifestSchema.safeParse({ ...base(), name: 'roles' }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base(), name: 'discord' }).success).toBe(false);
  });

  it('rejects an unknown capability', () => {
    expect(manifestSchema.safeParse({ ...base(), capabilities: ['nope'] }).success).toBe(false);
  });

  it('rejects a non-positive / non-integer apiVersion', () => {
    expect(manifestSchema.safeParse({ ...base(), apiVersion: 0 }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base(), apiVersion: -1 }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base(), apiVersion: 1.5 }).success).toBe(false);
  });

  it('rejects a path-traversing or absolute main', () => {
    expect(manifestSchema.safeParse({ ...base(), main: '../../evil.js' }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base(), main: '/etc/passwd' }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base(), main: 'a/../../b.js' }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base(), main: '' }).success).toBe(false);
  });

  it('tolerates forward-compatible extra fields (passthrough)', () => {
    const r = manifestSchema.safeParse({ ...base(), futureField: { anything: true } });
    expect(r.success).toBe(true);
  });

  it('exports HOST_API_VERSION = 1', () => {
    expect(HOST_API_VERSION).toBe(1);
  });
});

describe('loadManifest', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads and validates plugin.json', () => {
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(base()));
    const m = loadManifest(dir);
    expect(m.name).toBe('my-plugin');
  });

  it('throws when the file is missing', () => {
    expect(() => loadManifest(dir)).toThrow(/manifest not found/);
  });

  it('throws on malformed JSON', () => {
    fs.writeFileSync(path.join(dir, 'plugin.json'), '{ not valid');
    expect(() => loadManifest(dir)).toThrow(/not valid JSON/);
  });

  it('throws with a field pointer on a schema violation', () => {
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ ...base(), name: 'ROLES' }));
    expect(() => loadManifest(dir)).toThrow(/invalid manifest/);
  });
});

import { describe, it, expect } from 'vitest';
import {
  parseConfigSchema,
  validateConfig,
  redactConfigForRead,
  mergeConfigForWrite,
  PASSWORD_SENTINEL,
  type PluginConfigSchema,
} from './config-schema.js';

const SCHEMA: PluginConfigSchema = {
  type: 'object',
  properties: {
    greeting: { type: 'string', default: 'pong' },
    count: { type: 'number' },
    verbose: { type: 'boolean', default: false },
    mode: { type: 'string', enum: ['a', 'b'] },
    token: { type: 'string', format: 'password' },
  },
  required: ['count'],
};

describe('parseConfigSchema', () => {
  it('parses a well-formed subset', () => {
    const s = parseConfigSchema({
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name' },
        secret: { type: 'string', format: 'password' },
      },
      required: ['name'],
    });
    expect(s).not.toBeNull();
    expect(s?.properties.name?.title).toBe('Name');
    expect(s?.properties.secret?.format).toBe('password');
    expect(s?.required).toEqual(['name']);
  });

  it('rejects a non-object / malformed schema', () => {
    expect(parseConfigSchema(undefined)).toBeNull();
    expect(parseConfigSchema({ type: 'array' })).toBeNull();
    expect(parseConfigSchema({ type: 'object' })).toBeNull(); // no properties
    expect(parseConfigSchema({ type: 'object', properties: { x: { type: 'weird' } } })).toBeNull();
  });

  it('only honours format:password on string props', () => {
    const s = parseConfigSchema({
      type: 'object',
      properties: { n: { type: 'number', format: 'password' } },
    });
    expect(s?.properties.n?.format).toBeUndefined();
  });
});

describe('validateConfig', () => {
  it('applies defaults and enforces required', () => {
    const r = validateConfig(SCHEMA, { count: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.greeting).toBe('pong');
      expect(r.value.verbose).toBe(false);
      expect(r.value.count).toBe(3);
    }
  });

  it('fails on a missing required prop with no default', () => {
    const r = validateConfig(SCHEMA, {});
    expect(r.ok).toBe(false);
  });

  it('rejects a wrong type', () => {
    const r = validateConfig(SCHEMA, { count: 'three' });
    expect(r.ok).toBe(false);
  });

  it('rejects an out-of-enum value', () => {
    const r = validateConfig(SCHEMA, { count: 1, mode: 'z' });
    expect(r.ok).toBe(false);
  });

  it('drops unknown keys', () => {
    const r = validateConfig(SCHEMA, { count: 1, bogus: 'x' });
    expect(r.ok).toBe(true);
    if (r.ok) expect('bogus' in r.value).toBe(false);
  });
});

describe('password sentinel', () => {
  it('redacts stored password fields on read', () => {
    const view = redactConfigForRead(SCHEMA, { greeting: 'hi', token: 'super-secret' });
    expect(view.token).toBe(PASSWORD_SENTINEL);
    expect(view.greeting).toBe('hi');
  });

  it('does not redact an empty password field', () => {
    const view = redactConfigForRead(SCHEMA, { token: '' });
    expect(view.token).toBe('');
  });

  it('preserves the previous secret when the sentinel is echoed back', () => {
    const merged = mergeConfigForWrite(
      SCHEMA,
      { greeting: 'yo', token: PASSWORD_SENTINEL },
      { token: 'old-secret' },
    );
    expect(merged.token).toBe('old-secret');
    expect(merged.greeting).toBe('yo');
  });

  it('accepts a freshly typed secret', () => {
    const merged = mergeConfigForWrite(
      SCHEMA,
      { token: 'new-secret' },
      { token: 'old-secret' },
    );
    expect(merged.token).toBe('new-secret');
  });
});

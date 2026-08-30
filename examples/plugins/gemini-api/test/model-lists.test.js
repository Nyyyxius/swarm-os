// Tests for `../lib/model-lists.js` — the plugin maintaining its own config form.
//
// This module writes to `plugin.json`, the file the host re-reads on EVERY
// `GET /plugins/:name` (`http/routes/plugins.ts:294-305`). That makes three
// failure modes worth pinning, none of which shows up on a happy path:
//
//  1. AN EMPTY `enum` IS WORSE THAN NO `enum`. The server ignores an empty array
//     (`config-schema.ts:66`) but the web form does not
//     (`PluginConfigForm.tsx:44-48`): it renders a `<select>` containing only the
//     disabled placeholder, and the field can no longer be set at all.
//  2. A VALUE OUTSIDE THE `enum` MAKES THE WHOLE FORM UNSAVABLE. `validateConfig`
//     rejects it (`config-schema.ts:137-142`) and a PUT carries every field, so a
//     single retired model id would block editing the API key too.
//  3. A HALF-WRITTEN MANIFEST TAKES THE PLUGIN DOWN. `loadManifest` would throw:
//     no config form, no capabilities, and the next enable fails.

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  applyEnums,
  buildEnums,
  classifyModel,
  refreshModelEnums,
  writeManifestAtomic,
  MODEL_SLOTS,
  REFRESH_KEY,
  REFRESH_SUMMARY_KEY,
} from '../lib/model-lists.js';

/** A plausible slice of what `GET /v1beta/models` returns. */
const LIVE = [
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-2.5-flash',
  'gemini-3.1-flash-image',
  'gemini-3-pro-image',
  'gemini-3.1-flash-tts-preview',
  'gemini-2.5-pro-preview-tts',
  'lyria-3-clip-preview',
  'lyria-3-pro-preview',
  'lyria-realtime-exp',
  'veo-3.1-generate-preview',
  'veo-3.1-fast-generate-preview',
  'imagen-4.0-generate',
  'gemini-embedding-001',
  'gemini-3.1-flash-live-preview',
  'gemini-2.5-computer-use-preview-10-2025',
  'gemma-3-27b-it',
  'aqa',
];

function manifestFixture() {
  return {
    name: 'gemini-api',
    version: '0.1.0',
    main: 'index.js',
    configSchema: {
      type: 'object',
      properties: {
        apiKey: { type: 'string', format: 'password' },
        textModel: { type: 'string', default: 'gemini-3.7-flash', title: 'Modele texte' },
        imageModel: { type: 'string', default: 'gemini-3.1-flash-image' },
        ttsModel: { type: 'string', default: 'gemini-3.1-flash-tts-preview' },
        musicModel: { type: 'string', default: 'lyria-3-clip-preview' },
        videoModel: { type: 'string', default: 'veo-3.1-generate-preview' },
        outputDir: { type: 'string', default: 'gemini' },
      },
      required: ['apiKey'],
    },
  };
}

describe('classifyModel', () => {
  it('routes each family to its slot', () => {
    expect(classifyModel('gemini-3.7-flash')).toBe('textModel');
    expect(classifyModel('gemma-3-27b-it')).toBe('textModel');
    expect(classifyModel('gemini-3.1-flash-image')).toBe('imageModel');
    expect(classifyModel('gemini-3.1-flash-tts-preview')).toBe('ttsModel');
    expect(classifyModel('lyria-3-clip-preview')).toBe('musicModel');
    expect(classifyModel('veo-3.1-fast-generate-preview')).toBe('videoModel');
  });

  it('lets the most specific rule win — a TTS model is not a text model', () => {
    // `gemini-3.1-flash-tts-preview` matches the `gemini-` family too; offering
    // it in the text dropdown would produce audio where prose was expected.
    expect(classifyModel('gemini-3.1-flash-tts-preview')).not.toBe('textModel');
    expect(classifyModel('gemini-3.1-flash-image')).not.toBe('textModel');
  });

  it('excludes models THIS PLUGIN cannot drive, not just models Google retired', () => {
    // WebSocket-only, `:predict`-only, or a different protocol entirely: a
    // dropdown that offers them lets an operator pick a guaranteed failure.
    expect(classifyModel('lyria-realtime-exp')).toBeNull();
    expect(classifyModel('gemini-3.1-flash-live-preview')).toBeNull();
    expect(classifyModel('gemini-2.5-flash-native-audio-preview-12-2025')).toBeNull();
    expect(classifyModel('imagen-4.0-generate')).toBeNull();
    expect(classifyModel('gemini-embedding-001')).toBeNull();
    expect(classifyModel('gemini-2.5-computer-use-preview-10-2025')).toBeNull();
    expect(classifyModel('aqa')).toBeNull();
  });

  it('is null-safe and case-insensitive', () => {
    expect(classifyModel('VEO-3.1-GENERATE-PREVIEW')).toBe('videoModel');
    expect(classifyModel('')).toBeNull();
    expect(classifyModel(undefined)).toBeNull();
    expect(classifyModel(42)).toBeNull();
  });
});

describe('buildEnums', () => {
  it('fills every slot from the live list, newest-ish first', () => {
    const out = buildEnums(LIVE, {});
    expect(out.textModel[0]).toBe('gemini-3.7-flash'); // descending sort
    expect(out.textModel).toContain('gemma-3-27b-it');
    expect(out.imageModel).toEqual(['gemini-3.1-flash-image', 'gemini-3-pro-image']);
    expect(out.musicModel).toEqual(['lyria-3-pro-preview', 'lyria-3-clip-preview']);
    expect(out.videoModel).toHaveLength(2);
  });

  it('ALWAYS keeps the configured value, even one Google no longer lists', () => {
    // Otherwise `validateConfig` rejects it and the operator cannot save the
    // form at all — not even to fix the API key.
    const out = buildEnums(LIVE, { textModel: 'gemini-1.0-retired' });
    expect(out.textModel).toContain('gemini-1.0-retired');
  });

  it('never invents a slot the live list cannot fill', () => {
    // No candidates -> the key is ABSENT, which the caller turns into "no enum",
    // which the form renders as free text. An empty array here would produce a
    // dropdown with nothing in it.
    const out = buildEnums(['gemini-3.7-flash'], {});
    expect(out.textModel).toHaveLength(1);
    expect(out.videoModel).toBeUndefined();
    expect(out.musicModel).toBeUndefined();
  });

  it('deduplicates and survives a garbage list', () => {
    expect(buildEnums(['veo-1', 'veo-1', '', null, 7], {}).videoModel).toEqual(['veo-1']);
    expect(buildEnums(null, {})).toEqual({});
  });
});

describe('applyEnums', () => {
  it('writes the enum and reports the change', () => {
    const m = manifestFixture();
    const res = applyEnums(m, buildEnums(LIVE, {}));
    expect(res.changed).toBe(true);
    expect(res.applied).toEqual(MODEL_SLOTS);
    expect(m.configSchema.properties.videoModel.enum).toContain('veo-3.1-generate-preview');
  });

  it('is idempotent — a second pass with the same list changes nothing', () => {
    const m = manifestFixture();
    const enums = buildEnums(LIVE, {});
    applyEnums(m, enums);
    expect(applyEnums(m, enums).changed).toBe(false);
  });

  it('REMOVES an enum that can no longer be filled, restoring free text', () => {
    const m = manifestFixture();
    applyEnums(m, buildEnums(LIVE, {}));
    const res = applyEnums(m, buildEnums(['gemini-3.7-flash'], {}));
    expect(res.cleared).toContain('videoModel');
    expect(m.configSchema.properties.videoModel.enum).toBeUndefined();
    expect('enum' in m.configSchema.properties.videoModel).toBe(false);
  });

  it('touches nothing but the five model slots', () => {
    const m = manifestFixture();
    applyEnums(m, buildEnums(LIVE, {}));
    expect(m.configSchema.properties.apiKey).toEqual({ type: 'string', format: 'password' });
    expect(m.configSchema.properties.outputDir.enum).toBeUndefined();
    expect(m.configSchema.required).toEqual(['apiKey']);
    expect(m.version).toBe('0.1.0'); // version untouched: no rescan needed
  });

  it('preserves the other keys of the property it edits', () => {
    const m = manifestFixture();
    applyEnums(m, buildEnums(LIVE, {}));
    expect(m.configSchema.properties.textModel.default).toBe('gemini-3.7-flash');
    expect(m.configSchema.properties.textModel.title).toBe('Modele texte');
  });

  it('does nothing at all on a manifest with no configSchema', () => {
    expect(applyEnums({ name: 'x' }, buildEnums(LIVE, {}))).toMatchObject({ changed: false });
    expect(applyEnums(null, {})).toMatchObject({ changed: false });
  });
});

describe('writeManifestAtomic', () => {
  it('replaces the file and leaves no temp behind', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-mf-'));
    const file = path.join(dir, 'plugin.json');
    await fs.writeFile(file, JSON.stringify(manifestFixture()));
    const next = manifestFixture();
    next.configSchema.properties.videoModel.enum = ['veo-3.1-generate-preview'];

    await writeManifestAtomic(file, next);

    const back = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(back.configSchema.properties.videoModel.enum).toEqual(['veo-3.1-generate-preview']);
    expect((await fs.readdir(dir)).filter((f) => f !== 'plugin.json')).toEqual([]);
  });

  it('leaves the ORIGINAL intact when the write cannot complete', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-mf-'));
    const file = path.join(dir, 'plugin.json');
    const original = JSON.stringify(manifestFixture());
    await fs.writeFile(file, original);
    // A value JSON.stringify cannot serialise: the failure lands mid-write.
    const broken = manifestFixture();
    broken.self = broken;

    await expect(writeManifestAtomic(file, broken)).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe(original);
    expect((await fs.readdir(dir))).toEqual(['plugin.json']);
  });
});

describe('refreshModelEnums', () => {
  /** @type {string} */
  let dir;
  /** @type {any} */
  let rt;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-rt-'));
    await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify(manifestFixture(), null, 2));
    const store = new Map();
    rt = {
      manifestPath: path.join(dir, 'plugin.json'),
      cfg: {
        apiKey: 'k',
        textModel: 'gemini-3.7-flash',
        imageModel: 'gemini-3.1-flash-image',
        ttsModel: 'gemini-3.1-flash-tts-preview',
        musicModel: 'lyria-3-clip-preview',
        videoModel: 'veo-3.1-generate-preview',
      },
      log: { info: () => {}, warn: () => {}, debug: () => {} },
      kv: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), store },
      client: { listModels: async () => ({ ok: true, models: LIVE.map((name) => ({ name })) }) },
    };
  });

  const readManifest = async () => JSON.parse(await fs.readFile(rt.manifestPath, 'utf8'));

  it('turns the five free-text fields into dropdowns', async () => {
    const res = await refreshModelEnums(rt);
    expect(res).toMatchObject({ ok: true, changed: true });
    const m = await readManifest();
    for (const slot of MODEL_SLOTS) {
      expect(Array.isArray(m.configSchema.properties[slot].enum)).toBe(true);
      expect(m.configSchema.properties[slot].enum.length).toBeGreaterThan(0);
    }
    expect(JSON.parse(rt.kv.get(REFRESH_SUMMARY_KEY)).slots.videoModel).toBe(2);
  });

  it('throttles, and `force` bypasses the throttle', async () => {
    let calls = 0;
    rt.client.listModels = async () => {
      calls += 1;
      return { ok: true, models: LIVE.map((name) => ({ name })) };
    };
    await refreshModelEnums(rt);
    expect(await refreshModelEnums(rt)).toMatchObject({ skipped: 'throttled' });
    expect(calls).toBe(1);
    await refreshModelEnums(rt, { force: true });
    expect(calls).toBe(2);
  });

  it('reuses a list the caller already has instead of fetching again', async () => {
    let calls = 0;
    rt.client.listModels = async () => {
      calls += 1;
      return { ok: true, models: [] };
    };
    const res = await refreshModelEnums(rt, { liveNames: LIVE });
    expect(res).toMatchObject({ ok: true, changed: true });
    expect(calls).toBe(0);
  });

  it('leaves the manifest ALONE when there is no key, no client, or no list', async () => {
    const before = await fs.readFile(rt.manifestPath, 'utf8');

    expect(await refreshModelEnums({ ...rt, cfg: { ...rt.cfg, apiKey: '' } })).toMatchObject({
      skipped: 'not_configured',
    });
    expect(await refreshModelEnums({ ...rt, client: null })).toMatchObject({ skipped: 'not_configured' });
    expect(
      await refreshModelEnums({ ...rt, client: { listModels: async () => ({ ok: false, error: 'boom' }) } }),
    ).toMatchObject({ skipped: 'unavailable' });
    // An empty list parses fine but almost always means a broken call: clearing
    // every dropdown on it would be the worst possible reading.
    expect(
      await refreshModelEnums({ ...rt, client: { listModels: async () => ({ ok: true, models: [] }) } }, { force: true }),
    ).toMatchObject({ skipped: 'empty_list' });

    expect(await fs.readFile(rt.manifestPath, 'utf8')).toBe(before);
  });

  it('degrades to a warning on a read-only plugin directory', async () => {
    // Making the directory read-only is a SUPPORTED way to opt out: the fields
    // stay free text and nothing throws.
    await fs.chmod(dir, 0o555);
    try {
      const warnings = [];
      rt.log.warn = (o, m) => warnings.push(m);
      const res = await refreshModelEnums(rt);
      expect(res).toMatchObject({ ok: false, skipped: 'read_only' });
      expect(warnings.join(' ')).toMatch(/lecture seule/);
      const m = await readManifest();
      expect(m.configSchema.properties.textModel.enum).toBeUndefined();
    } finally {
      await fs.chmod(dir, 0o755);
    }
  });

  it('keeps a retired configured value selectable', async () => {
    rt.cfg.textModel = 'gemini-1.0-pro-retired';
    await refreshModelEnums(rt);
    const m = await readManifest();
    expect(m.configSchema.properties.textModel.enum).toContain('gemini-1.0-pro-retired');
  });

  it('never throws, whatever the runtime looks like', async () => {
    await expect(refreshModelEnums(null)).resolves.toMatchObject({ ok: false });
    await expect(refreshModelEnums({ ...rt, manifestPath: '' })).resolves.toMatchObject({ ok: false });
    await expect(
      refreshModelEnums({ ...rt, manifestPath: path.join(dir, 'nope.json') }, { force: true }),
    ).resolves.toMatchObject({ skipped: 'unreadable' });
  });

  it('claims the throttle slot before the call, so concurrent refreshes fetch once', async () => {
    let calls = 0;
    rt.client.listModels = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true, models: LIVE.map((name) => ({ name })) };
    };
    await Promise.all([refreshModelEnums(rt), refreshModelEnums(rt), refreshModelEnums(rt)]);
    expect(calls).toBe(1);
    expect(Number(rt.kv.get(REFRESH_KEY))).toBeGreaterThan(0);
  });
});

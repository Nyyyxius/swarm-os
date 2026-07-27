// Tests for `../lib/files.js` — the on-disk layout of the generated audio.
//
// Four things this file is here to pin down:
//
//  1. `slugify` produces an ASCII, filesystem-safe, bounded name out of
//     arbitrary prose — including prose that reduces to nothing.
//  2. The extension comes from the response's `Content-Type`, never from the
//     requested format, so a parametrised header must still map correctly.
//  3. `buildFileName` embeds random bytes: two agents synthesising the SAME
//     text during the SAME second must not silently overwrite each other.
//  4. `ensureOutputDir` re-checks the `.gitignore` on every call. It must NOT
//     be memoised — modules under `lib/` stay in Node's ESM cache across
//     enable/disable cycles (the loader busts `index.js` only), so a
//     "already written" flag would survive a reload and turn a deleted
//     `.gitignore` into a phantom bug.
//
// The filesystem cases run against `fs.mkdtemp` directories, never the repo.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  slugify,
  extFromContentType,
  dateDir,
  buildFileName,
  ensureOutputDir,
  writeAudio,
  sweep,
} from '../lib/files.js';

/** In-memory stand-in for `api.kv`. */
function makeKv(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    get: (k) => (store.has(k) ? store.get(k) : null),
    set: (k, v) => void store.set(k, v),
    _store: store,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Create `name` under `dir` and backdate its mtime by `ageMs`. */
async function makeAgedFile(dir, name, ageMs, body = 'x') {
  const abs = path.join(dir, name);
  await fs.writeFile(abs, body);
  const when = new Date(Date.now() - ageMs);
  await fs.utimes(abs, when, when);
  return abs;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

describe('slugify', () => {
  it('folds accents down to ASCII', () => {
    expect(slugify('Éléonore')).toBe('eleonore');
    expect(slugify('Où çà ? Déjà !')).toBe('ou-ca-deja');
  });

  it('replaces spaces and slashes with a single dash', () => {
    expect(slugify('bonjour le monde')).toBe('bonjour-le-monde');
    expect(slugify('a/b')).toBe('a-b');
    expect(slugify('a   b')).toBe('a-b');
    expect(slugify('a/../b')).toBe('a-b');
  });

  it('bounds the length to 32 characters', () => {
    const out = slugify('a'.repeat(200));
    expect(out.length).toBeLessThanOrEqual(32);
    expect(out).toBe('a'.repeat(32));
  });

  it('never leaves a leading or trailing dash, even after truncation', () => {
    const out = slugify(`${'ab '.repeat(20)}`);
    expect(out.length).toBeLessThanOrEqual(32);
    expect(out.startsWith('-')).toBe(false);
    expect(out.endsWith('-')).toBe(false);
  });

  it('falls back to `audio` when the input yields nothing', () => {
    expect(slugify('!!! ???')).toBe('audio');
    expect(slugify('')).toBe('audio');
    expect(slugify(undefined)).toBe('audio');
    expect(slugify(null)).toBe('audio');
  });

  it('only ever emits [a-z0-9-]', () => {
    expect(slugify('Ça 🎧 marche_bien (v2) !')).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('extFromContentType', () => {
  it('maps the known audio types', () => {
    expect(extFromContentType('audio/ogg')).toBe('.ogg');
    expect(extFromContentType('audio/webm')).toBe('.webm');
    expect(extFromContentType('audio/mpeg')).toBe('.mp3');
  });

  it('ignores parameters and case in the header value', () => {
    // What NovelAI actually sends: `audio/ogg; codecs=opus`.
    expect(extFromContentType('audio/ogg; codecs=opus')).toBe('.ogg');
    expect(extFromContentType('AUDIO/WEBM ; codecs=opus')).toBe('.webm');
    expect(extFromContentType('  audio/mpeg  ')).toBe('.mp3');
  });

  it('falls back to .bin for a missing or unknown type', () => {
    expect(extFromContentType(null)).toBe('.bin');
    expect(extFromContentType(undefined)).toBe('.bin');
    expect(extFromContentType('')).toBe('.bin');
    expect(extFromContentType('application/json')).toBe('.bin');
  });
});

describe('dateDir', () => {
  it('formats local time as YYYY-MM-DD with zero padding', () => {
    expect(dateDir(new Date(2026, 6, 5, 14, 32, 5))).toBe('2026-07-05');
  });
});

describe('buildFileName', () => {
  const args = () => ({ now: new Date(2026, 6, 27, 14, 32, 5), slug: 'bonjour ceci', index: 0, ext: '.ogg' });

  it('lays out <HHMMSS>-<slug>-<rand4>-<index><ext>', () => {
    expect(buildFileName(args())).toMatch(/^143205-bonjour-ceci-[0-9a-f]{4}-0\.ogg$/);
  });

  it('carries the index through', () => {
    expect(buildFileName({ ...args(), index: 3 })).toMatch(/-3\.ogg$/);
  });

  it('produces distinct names for identical arguments', () => {
    // The overwrite guard: two agents, same sentence, same second. The random
    // suffix is 16 bits, so a handful of collisions across 24 draws would be
    // normal and a *constant* name would not — that is the failure we assert
    // against, without making the test a coin flip.
    const names = Array.from({ length: 24 }, () => buildFileName(args()));
    expect(new Set(names).size).toBeGreaterThan(20);
  });
});

describe('ensureOutputDir', () => {
  /** @type {string} */
  let dir;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novelai-ensure-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates the directory recursively and drops a `*` .gitignore', async () => {
    const target = path.join(dir, 'novelai', '2026-07-27');
    await ensureOutputDir(target);

    const st = await fs.stat(target);
    expect(st.isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(target, '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('is idempotent and does not rewrite an existing .gitignore', async () => {
    const target = path.join(dir, 'novelai');
    await ensureOutputDir(target);
    await fs.writeFile(path.join(target, '.gitignore'), '*\n# edite par l operateur\n', 'utf8');

    await ensureOutputDir(target);

    expect(await fs.readFile(path.join(target, '.gitignore'), 'utf8')).toContain('# edite par l operateur');
  });

  it('recreates the .gitignore when it is deleted (no memoisation)', async () => {
    const target = path.join(dir, 'novelai');
    await ensureOutputDir(target);
    await fs.rm(path.join(target, '.gitignore'));
    expect(await exists(path.join(target, '.gitignore'))).toBe(false);

    // A memoised "already done" flag would survive the ESM cache across a
    // plugin reload and leave the workspace unprotected from `git add .`.
    await ensureOutputDir(target);

    expect(await fs.readFile(path.join(target, '.gitignore'), 'utf8')).toBe('*\n');
  });
});

describe('writeAudio', () => {
  /** @type {string} */
  let dir;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novelai-write-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes the bytes and reports the absolute container path and size', async () => {
    const data = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]);
    const res = await writeAudio({ absDir: dir, name: '143205-test-a7f3-0.ogg', data });

    expect(res.path).toBe(path.join(dir, '143205-test-a7f3-0.ogg'));
    expect(res.bytes).toBe(data.byteLength);

    const onDisk = await fs.readFile(res.path);
    expect(onDisk.equals(data)).toBe(true);
  });
});

describe('sweep', () => {
  /** @type {string} */
  let dir;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novelai-sweep-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('deletes audio older than retentionDays and keeps the rest', async () => {
    const old = await makeAgedFile(dir, 'old.ogg', 10 * DAY_MS);
    const fresh = await makeAgedFile(dir, 'fresh.ogg', 60 * 60 * 1000);

    await sweep({ absDir: dir, retentionDays: 7, kv: makeKv(), log: null });

    expect(await exists(old)).toBe(false);
    expect(await exists(fresh)).toBe(true);
  });

  it('descends exactly one level, into the date sub-directories', async () => {
    const day = path.join(dir, '2026-07-01');
    await fs.mkdir(day, { recursive: true });
    const nestedOld = await makeAgedFile(day, 'old.mp3', 10 * DAY_MS);
    const nestedFresh = await makeAgedFile(day, 'fresh.webm', 60 * 1000);

    const deeper = path.join(day, 'deeper');
    await fs.mkdir(deeper, { recursive: true });
    const tooDeep = await makeAgedFile(deeper, 'old.ogg', 10 * DAY_MS);

    await sweep({ absDir: dir, retentionDays: 7, kv: makeKv(), log: null });

    expect(await exists(nestedOld)).toBe(false);
    expect(await exists(nestedFresh)).toBe(true);
    expect(await exists(tooDeep)).toBe(true); // two levels down — out of scope
  });

  it('only touches audio extensions', async () => {
    const oldAudio = await makeAgedFile(dir, 'old.ogg', 10 * DAY_MS);
    const oldNote = await makeAgedFile(dir, 'old.txt', 10 * DAY_MS);
    const gitignore = await makeAgedFile(dir, '.gitignore', 10 * DAY_MS, '*\n');

    await sweep({ absDir: dir, retentionDays: 7, kv: makeKv(), log: null });

    expect(await exists(oldAudio)).toBe(false);
    expect(await exists(oldNote)).toBe(true);
    expect(await exists(gitignore)).toBe(true);
  });

  it('deletes nothing when retentionDays is 0 (never purge)', async () => {
    const old = await makeAgedFile(dir, 'old.ogg', 400 * DAY_MS);
    const kv = makeKv();

    await sweep({ absDir: dir, retentionDays: 0, kv, log: null });

    expect(await exists(old)).toBe(true);
    expect(kv.get('sweep.last')).toBeNull(); // not even a throttle slot claimed
  });

  it('runs at most once per hour, using the KV timestamp', async () => {
    const kv = makeKv();
    await makeAgedFile(dir, 'first.ogg', 10 * DAY_MS);

    await sweep({ absDir: dir, retentionDays: 7, kv, log: null });
    expect(Number(kv.get('sweep.last'))).toBeGreaterThan(0);

    // Second pass within the hour: the new stale file must survive.
    const second = await makeAgedFile(dir, 'second.ogg', 10 * DAY_MS);
    await sweep({ absDir: dir, retentionDays: 7, kv, log: null });
    expect(await exists(second)).toBe(true);

    // Push the timestamp back beyond the throttle window and it runs again.
    kv.set('sweep.last', String(Date.now() - 2 * 60 * 60 * 1000));
    await sweep({ absDir: dir, retentionDays: 7, kv, log: null });
    expect(await exists(second)).toBe(false);
  });

  it('never throws when the directory does not exist or the KV is unavailable', async () => {
    const missing = path.join(dir, 'nope');
    await expect(
      sweep({ absDir: missing, retentionDays: 7, kv: makeKv(), log: null }),
    ).resolves.toBeUndefined();

    const brokenKv = {
      get() {
        throw new Error('db-kv not granted');
      },
      set() {
        throw new Error('db-kv not granted');
      },
    };
    await expect(
      sweep({ absDir: dir, retentionDays: 7, kv: brokenKv, log: null }),
    ).resolves.toBeUndefined();
  });
});

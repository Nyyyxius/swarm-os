// Tests for `../lib/files.js` — bytes on disk.
//
// The load-bearing one is `toPlayableAudio`. Gemini TTS returns RAW PCM with no
// container: written as-is to `out.wav`, the file has a plausible size, a 200 on
// the wire, and no player will open it. Nothing else in the system notices. The
// mirror-image bug is just as silent — wrapping a WAV that already has a header
// produces 44 bytes of garbage before the real one. Both directions are pinned
// below, on the BYTES rather than on the advertised MIME, because the MIME is
// exactly what cannot be trusted here.
//
// The rest is containment and hygiene: a `.gitignore` in a bind-mounted Git
// repository, a name that two agents cannot collide on, and a sweep that only
// ever deletes what it recognises.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  blockTypeForMime,
  buildFileName,
  dateDir,
  ensureOutputDir,
  extFromMime,
  mimeFromName,
  pcmFormatFromMime,
  slugify,
  sweep,
  toPlayableAudio,
  wavHeader,
  writeMedia,
  PCM_DEFAULTS,
} from '../lib/files.js';

/** A KV good enough for the sweep's throttle. */
function memKv() {
  const store = new Map();
  return { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), store };
}

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-files-'));
}

describe('slugify', () => {
  it('strips accents rather than dropping the word', () => {
    expect(slugify('Éléonore au bord')).toBe('eleonore-au-bord');
  });

  it('collapses punctuation and trims the separators', () => {
    expect(slugify('  un chat !!! roux  ')).toBe('un-chat-roux');
  });

  it('never returns an empty name', () => {
    expect(slugify('!!!')).toBe('media');
    expect(slugify('')).toBe('media');
    expect(slugify(/** @type {never} */ (null))).toBe('media');
  });

  it('caps the length without leaving a trailing separator', () => {
    const out = slugify('a'.repeat(30) + ' ' + 'b'.repeat(30));
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith('-')).toBe(false);
  });
});

describe('extFromMime', () => {
  it('maps the media types the plugin produces', () => {
    expect(extFromMime('image/png')).toBe('.png');
    expect(extFromMime('image/jpeg')).toBe('.jpg');
    expect(extFromMime('audio/wav')).toBe('.wav');
    expect(extFromMime('audio/mpeg')).toBe('.mp3');
    expect(extFromMime('video/mp4')).toBe('.mp4');
  });

  it('ignores the parameters after the semicolon', () => {
    expect(extFromMime('image/png; charset=binary')).toBe('.png');
  });

  it('maps every raw-PCM spelling to .wav, because that is what it will become', () => {
    expect(extFromMime('audio/L16;codec=pcm;rate=24000')).toBe('.wav');
    expect(extFromMime('audio/pcm')).toBe('.wav');
  });

  it('falls back to the caller-supplied extension for an unknown type', () => {
    expect(extFromMime('application/x-nonsense', '.mp4')).toBe('.mp4');
    expect(extFromMime(null)).toBe('.bin');
  });
});

describe('mimeFromName / blockTypeForMime', () => {
  it('is case-insensitive on the extension', () => {
    expect(mimeFromName('/a/B.PNG')).toBe('image/png');
    expect(mimeFromName('x.PDF')).toBe('application/pdf');
  });

  it('returns null for an unknown or absent extension', () => {
    expect(mimeFromName('README')).toBeNull();
    expect(mimeFromName('a.xyz')).toBeNull();
  });

  it('routes each MIME family to the Interactions block type', () => {
    expect(blockTypeForMime('image/webp')).toBe('image');
    expect(blockTypeForMime('audio/flac')).toBe('audio');
    expect(blockTypeForMime('video/quicktime')).toBe('video');
    expect(blockTypeForMime('application/pdf')).toBe('document');
    expect(blockTypeForMime('text/plain')).toBe('document');
    expect(blockTypeForMime('application/zip')).toBeNull();
  });
});

describe('wavHeader / pcmFormatFromMime', () => {
  it('writes a canonical 44-byte RIFF/WAVE header', () => {
    const h = wavHeader(1000);
    expect(h.length).toBe(44);
    expect(h.toString('ascii', 0, 4)).toBe('RIFF');
    expect(h.readUInt32LE(4)).toBe(36 + 1000);
    expect(h.toString('ascii', 8, 12)).toBe('WAVE');
    expect(h.readUInt16LE(20)).toBe(1); // PCM
    expect(h.readUInt16LE(22)).toBe(PCM_DEFAULTS.channels);
    expect(h.readUInt32LE(24)).toBe(PCM_DEFAULTS.sampleRate);
    expect(h.readUInt32LE(40)).toBe(1000);
  });

  it('derives byteRate and blockAlign from the format, not from constants', () => {
    const h = wavHeader(0, { sampleRate: 48000, channels: 2, bitsPerSample: 16 });
    expect(h.readUInt16LE(32)).toBe(4); // blockAlign = channels * bits / 8
    expect(h.readUInt32LE(28)).toBe(48000 * 4);
  });

  it('reads the parameters Google states in the MIME itself', () => {
    expect(pcmFormatFromMime('audio/L16;codec=pcm;rate=48000;channels=2')).toEqual({
      sampleRate: 48000,
      channels: 2,
      bitsPerSample: 16,
    });
  });

  it('falls back to the documented TTS defaults when the MIME says nothing', () => {
    expect(pcmFormatFromMime(null)).toEqual(PCM_DEFAULTS);
    expect(pcmFormatFromMime('audio/wav')).toEqual(PCM_DEFAULTS);
  });
});

describe('toPlayableAudio — the file must actually play', () => {
  it('wraps raw PCM in a WAV header', () => {
    const pcm = Buffer.alloc(100, 7);
    const out = toPlayableAudio(pcm, 'audio/L16;codec=pcm;rate=24000');
    expect(out.wrapped).toBe(true);
    expect(out.ext).toBe('.wav');
    expect(out.data.length).toBe(144);
    expect(out.data.toString('ascii', 0, 4)).toBe('RIFF');
    expect(out.data.readUInt32LE(24)).toBe(24000);
    expect(out.data.subarray(44).equals(pcm)).toBe(true);
  });

  it('honours a non-default sample rate advertised in the MIME', () => {
    const out = toPlayableAudio(Buffer.alloc(8), 'audio/L16;rate=48000');
    expect(out.data.readUInt32LE(24)).toBe(48000);
  });

  it('NEVER double-wraps an existing WAV', () => {
    const wav = Buffer.concat([wavHeader(4), Buffer.from([1, 2, 3, 4])]);
    const out = toPlayableAudio(wav, 'audio/L16;rate=24000'); // MIME lies; bytes win
    expect(out.wrapped).toBe(false);
    expect(out.data.equals(wav)).toBe(true);
  });

  it('passes an MP3 through, by ID3 tag or by frame sync', () => {
    const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(10, 1)]);
    expect(toPlayableAudio(id3, 'audio/mpeg')).toMatchObject({ wrapped: false, ext: '.mp3' });
    const frame = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
    expect(toPlayableAudio(frame, null)).toMatchObject({ wrapped: false, ext: '.mp3' });
  });

  it('passes an Ogg container through', () => {
    const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(10)]);
    expect(toPlayableAudio(ogg, 'audio/ogg')).toMatchObject({ wrapped: false, ext: '.ogg' });
  });

  it('tolerates an empty or absurd payload without throwing', () => {
    expect(toPlayableAudio(Buffer.alloc(0), null).data.length).toBe(44);
    expect(toPlayableAudio(/** @type {never} */ (null), null).data.length).toBe(44);
  });
});

describe('buildFileName / dateDir', () => {
  it('embeds the time, the slug and the index', () => {
    const now = new Date(2026, 7, 19, 14, 5, 9);
    const name = buildFileName({ now, slug: 'un chat', index: 2, ext: '.png' });
    expect(name).toMatch(/^140509-un-chat-[0-9a-f]{4}-2\.png$/);
  });

  it('gives two identical calls DIFFERENT names (two agents, same second)', () => {
    const now = new Date(2026, 7, 19, 14, 5, 9);
    const a = buildFileName({ now, slug: 's', index: 0, ext: '.wav' });
    const b = buildFileName({ now, slug: 's', index: 0, ext: '.wav' });
    expect(a).not.toBe(b);
  });

  it('pads the date directory', () => {
    expect(dateDir(new Date(2026, 0, 3))).toBe('2026-01-03');
  });
});

describe('ensureOutputDir + writeMedia', () => {
  it('creates the tree and drops a .gitignore so the workspace repo stays clean', async () => {
    const dir = path.join(await tmpDir(), 'out', '2026-08-19');
    await ensureOutputDir(dir);
    expect(await fs.readFile(path.join(dir, '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('does not overwrite an existing .gitignore', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, '.gitignore'), 'custom\n');
    await ensureOutputDir(dir);
    expect(await fs.readFile(path.join(dir, '.gitignore'), 'utf8')).toBe('custom\n');
  });

  it('reports the byte count from the NORMALISED buffer, not from the input', async () => {
    const dir = await tmpDir();
    // A string payload writes fine but has no `.byteLength`; reporting undefined
    // here fails the tool's outputSchema and turns a success into an McpError.
    const written = await writeMedia({ absDir: dir, name: 'a.txt', data: 'abcd' });
    expect(written.bytes).toBe(4);
    expect(await fs.readFile(written.path, 'utf8')).toBe('abcd');
  });
});

describe('sweep', () => {
  it('deletes recognised media older than the retention and keeps the rest', async () => {
    const root = await tmpDir();
    const day = path.join(root, '2026-01-01');
    await fs.mkdir(day, { recursive: true });
    const old = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    const write = async (name, mtime) => {
      const p = path.join(day, name);
      await fs.writeFile(p, 'x');
      if (mtime) await fs.utimes(p, mtime, mtime);
      return p;
    };
    const stale = await write('a.mp4', old);
    const fresh = await write('b.mp4', null);
    const notes = await write('notes.txt', old); // unknown extension: never touched

    await sweep({ absDir: root, retentionDays: 7, kv: memKv() });

    await expect(fs.access(stale)).rejects.toThrow();
    await expect(fs.access(fresh)).resolves.toBeUndefined();
    await expect(fs.access(notes)).resolves.toBeUndefined();
  });

  it('does nothing when retention is 0 (never purge)', async () => {
    const root = await tmpDir();
    const old = new Date(Date.now() - 100 * 24 * 3600 * 1000);
    await fs.writeFile(path.join(root, 'a.mp3'), 'x');
    await fs.utimes(path.join(root, 'a.mp3'), old, old);
    await sweep({ absDir: root, retentionDays: 0, kv: memKv() });
    await expect(fs.access(path.join(root, 'a.mp3'))).resolves.toBeUndefined();
  });

  it('claims the throttle slot BEFORE walking, so two calls do not both sweep', async () => {
    const root = await tmpDir();
    const kv = memKv();
    await sweep({ absDir: root, retentionDays: 7, kv });
    const first = kv.get('sweep.last');
    expect(first).toBeTruthy();
    await sweep({ absDir: root, retentionDays: 7, kv });
    expect(kv.get('sweep.last')).toBe(first); // second pass skipped
  });

  it('never throws on a missing directory or a broken KV', async () => {
    const dead = {
      get() {
        throw new Error('no db-kv');
      },
      set() {
        throw new Error('no db-kv');
      },
    };
    await expect(sweep({ absDir: '/nonexistent/nope', retentionDays: 7, kv: memKv() })).resolves.toBeUndefined();
    await expect(sweep({ absDir: '/tmp', retentionDays: 7, kv: dead })).resolves.toBeUndefined();
  });
});

// files.js — everything about bytes on disk: what a generated file is called,
// where it lands, what its extension should be, how raw PCM becomes a playable
// WAV, and when old files are purged.
//
// Layout: <outputDir>/<YYYY-MM-DD>/<HHMMSS>-<slug>-<rand4>-<index>.<ext>
// The 4 random hex characters are not decoration: two agents generating the same
// prompt during the same second would otherwise silently overwrite each other.
//
// Every I/O call uses `node:fs/promises`. This code runs INSIDE the server
// process that hosts every PTY, WebSocket and MCP session of every team — a
// `readdirSync`/`statSync` walk over a few hundred files stalls all of them.
// `sweep()` is best-effort by construction: throttled to one pass per hour via a
// KV timestamp, never follows a symlink, descends exactly one level, never throws.
//
// NOTE (ESM cache) — modules under lib/ SURVIVE an enable/disable cycle
// (loader.ts:29-30 busts index.js only). No module-level mutable state here, and
// in particular NO memoisation of the `.gitignore` write: a stale "already done"
// flag after a reload would be a phantom bug, while an extra `access()` costs
// nothing.

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Upper bound on the slug embedded in a file name. */
const SLUG_MAX = 40;

/** The only extensions the retention sweep is allowed to delete. */
const MEDIA_EXT_RE = /\.(png|jpe?g|webp|wav|mp3|ogg|opus|mp4|webm|pcm|json)$/i;

/** At most one retention pass per hour, whatever the call rate. */
const SWEEP_THROTTLE_MS = 60 * 60 * 1000;

/** KV key holding the last sweep timestamp (ms). Must survive a reload. */
const SWEEP_KEY = 'sweep.last';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Gemini TTS emits signed 16-bit little-endian PCM, mono, 24 kHz. */
export const PCM_DEFAULTS = { sampleRate: 24000, channels: 1, bitsPerSample: 16 };

/**
 * Filesystem-safe, ASCII-only slug derived from arbitrary text.
 * Accents are decomposed then stripped so "Éléonore" becomes "eleonore".
 *
 * @param {string} s
 * @returns {string} 1..40 chars of `[a-z0-9-]`, never empty
 */
export function slugify(s) {
  const base = typeof s === 'string' ? s : '';
  const out = base
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return out || 'media';
}

/**
 * Extension deduced from a MIME type. Driven by what the API actually returned,
 * never by what was requested — a hard-coded `if (png)` would mislabel the day
 * Google changes a default.
 *
 * @param {string|null|undefined} mime
 * @param {string} [fallback] extension used when the MIME is unknown/absent
 * @returns {string} including the leading dot
 */
export function extFromMime(mime, fallback = '.bin') {
  const m = String(mime || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  switch (m) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'audio/wav':
    case 'audio/x-wav':
    case 'audio/wave':
      return '.wav';
    case 'audio/mpeg':
    case 'audio/mp3':
      return '.mp3';
    case 'audio/ogg':
    case 'application/ogg':
    case 'audio/opus':
      return '.ogg';
    case 'video/mp4':
      return '.mp4';
    case 'video/webm':
      return '.webm';
    case 'application/json':
      return '.json';
    default:
      // `audio/L16;rate=24000`, `audio/pcm`, `audio/x-raw` … all become WAV,
      // because that is what `toPlayableAudio` will have made of them.
      if (/^audio\/(l16|pcm|x-raw)/.test(m)) return '.wav';
      if (m.startsWith('image/')) return '.img';
      return fallback;
  }
}

/**
 * MIME type guessed from a file NAME. Used for input files an agent hands over
 * (Gemini requires an explicit `mime_type` on every inline part).
 *
 * @param {string} name file name or path
 * @returns {string|null}
 */
export function mimeFromName(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.heic':
      return 'image/heic';
    case '.heif':
      return 'image/heif';
    case '.gif':
      return 'image/gif';
    case '.wav':
      return 'audio/wav';
    case '.mp3':
      return 'audio/mpeg';
    case '.ogg':
    case '.opus':
      return 'audio/ogg';
    case '.flac':
      return 'audio/flac';
    case '.aac':
      return 'audio/aac';
    case '.m4a':
      return 'audio/mp4';
    case '.mp4':
      return 'video/mp4';
    case '.mov':
      return 'video/quicktime';
    case '.webm':
      return 'video/webm';
    case '.avi':
      return 'video/x-msvideo';
    case '.mpeg':
    case '.mpg':
      return 'video/mpeg';
    case '.pdf':
      return 'application/pdf';
    case '.txt':
    case '.md':
      return 'text/plain';
    case '.csv':
      return 'text/csv';
    case '.json':
      return 'application/json';
    default:
      return null;
  }
}

/**
 * Which Interactions content block a MIME belongs in. Gemini types its input
 * blocks (`image` / `audio` / `video` / `document`) rather than accepting a
 * generic blob, so this mapping is part of the wire contract, not a nicety.
 *
 * @param {string|null|undefined} mime
 * @returns {'image'|'audio'|'video'|'document'|null}
 */
export function blockTypeForMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (m === 'application/pdf' || m.startsWith('text/') || m === 'application/json') return 'document';
  return null;
}

/**
 * Build a 44-byte canonical RIFF/WAVE header for raw PCM.
 *
 * @param {number} dataLength payload size in bytes
 * @param {{sampleRate?: number, channels?: number, bitsPerSample?: number}} [fmt]
 * @returns {Buffer}
 */
export function wavHeader(dataLength, fmt) {
  const sampleRate = fmt?.sampleRate ?? PCM_DEFAULTS.sampleRate;
  const channels = fmt?.channels ?? PCM_DEFAULTS.channels;
  const bitsPerSample = fmt?.bitsPerSample ?? PCM_DEFAULTS.bitsPerSample;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;

  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataLength, 4); // RIFF chunk size = header tail + payload
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16); // PCM fmt chunk length
  h.writeUInt16LE(1, 20); // audio format 1 = PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataLength, 40);
  return h;
}

/**
 * Read the PCM parameters Google states in the MIME itself
 * (`audio/L16;codec=pcm;rate=24000`). Anything absent falls back to the
 * documented TTS defaults rather than being guessed from the byte count.
 *
 * @param {string|null|undefined} mime
 * @returns {{sampleRate: number, channels: number, bitsPerSample: number}}
 */
export function pcmFormatFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  const rate = /(?:^|;)\s*rate=(\d+)/.exec(m);
  const channels = /(?:^|;)\s*channels=(\d+)/.exec(m);
  const bits = /audio\/l(\d+)/.exec(m);
  return {
    sampleRate: rate ? Number(rate[1]) : PCM_DEFAULTS.sampleRate,
    channels: channels ? Number(channels[1]) : PCM_DEFAULTS.channels,
    bitsPerSample: bits ? Number(bits[1]) : PCM_DEFAULTS.bitsPerSample,
  };
}

/**
 * Turn whatever the audio endpoints returned into something a human can play.
 *
 * THE ONE THING THIS PLUGIN CANNOT GET WRONG. Gemini TTS returns **raw PCM**
 * (24 kHz, 16-bit, mono) — no container, no header. Writing those bytes to
 * `out.wav` produces a file every player refuses, and the failure is silent:
 * HTTP 200, a plausible file size, and nothing but noise. Music (Lyria) comes
 * back as real MP3/WAV instead. So the container is decided by INSPECTING THE
 * BYTES, not by trusting the MIME:
 *
 *   - `RIFF....WAVE`  -> already a WAV, kept verbatim (double-wrapping a WAV is
 *                        the mirror-image bug, and just as silent).
 *   - `ID3` / `0xFFEx` -> MPEG audio frame, i.e. MP3, kept verbatim.
 *   - `OggS`          -> Ogg container, kept verbatim.
 *   - anything else   -> assumed raw PCM and wrapped in a WAV header.
 *
 * @param {Buffer} data decoded audio payload
 * @param {string|null|undefined} mime MIME advertised by the API (may be absent)
 * @returns {{data: Buffer, ext: string, wrapped: boolean, format: object|null}}
 */
export function toPlayableAudio(data, mime) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    return { data: buf, ext: '.wav', wrapped: false, format: null };
  }
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'ID3') {
    return { data: buf, ext: '.mp3', wrapped: false, format: null };
  }
  // MPEG audio frame sync: 11 set bits (0xFF followed by 0xE0..0xFF).
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    return { data: buf, ext: '.mp3', wrapped: false, format: null };
  }
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS') {
    return { data: buf, ext: '.ogg', wrapped: false, format: null };
  }
  const format = pcmFormatFromMime(mime);
  return { data: Buffer.concat([wavHeader(buf.length, format), buf]), ext: '.wav', wrapped: true, format };
}

/**
 * @param {number} n
 * @returns {string}
 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Local-time `YYYY-MM-DD` — the date sub-directory of the layout.
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function dateDir(now) {
  const d = now instanceof Date ? now : new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * `<HHMMSS>-<slug>-<rand4>-<index><ext>`.
 *
 * @param {{ now?: Date, slug: string, index?: number, ext: string }} opts
 * @returns {string}
 */
export function buildFileName(opts) {
  const { now, slug, index, ext } = opts || {};
  const d = now instanceof Date ? now : new Date();
  const hhmmss = `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  const rand4 = randomBytes(2).toString('hex');
  const i = Number.isFinite(index) ? Math.max(0, Math.trunc(/** @type {number} */ (index))) : 0;
  return `${hhmmss}-${slugify(slug)}-${rand4}-${i}${typeof ext === 'string' ? ext : '.bin'}`;
}

/**
 * Create `absDir` (recursively) and make sure it carries a `.gitignore`
 * containing `*`.
 *
 * The workspace is a bind-mounted Git repository in which agents run `git add .`
 * — a 40 MB generated video must never become a staged change. The `mkdir` is
 * recursive, so calling this on the output root and again on the date
 * sub-directory is safe and idempotent.
 *
 * @param {string} absDir absolute container path
 * @returns {Promise<void>}
 */
export async function ensureOutputDir(absDir) {
  await fs.mkdir(absDir, { recursive: true });
  const marker = path.join(absDir, '.gitignore');
  try {
    await fs.access(marker);
  } catch {
    await fs.writeFile(marker, '*\n', 'utf8');
  }
}

/**
 * Write one media file. The directory must already exist (`ensureOutputDir`).
 *
 * `bytes` is derived from a NORMALISED buffer rather than read off the caller's
 * value: `data.byteLength` is `undefined` on a plain string, which the write
 * itself tolerates but which then fails the tool's `outputSchema` — a successful
 * generation would surface to the agent as an opaque `McpError`.
 *
 * @param {{ absDir: string, name: string, data: Buffer|Uint8Array|string }} opts
 * @returns {Promise<{ path: string, bytes: number }>} absolute CONTAINER path
 */
export async function writeMedia(opts) {
  const { absDir, name, data } = opts;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(/** @type {never} */ (data));
  const target = path.join(absDir, name);
  await fs.writeFile(target, buf);
  return { path: target, bytes: buf.length };
}

/**
 * Delete generated media older than `retentionDays`, at most once per hour.
 *
 * Deliberately narrow: one level of date sub-directories, known media
 * extensions only, no symlink ever followed, empty date directories left in
 * place (an empty inode costs nothing, the code to remove it does). Entirely
 * best-effort — a failure to sweep must never surface to an agent, so nothing
 * throws out of here.
 *
 * @param {{
 *   absDir: string,
 *   retentionDays: number,
 *   kv: { get(k: string): string|null, set(k: string, v: string): void },
 *   log?: any,
 * }} opts
 * @returns {Promise<void>}
 */
export async function sweep(opts) {
  const { absDir, retentionDays, kv, log } = opts || {};
  try {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return; // 0 = never purge
    if (!absDir) return;

    const now = Date.now();

    // Throttle. The timestamp lives in KV so it survives a plugin reload; if
    // `db-kv` was not granted, kv.get throws and we simply skip the sweep rather
    // than run it on every single generation.
    let last = 0;
    try {
      last = Number(kv?.get(SWEEP_KEY) || '0') || 0;
    } catch {
      return;
    }
    if (last && now - last < SWEEP_THROTTLE_MS) return;
    try {
      // Claim the slot BEFORE the walk: two concurrent generations must not both
      // start a pass.
      kv?.set(SWEEP_KEY, String(now));
    } catch {
      return;
    }

    const cutoff = now - retentionDays * DAY_MS;

    /** The output root plus exactly one level of date directories. */
    const dirs = [absDir];
    let top = [];
    try {
      top = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return; // never created yet — nothing to sweep
    }
    for (const entry of top) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) dirs.push(path.join(absDir, entry.name));
    }

    let removed = 0;
    let freed = 0;
    for (const dir of dirs) {
      let entries = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        if (!MEDIA_EXT_RE.test(entry.name)) continue;
        const abs = path.join(dir, entry.name);
        try {
          const st = await fs.lstat(abs); // lstat: never resolve a link out of the tree
          if (!st.isFile() || st.mtimeMs >= cutoff) continue;
          await fs.unlink(abs);
          removed += 1;
          freed += st.size;
        } catch {
          // Concurrent delete, permission, race — skip this file.
        }
      }
    }

    if (removed > 0) {
      log?.info?.(
        { event: 'gemini.sweep', removed, freedBytes: freed, retentionDays },
        `gemini-api: ${removed} media purges (retention ${retentionDays} j)`,
      );
    }
  } catch (err) {
    log?.warn?.({ event: 'gemini.sweep_failed', error: String(err) }, 'gemini-api: balayage de retention en echec');
  }
}

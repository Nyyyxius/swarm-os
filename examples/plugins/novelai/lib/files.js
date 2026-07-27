// files.js — on-disk layout of the generated audio: slug, file name, directory
// creation, write, and the retention sweep.
//
// Layout: <outputDir>/<YYYY-MM-DD>/<HHMMSS>-<slug>-<rand4>-<index>.<ext>
// The 4 random hex characters are not decoration: two agents synthesising the
// same sentence during the same second would otherwise silently overwrite each
// other's file.
//
// Every I/O call here uses `node:fs/promises`. This code runs INSIDE the server
// process that hosts every PTY, WebSocket and MCP session of every team — a
// `readdirSync`/`statSync` walk over a few hundred files stalls all of them.
// `sweep()` is best-effort by construction: it is throttled to one pass per hour
// through a KV timestamp, it never follows a symlink, it descends exactly one
// level, and it never throws.
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
const SLUG_MAX = 32;

/** The only extensions the sweep is allowed to delete. */
const AUDIO_EXT_RE = /\.(ogg|webm|mp3)$/i;

/** At most one retention pass per hour, whatever the call rate. */
const SWEEP_THROTTLE_MS = 60 * 60 * 1000;

/** KV key holding the last sweep timestamp (ms). Must survive a reload. */
const SWEEP_KEY = 'sweep.last';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Filesystem-safe, ASCII-only slug derived from arbitrary text.
 * Accents are decomposed then stripped so "Éléonore" becomes "eleonore".
 *
 * @param {string} s
 * @returns {string} 1..32 chars of `[a-z0-9-]`, never empty
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
  return out || 'audio';
}

/**
 * Extension deduced from the response's `Content-Type`, never from the requested
 * format: what NovelAI actually returned is the only thing that matters, and a
 * hard-coded `if (opus)` would mislabel the day the API changes.
 *
 * @param {string|null|undefined} ct raw header value
 * @returns {string} '.ogg' | '.webm' | '.mp3' | '.bin'
 */
export function extFromContentType(ct) {
  const mime = String(ct || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  switch (mime) {
    case 'audio/ogg':
    case 'application/ogg':
    case 'audio/opus':
      return '.ogg';
    case 'audio/webm':
      return '.webm';
    case 'audio/mpeg':
    case 'audio/mp3':
      return '.mp3';
    default:
      return '.bin';
  }
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
 * @param {{ now: Date, slug: string, index: number, ext: string }} opts
 * @returns {string}
 */
export function buildFileName(opts) {
  const { now, slug, index, ext } = opts;
  const d = now instanceof Date ? now : new Date();
  const hhmmss = `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  const rand4 = randomBytes(2).toString('hex');
  const i = Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0;
  return `${hhmmss}-${slugify(slug)}-${rand4}-${i}${typeof ext === 'string' ? ext : '.bin'}`;
}

/**
 * Create `absDir` (recursively) and make sure it carries a `.gitignore`
 * containing `*`.
 *
 * The workspace is a bind-mounted Git repository in which agents run `git add .`
 * — generated audio must never become a staged change. Calling this on the
 * output root is enough for Git; calling it on the date sub-directory is also
 * enough (the `mkdir` is recursive, so it creates both levels), which is why
 * the caller may safely call it once per level.
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
 * Write one audio file. The directory must already exist (`ensureOutputDir`).
 *
 * `bytes` is derived from a NORMALISED buffer rather than read off the caller's
 * value: `data.byteLength` is `undefined` on a plain string or array, which the
 * write itself tolerates but which then fails the tool's `outputSchema` — a
 * successful generation would surface to the agent as an opaque `McpError`.
 *
 * @param {{ absDir: string, name: string, data: Buffer|Uint8Array|string }} opts
 * @returns {Promise<{ path: string, bytes: number }>} absolute CONTAINER path
 */
export async function writeAudio(opts) {
  const { absDir, name, data } = opts;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(/** @type {never} */ (data));
  const target = path.join(absDir, name);
  await fs.writeFile(target, buf);
  return { path: target, bytes: buf.length };
}

/**
 * Delete generated audio older than `retentionDays`, at most once per hour.
 *
 * Deliberately narrow: one level of date sub-directories, `*.ogg|webm|mp3` only,
 * no symlink ever followed, empty date directories left in place (an empty inode
 * costs nothing, the code to remove it does). Entirely best-effort — a failure
 * to sweep must never surface to an agent, so nothing throws out of here.
 *
 * @param {{
 *   absDir: string,
 *   retentionDays: number,
 *   kv: { get(k: string): string|null, set(k: string, v: string): void },
 *   log: any,
 * }} opts
 * @returns {Promise<void>}
 */
export async function sweep(opts) {
  const { absDir, retentionDays, kv, log } = opts;
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
    for (const dir of dirs) {
      let entries = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        if (!AUDIO_EXT_RE.test(entry.name)) continue;
        const abs = path.join(dir, entry.name);
        try {
          const st = await fs.lstat(abs); // lstat: never resolve a link out of the tree
          if (!st.isFile() || st.mtimeMs >= cutoff) continue;
          await fs.unlink(abs);
          removed += 1;
        } catch {
          // Concurrent delete, permission, race — skip this file.
        }
      }
    }

    if (removed > 0) {
      log?.info?.(
        { event: 'novelai.sweep', removed, retentionDays },
        `novelai: ${removed} fichier(s) audio purges (retention ${retentionDays} j)`,
      );
    }
  } catch (err) {
    log?.warn?.({ event: 'novelai.sweep_failed', error: String(err) }, 'novelai: balayage de retention en echec');
  }
}

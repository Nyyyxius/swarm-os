// media.js — turn what an AGENT typed into what the Interactions API accepts.
//
// An agent says `"docs/schema.png"` or `"https://youtu.be/xyz"`. Gemini wants a
// typed content block with an explicit MIME and either inline base64 or a Files
// API uri. Everything between those two sentences lives here:
//
//   1. WHICH FILE. `toContainerPath` (lib/paths.js) accepts the three forms an
//      agent legitimately holds — relative, host-side (ssh), container-side —
//      and refuses anything outside the workspace. Containment is not optional:
//      this plugin runs in-process with the server's rights, so "describe
//      /etc/shadow" must fail here or it is exfiltrated to Google.
//   2. WHICH MIME. Extension first (cheap, usually right), magic bytes second
//      (an extension-less file is common in a workspace). Gemini rejects a block
//      with no `mime_type`, so a guess that fails is reported as a bad_request
//      naming the file, not as an opaque 400 from Google.
//   3. INLINE OR UPLOAD. The API caps a request at ~20 MB and base64 inflates by
//      a third. Small files are inlined; large ones go through the resumable
//      Files API and come back as a uri. The threshold is enforced on BOTH the
//      per-file size and the cumulative budget, because ten 5 MB images are a
//      50 MB request that no per-file check would have caught.
//
// NO MUTABLE MODULE STATE (see the ESM-cache note in lib/gemini.js).

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { blockTypeForMime, mimeFromName } from './files.js';
import { fail } from './gemini.js';
import { toContainerPath, workspaceRoot } from './paths.js';

/** Past this, a single file is uploaded instead of inlined. */
export const INLINE_MAX_BYTES = 6 * 1024 * 1024;
/** Past this cumulative RAW size, remaining files are uploaded too. */
export const INLINE_BUDGET_BYTES = 12 * 1024 * 1024;
/**
 * A file bigger than this is refused outright.
 *
 * The Files API accepts 2 GB; this cap is FIFTY times smaller on purpose. The
 * bytes do not stream through — they are read into a Buffer in the process that
 * hosts every PTY, WebSocket and MCP session of every team, and `buildInput`
 * runs OUTSIDE the client's concurrency semaphore, so N agents attaching at once
 * are N buffers resident at once. 50 MB covers every real workspace artefact (a
 * screenshot, a scan, a PDF, a short clip); past that the honest answer is "cut
 * it up", not "let the server swap".
 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** More attachments than this in one call is a bug, not a use case. */
export const MAX_ATTACHMENTS = 16;
/** How long an uploaded video may stay in state PROCESSING before we give up. */
const UPLOAD_ACTIVE_TIMEOUT_MS = 60_000;
const UPLOAD_POLL_MS = 2_000;

/** Anything with a scheme is treated as a remote reference, never as a path. */
const URL_RE = /^(https?|gs):\/\//i;

/**
 * MIME from the first bytes of a file — the fallback when the name carries no
 * usable extension.
 *
 * @param {Buffer} buf
 * @returns {string|null}
 */
export function sniffMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  const ascii = (start, end) => buf.toString('ascii', start, Math.min(end, buf.length));
  if (buf[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && buf.length >= 12) {
    const kind = ascii(8, 12);
    if (kind === 'WEBP') return 'image/webp';
    if (kind === 'WAVE') return 'audio/wav';
    if (kind === 'AVI ') return 'video/x-msvideo';
  }
  if (ascii(0, 4) === '%PDF') return 'application/pdf';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (buf.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand.startsWith('qt')) return 'video/quicktime';
    return 'video/mp4';
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/webm';
  return null;
}

/**
 * Normalise one attachment as the agent may have written it.
 *
 * @param {unknown} ref a path/URL string, or `{path|uri, mime_type?}`
 * @returns {{ref: string, mime: string|null}|null}
 */
export function normaliseRef(ref) {
  if (typeof ref === 'string') {
    const t = ref.trim();
    return t === '' ? null : { ref: t, mime: null };
  }
  if (ref && typeof ref === 'object') {
    const o = /** @type {any} */ (ref);
    const raw = typeof o.path === 'string' ? o.path : typeof o.uri === 'string' ? o.uri : '';
    const t = raw.trim();
    if (t === '') return null;
    const mime = typeof o.mime_type === 'string' && o.mime_type ? o.mime_type : null;
    return { ref: t, mime };
  }
  return null;
}

/**
 * A remote reference (http/https/gs, YouTube included) becomes a uri block as-is
 * — Gemini fetches it itself, so nothing is downloaded through the server.
 *
 * YouTube is special-cased because its URLs carry no extension and there is
 * exactly one thing they can be; without it every `analyze_media` on a video
 * link would fail on "MIME indeterminable".
 *
 * @param {string} url
 * @param {string|null} declaredMime
 * @returns {{ok:true, block:object}|{ok:false, code:string, error:string, hint?:string}}
 */
export function remoteBlock(url, declaredMime) {
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Never throw out of here: this is reached from an MCP handler, and a
    // malformed URL is the agent's typo, not a plugin crash.
    return fail('bad_request', `URL invalide: ${String(url).slice(0, 200)}`);
  }
  // Matched on the HOST, not on the whole URL: `https://youtu.be/x` has no dot
  // and no start-of-string before `youtu.be`, so a naive full-URL regex misses
  // exactly the short form people actually paste.
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const isYoutube = host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com');
  const mime = declaredMime || (isYoutube ? 'video/mp4' : mimeFromName(parsed.pathname));
  if (!mime) {
    return fail(
      'bad_request',
      `impossible de deduire le type MIME de l URL ${url}`,
      "passe l attachment sous la forme {uri, mime_type} (exemple: {\"uri\": \"...\", \"mime_type\": \"image/png\"})",
    );
  }
  const type = blockTypeForMime(mime);
  if (!type) {
    return fail('bad_request', `type MIME non supporte pour ${url}: ${mime}`);
  }
  return { ok: true, block: { type, uri: url, mime_type: mime } };
}

/**
 * Read one workspace file and turn it into a content block, inlining it or
 * uploading it depending on its size and on how much of the inline budget the
 * previous attachments already consumed.
 *
 * @param {{
 *   client: any,
 *   ref: string,
 *   declaredMime: string|null,
 *   inlineBudgetLeft: number,
 *   log?: any,
 * }} args
 * @returns {Promise<{ok:true, block:object, bytes:number, inlined:boolean}|{ok:false, code:string, error:string, hint?:string}>}
 */
export async function fileBlock(args) {
  const { client, ref, declaredMime, inlineBudgetLeft, log } = args;

  /** @type {string} */
  let abs;
  try {
    abs = toContainerPath(ref);
  } catch (err) {
    return fail('bad_request', err instanceof Error ? err.message : String(err));
  }

  /** @type {import('node:fs').Stats} */
  let st;
  try {
    st = await fs.stat(abs);
  } catch {
    return fail(
      'not_found',
      `fichier introuvable: ${ref}`,
      `le chemin est resolu dans le workspace (${workspaceRoot()}) ; verifie avec ls avant d appeler`,
    );
  }
  if (!st.isFile()) return fail('bad_request', `${ref} n est pas un fichier`);
  if (st.size === 0) return fail('bad_request', `${ref} est vide`);
  if (st.size > MAX_FILE_BYTES) {
    return fail(
      'oversized',
      `${ref} pese ${st.size} octets (limite ${MAX_FILE_BYTES})`,
      'decoupe ou compresse le fichier avant de le soumettre',
    );
  }

  let bytes;
  try {
    bytes = await fs.readFile(abs);
  } catch (err) {
    return fail('internal', `lecture impossible de ${ref}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const mime = declaredMime || mimeFromName(abs) || sniffMime(bytes);
  if (!mime) {
    return fail(
      'bad_request',
      `type MIME indeterminable pour ${ref}`,
      'renomme le fichier avec une extension connue, ou passe {path, mime_type}',
    );
  }
  const type = blockTypeForMime(mime);
  if (!type) {
    return fail(
      'bad_request',
      `type MIME non supporte: ${mime} (${ref})`,
      'formats acceptes: image, audio, video, PDF et texte',
    );
  }

  const canInline = bytes.length <= INLINE_MAX_BYTES && bytes.length <= inlineBudgetLeft;
  if (canInline) {
    return {
      ok: true,
      inlined: true,
      bytes: bytes.length,
      block: { type, data: bytes.toString('base64'), mime_type: mime },
    };
  }

  // Too big to inline — through the Files API, then referenced by uri.
  const up = await client.uploadFile({ bytes, mimeType: mime, displayName: path.basename(abs) });
  if (!up || up.ok !== true) return up;

  // A video or a long audio lands in PROCESSING and is unusable until ACTIVE;
  // referencing it too early is a 400 that reads like a bad prompt.
  let state = up.state;
  const deadline = Date.now() + UPLOAD_ACTIVE_TIMEOUT_MS;
  while (state === 'PROCESSING' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, UPLOAD_POLL_MS));
    const st2 = await client.fileStatus(up.name);
    if (!st2 || st2.ok !== true) break; // keep the uri; Gemini will say if it is not ready
    state = st2.state;
  }
  if (state === 'FAILED') {
    return fail('upstream', `Google n a pas pu traiter le fichier ${ref}`, 'verifie que le format est bien supporte');
  }
  if (state === 'PROCESSING') {
    return fail(
      'busy',
      `le fichier ${ref} est encore en cours de traitement chez Google apres ${Math.round(UPLOAD_ACTIVE_TIMEOUT_MS / 1000)} s`,
      'reessaie dans une minute : le fichier est deja televerse',
    );
  }

  log?.info?.(
    { event: 'gemini.upload', bytes: bytes.length, mime },
    `gemini-api: ${path.basename(abs)} televerse via la Files API (${bytes.length} octets)`,
  );
  return { ok: true, inlined: false, bytes: bytes.length, block: { type, uri: up.uri, mime_type: mime } };
}

/**
 * Build the `input` array of an interaction: the prompt text plus every
 * attachment, in that order.
 *
 * Order matters and is not arbitrary — Google's own guidance is to put the text
 * BEFORE a single image for understanding tasks. With several files the text
 * still leads, so the model reads the question before the corpus.
 *
 * @param {{
 *   client: any,
 *   text: string,
 *   attachments?: unknown[],
 *   log?: any,
 * }} args
 * @returns {Promise<{ok:true, input:object[], uploaded:number, inlineBytes:number}|{ok:false, code:string, error:string, hint?:string}>}
 */
export async function buildInput(args) {
  const { client, text, attachments, log } = args || /** @type {any} */ ({});
  /** @type {object[]} */
  const input = [];
  if (typeof text === 'string' && text.trim() !== '') input.push({ type: 'text', text });

  const refs = Array.isArray(attachments) ? attachments : [];
  if (refs.length > MAX_ATTACHMENTS) {
    return fail(
      'bad_request',
      `${refs.length} fichiers joints (maximum ${MAX_ATTACHMENTS})`,
      'traite les fichiers par lots successifs',
    );
  }

  let budget = INLINE_BUDGET_BYTES;
  let uploaded = 0;
  let inlineBytes = 0;

  for (const raw of refs) {
    const norm = normaliseRef(raw);
    if (!norm) {
      return fail(
        'bad_request',
        'attachment invalide (attendu: un chemin, une URL, ou {path, mime_type})',
      );
    }
    if (URL_RE.test(norm.ref)) {
      const remote = remoteBlock(norm.ref, norm.mime);
      if (!remote || remote.ok !== true) return remote;
      input.push(remote.block);
      continue;
    }
    const built = await fileBlock({ client, ref: norm.ref, declaredMime: norm.mime, inlineBudgetLeft: budget, log });
    if (!built || built.ok !== true) return built;
    input.push(built.block);
    if (built.inlined) {
      budget -= built.bytes;
      inlineBytes += built.bytes;
    } else {
      uploaded += 1;
    }
  }

  if (input.length === 0) return fail('bad_request', 'ni texte ni fichier joint : rien a envoyer');
  return { ok: true, input, uploaded, inlineBytes };
}

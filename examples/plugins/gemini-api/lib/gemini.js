// gemini.js — Google Gemini API client over native fetch. Node 22 globals only
// (fetch / AbortController / Buffer): no SDK, no dependency, nothing to install.
//
// Five properties this module exists to guarantee:
//
//  1. ONE ENDPOINT FOR ALMOST EVERYTHING. Text, vision, TTS, images and music
//     all go through `POST /v1beta/interactions` — the unified Interactions API.
//     Only video is different (Veo is a long-running operation), and that
//     difference is isolated in `startVideo`/`operationStatus`, not sprinkled
//     through the callers.
//  2. NO METHOD EVER THROWS. Every failure is an `{ok:false, code, error, hint?}`
//     value. A throw would reach the host's guard() and count toward plugin
//     quarantine (5 crashes / 60 s -> backoff up to 1 h; host.ts:61-62 and
//     :1066-1070). An invalid key or an exhausted quota is not a crash.
//  3. BOUNDED TIME. One absolute deadline per public call, SHARED by both
//     attempts; at most ONE retry, only on 429 / 5xx / non-abort network errors.
//     An AbortError is NEVER retried — retrying a timeout is how a 120 s budget
//     silently becomes 240 s.
//  4. BOUNDED CONCURRENCY. Google's quota is per MINUTE and per PROJECT, so a
//     swarm of eight agents each firing an image generation produces cascading
//     429s that retries make worse. `maxConcurrent` calls are in flight at most;
//     the queue bounds the WAIT in milliseconds (`maxWaitMs`), not its depth —
//     waiting time is the quantity the caller cares about. Over budget returns
//     code:'busy', a normal condition, never an exception.
//     (novelai serialises to 1 because NovelAI rate-limits hard on a single
//     account; Gemini bills per token and tolerates a couple of parallel calls,
//     so a strict serial queue would only make a 6-minute video block a 3-second
//     caption. Hence a semaphore rather than a chain.)
//  5. BOUNDED MEMORY. Every response body is read through a byte cap, and the
//     video download streams STRAIGHT TO DISK — this code runs in the server
//     process that hosts every PTY and WebSocket of every team, and a 200 MB
//     Buffer there is felt by every agent.
//
// SCHEMA MIGRATION, DELIBERATELY UNPINNED. The Interactions API replaced the
// flat `outputs[]` array with a structured `steps[]` array (breaking change of
// 2026-05-20; the `Api-Revision` header that selected between them stopped being
// honoured on 2026-06-08). We therefore send NO revision header — pinning a
// revision that the service has already retired is worse than sending none —
// and `extractText`/`extractMedia` read BOTH shapes, plus the classic
// `candidates[].content.parts[]` of `:generateContent`. Three readers, one
// reason: this plugin must survive the next rename without a code change.
//
// NO MUTABLE MODULE STATE. The loader's ESM cache-buster only applies to the
// entry point (loader.ts:29-30); `new URL('./lib/gemini.js', '...index.js?v=abc')`
// DROPS the query, so this module stays in Node's ESM cache across plugin
// reloads. All state lives in the closure created by createGeminiClient().

import * as fs from 'node:fs/promises';

/** Every REST surface of the Gemini API lives on this host. */
export const API_HOST = 'https://generativelanguage.googleapis.com';

/** The unified endpoint: text, vision, TTS, images, music. */
export const INTERACTIONS_PATH = '/v1beta/interactions';
/** Model discovery — what makes the config's free-text model fields checkable. */
export const MODELS_PATH = '/v1beta/models';
/** Resumable upload entry point of the Files API. */
export const UPLOAD_PATH = '/upload/v1beta/files';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_WAIT_MS = 30_000;
const DEFAULT_MAX_CONCURRENT = 2;
/** Cap for a JSON/interaction response (an inline 4K image is ~10 MB base64). */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
/** Cap for a streamed video download — generous, but never unbounded. */
export const VIDEO_MAX_BYTES = 256 * 1024 * 1024;

/** Google error bodies carry a `message`; surface it capped. */
const MESSAGE_CAP = 400;

/** Longest a `Retry-After` / `retryDelay` may push us back. */
const MAX_BACKOFF_MS = 60_000;

// Operator/agent-facing strings follow the repo convention: French, no accents.
const HINT_KEY =
  "verifie le champ apiKey dans la configuration du plugin gemini-api ; une cle se cree sur https://aistudio.google.com/apikey";
const HINT_MODEL =
  'le nom du modele est probablement obsolete : GET /plugin-api/gemini-api/status liste les modeles reellement disponibles';
const HINT_QUOTA =
  'quota Google atteint (par minute ou par jour) : reessaie plus tard, baisse maxConcurrent, ou active la facturation du projet';
const HINT_TIMEOUT =
  'la generation a peut-etre abouti cote Google ; regarde dans le dossier de sortie avant de relancer';

// ---------------------------------------------------------------------------
// Failure shape — identical to what the MCP tools relay verbatim
// ---------------------------------------------------------------------------

/**
 * @param {string} code
 * @param {string} error
 * @param {string} [hint]
 * @returns {{ok:false, code:string, error:string, hint?:string}}
 */
export function fail(code, error, hint) {
  return hint ? { ok: false, code, error, hint } : { ok: false, code, error };
}

/**
 * Pull the human-readable message out of a Google error body. The `code` field
 * is a NUMBER on the classic surfaces and a STRING (`INVALID_ARGUMENT`) on the
 * Interactions API, so neither is trusted for routing — only `message` is read,
 * and the HTTP status decides.
 *
 * @param {string} bodyText
 * @returns {{message: string, status: string, retryDelayMs: number|null}}
 */
export function parseError(bodyText) {
  const raw = typeof bodyText === 'string' ? bodyText : '';
  let message = raw.trim().slice(0, MESSAGE_CAP);
  let status = '';
  let retryDelayMs = null;
  try {
    const parsed = JSON.parse(raw);
    const err = parsed && typeof parsed === 'object' ? parsed.error || parsed : null;
    if (err && typeof err.message === 'string') message = err.message.slice(0, MESSAGE_CAP);
    if (err && typeof err.status === 'string') status = err.status;
    // Quota errors carry the exact wait Google wants: `details[].retryDelay: "17s"`.
    const details = err && Array.isArray(err.details) ? err.details : [];
    for (const d of details) {
      const delay = d && typeof d.retryDelay === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay) : null;
      if (delay) retryDelayMs = Math.min(Math.round(Number(delay[1]) * 1000), MAX_BACKOFF_MS);
    }
  } catch {
    // Not JSON (an HTML error page from the edge, an empty body) — keep the raw text.
  }
  return { message, status, retryDelayMs };
}

/** An API-key problem that Google reports as a plain 400. */
const KEY_MESSAGE_RE = /api[ _-]?key|api_key_invalid|credential|unauthenticated/i;

/**
 * Map a non-2xx response to a stable code. Never throws.
 *
 * The 400 branch is checked against the message BEFORE anything else because
 * Google answers an invalid API key with **400 INVALID_ARGUMENT**, not 401. Left
 * unhandled, the single most common setup mistake would surface to the operator
 * as "requete refusee" and send them auditing their prompt.
 *
 * @param {number} status
 * @param {string} bodyText
 * @returns {{ok:false, code:string, error:string, hint?:string}}
 */
export function mapStatus(status, bodyText) {
  const { message } = parseError(bodyText);
  const withMsg = (base) => (message ? `${base}: ${message}` : base);

  if (status === 400 && KEY_MESSAGE_RE.test(message)) {
    return fail('unauthorized', withMsg("cle d'API Gemini invalide"), HINT_KEY);
  }
  if (status === 401) {
    return fail('unauthorized', withMsg("cle d'API Gemini invalide ou absente"), HINT_KEY);
  }
  if (status === 403) {
    return fail(
      'forbidden',
      withMsg('acces refuse par Google'),
      "cle restreinte, API Generative Language non activee sur le projet, ou modele indisponible dans ton pays",
    );
  }
  if (status === 404) {
    return fail('model_not_found', withMsg('modele ou ressource introuvable'), HINT_MODEL);
  }
  if (status === 429) {
    return fail('rate_limited', withMsg('quota Google depasse'), HINT_QUOTA);
  }
  if (status === 400 || status === 422) {
    return fail(
      'bad_request',
      message || `requete refusee par Gemini (${status})`,
      'verifie les parametres (modele, format de reponse, taille des fichiers joints)',
    );
  }
  if (status === 413) {
    return fail(
      'oversized',
      withMsg('requete trop volumineuse'),
      'reduis la taille ou le nombre de fichiers joints (limite ~20 Mo par requete en inline)',
    );
  }
  // 5xx and every other unlisted status: `upstream` is the honest bucket — the
  // status is in the message, so the exact code stays diagnosable.
  return fail('upstream', withMsg(`Gemini indisponible (HTTP ${status})`), 'deja reessaye une fois ; reessaie plus tard');
}

function isRetriableStatus(status) {
  return status === 429 || status === 408 || (status >= 500 && status <= 599);
}

function isAbort(err) {
  return Boolean(err) && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
}

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms) {
  return ms > 0 ? new Promise((res) => setTimeout(res, ms)) : Promise.resolve();
}

function positive(value, dflt) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : dflt;
}

/** `Retry-After` in seconds or as an HTTP date; null when absent/unparseable. */
function retryAfterMs(res) {
  const raw = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_BACKOFF_MS);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.min(Math.max(0, when - Date.now()), MAX_BACKOFF_MS);
  return null;
}

// ---------------------------------------------------------------------------
// Response readers — THREE shapes, one plugin
// ---------------------------------------------------------------------------

/**
 * Every content block of an interaction, whatever schema revision produced it.
 *
 * @param {any} json
 * @returns {Array<Record<string, any>>}
 */
function contentBlocks(json) {
  /** @type {Array<Record<string, any>>} */
  const out = [];
  if (!json || typeof json !== 'object') return out;

  // Current schema (2026-05-20 and later): steps[].content[].
  if (Array.isArray(json.steps)) {
    for (const step of json.steps) {
      const content = step && Array.isArray(step.content) ? step.content : [];
      for (const block of content) if (block && typeof block === 'object') out.push(block);
    }
  }
  // Legacy revision: a flat outputs[] of the same blocks.
  if (Array.isArray(json.outputs)) {
    for (const block of json.outputs) if (block && typeof block === 'object') out.push(block);
  }
  // Classic `:generateContent`, still served by some model families.
  if (Array.isArray(json.candidates)) {
    for (const cand of json.candidates) {
      const parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
      for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        if (typeof part.text === 'string') out.push({ type: 'text', text: part.text });
        const inline = part.inlineData || part.inline_data;
        if (inline && typeof inline.data === 'string') {
          const mime = inline.mimeType || inline.mime_type || '';
          const kind = String(mime).split('/')[0];
          out.push({ type: kind === 'application' ? 'document' : kind, data: inline.data, mime_type: mime });
        }
      }
    }
  }
  return out;
}

/**
 * Concatenated text of an interaction. `output_text` is the API's own
 * convenience field and is preferred when present; the block walk is the
 * fallback that keeps this working across the schema migration.
 *
 * @param {any} json
 * @returns {string}
 */
export function extractText(json) {
  if (json && typeof json.output_text === 'string' && json.output_text !== '') return json.output_text;
  const parts = [];
  for (const block of contentBlocks(json)) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text);
  }
  return parts.join('');
}

/**
 * Every media payload of a given kind, decoded.
 *
 * A block carrying a `uri` instead of `data` is returned with `data: null` and
 * its uri — the caller downloads it (that is how Veo delivers video). Dropping
 * such a block would turn "here is your file, fetch it" into "the API returned
 * nothing".
 *
 * @param {any} json
 * @param {'image'|'audio'|'video'} kind
 * @returns {Array<{data: Buffer|null, mime: string, uri: string|null}>}
 */
export function extractMedia(json, kind) {
  /** @type {Array<{data: Buffer|null, mime: string, uri: string|null}>} */
  const out = [];
  /** @param {any} block */
  const push = (block) => {
    if (!block || typeof block !== 'object') return;
    const mime = String(block.mime_type || block.mimeType || '');
    const uri = typeof block.uri === 'string' && block.uri ? block.uri : null;
    let data = null;
    if (typeof block.data === 'string' && block.data !== '') {
      try {
        data = Buffer.from(block.data, 'base64');
      } catch {
        data = null;
      }
    }
    if (data === null && uri === null) return;
    // Two blocks can describe the same payload (the convenience field AND the
    // step it was lifted from), so identical bytes are collapsed.
    if (data && out.some((o) => o.data && o.data.length === data.length && o.data.equals(data))) return;
    if (!data && uri && out.some((o) => o.uri === uri)) return;
    out.push({ data, mime, uri });
  };

  if (json && typeof json === 'object') push(json[`output_${kind}`]);
  for (const block of contentBlocks(json)) if (block.type === kind) push(block);
  return out;
}

/**
 * Why an interaction produced no usable output. Returns null when nothing says
 * it was blocked — an empty answer with no reason is a different bug, and
 * inventing a safety verdict for it would send the agent rewriting an innocent
 * prompt forever.
 *
 * @param {any} json
 * @returns {string|null}
 */
export function blockedReason(json) {
  if (!json || typeof json !== 'object') return null;
  const feedback = json.prompt_feedback || json.promptFeedback;
  const blockReason = feedback && (feedback.block_reason || feedback.blockReason);
  if (typeof blockReason === 'string' && blockReason) return blockReason;
  if (typeof json.status === 'string' && /failed|blocked|cancelled/i.test(json.status)) return json.status;
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  for (const cand of candidates) {
    const finish = cand && (cand.finishReason || cand.finish_reason);
    if (typeof finish === 'string' && /SAFETY|PROHIBITED|RECITATION|BLOCKLIST|SPII/i.test(finish)) return finish;
  }
  const steps = Array.isArray(json.steps) ? json.steps : [];
  for (const step of steps) {
    const finish = step && (step.finish_reason || step.finishReason);
    if (typeof finish === 'string' && /SAFETY|PROHIBITED|RECITATION|BLOCKLIST|SPII/i.test(finish)) return finish;
  }
  return null;
}

/**
 * Token accounting, normalised across both spellings.
 *
 * @param {any} json
 * @returns {{input: number, output: number, total: number, thoughts: number}|null}
 */
export function extractUsage(json) {
  const u = json && typeof json === 'object' ? json.usage || json.usage_metadata || json.usageMetadata : null;
  if (!u || typeof u !== 'object') return null;
  const n = (...keys) => {
    for (const k of keys) {
      const v = u[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return 0;
  };
  return {
    input: n('total_input_tokens', 'promptTokenCount', 'prompt_token_count'),
    output: n('total_output_tokens', 'candidatesTokenCount', 'candidates_token_count'),
    total: n('total_tokens', 'totalTokenCount', 'total_token_count'),
    thoughts: n('total_thought_tokens', 'thoughtsTokenCount', 'thoughts_token_count'),
  };
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Build a Gemini client. All mutable state (the semaphore and its counters)
 * lives in this closure — nothing at module scope, because `lib/` modules
 * survive plugin reloads (see the header).
 *
 * @param {{
 *   apiKey: string,
 *   timeoutMs?: number,
 *   maxWaitMs?: number,
 *   maxConcurrent?: number,
 *   maxBytes?: number,
 *   backoffMs?: number,
 *   log?: any,
 * }} opts
 */
export function createGeminiClient(opts) {
  const o = opts || /** @type {any} */ ({});
  const apiKey = typeof o.apiKey === 'string' ? o.apiKey.trim() : '';
  const timeoutMs = positive(o.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxWaitMs =
    typeof o.maxWaitMs === 'number' && Number.isFinite(o.maxWaitMs) && o.maxWaitMs >= 0 ? o.maxWaitMs : DEFAULT_MAX_WAIT_MS;
  const maxConcurrent = Math.max(1, Math.trunc(positive(o.maxConcurrent, DEFAULT_MAX_CONCURRENT)));
  const maxBytes = positive(o.maxBytes, DEFAULT_MAX_BYTES);
  // Explicit backoffMs wins over Retry-After — it is the test injection point.
  const fixedBackoffMs =
    typeof o.backoffMs === 'number' && Number.isFinite(o.backoffMs) && o.backoffMs >= 0 ? o.backoffMs : null;
  const log = o.log || null;

  // --- semaphore state (closure-local) -----------------------------------
  /** @type {Array<{cancelled: boolean, run: () => void}>} */
  const waiters = [];
  let inflight = 0;

  function debug(event, fields) {
    if (log && typeof log.debug === 'function') {
      try {
        log.debug({ event, ...fields });
      } catch {
        // A broken logger must never fail a generation.
      }
    }
  }

  /** Start as many queued tasks as there are free slots. */
  function pump() {
    while (inflight < maxConcurrent && waiters.length > 0) {
      const w = waiters.shift();
      if (!w || w.cancelled) continue;
      inflight += 1;
      w.run();
    }
  }

  /**
   * Run `task` under the concurrency cap, waiting at most `maxWaitMs` for a
   * slot. Past that budget the task is NOT run and a `busy` result is returned —
   * a saturated swarm is a normal condition, not an exception.
   *
   * A free slot is granted SYNCHRONOUSLY on push, so an idle plugin never pays
   * the queue's cost.
   *
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T|{ok:false, code:string, error:string, hint?:string}>}
   */
  function runLimited(task) {
    return new Promise((resolve) => {
      let settled = false;
      /** @type {any} */
      let timer = null;

      const waiter = {
        cancelled: false,
        run() {
          if (timer) clearTimeout(timer);
          Promise.resolve()
            .then(task)
            .then(
              (value) => {
                if (!settled) {
                  settled = true;
                  resolve(/** @type {any} */ (value));
                }
              },
              (err) => {
                // Defensive only: `task` is written never to throw.
                if (!settled) {
                  settled = true;
                  resolve(fail('internal', `erreur interne du client Gemini: ${errText(err)}`));
                }
              },
            )
            .then(() => {
              inflight -= 1;
              pump();
            });
        },
      };

      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        waiter.cancelled = true;
        debug('gemini.busy', { maxWaitMs, inflight, waiting: waiters.length });
        resolve(
          fail(
            'busy',
            `file Gemini saturee : aucun creneau libre en ${maxWaitMs} ms`,
            `${maxConcurrent} appel(s) simultane(s) au maximum ; reessaie dans quelques secondes`,
          ),
        );
      }, maxWaitMs);

      waiters.push(waiter);
      pump();
    });
  }

  /** One fetch bounded by the SHARED deadline. Throws on abort/network error. */
  async function fetchOnce(url, init, deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const e = new Error('budget de temps epuise');
      e.name = 'AbortError';
      throw e;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), remaining);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Read a response body with a hard byte cap. Streaming (rather than a bare
   * `arrayBuffer()`) is what keeps a degenerate response from growing the
   * SERVER's heap — the plugin runs in-process.
   *
   * @param {Response} res
   * @param {number} [cap]
   * @returns {Promise<{buf: Buffer}|{oversized: true, bytes: number}>}
   */
  async function readCapped(res, cap) {
    const limit = positive(cap, maxBytes);
    const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
    if (Number.isFinite(declared) && declared > limit) return { oversized: true, bytes: declared };
    const body = res.body;
    if (body && typeof body.getReader === 'function') {
      const reader = body.getReader();
      /** @type {Buffer[]} */
      const parts = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
          try {
            await reader.cancel();
          } catch {
            // Cancelling is best-effort; the cap is already enforced.
          }
          return { oversized: true, bytes: total };
        }
        parts.push(Buffer.from(value));
      }
      return { buf: Buffer.concat(parts, total) };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > limit) return { oversized: true, bytes: buf.length };
    return { buf };
  }

  function oversized(bytes, limit) {
    return fail(
      'oversized',
      `reponse Gemini trop volumineuse (${bytes} > ${limit} octets)`,
      'demande un media plus petit (resolution, duree) ou augmente la limite du plugin',
    );
  }

  /**
   * Perform one request with AT MOST one retry, sharing a single absolute
   * deadline across both attempts. Never throws.
   *
   * @param {string} url
   * @param {RequestInit} init
   * @param {number} deadline absolute epoch ms
   * @param {(res: Response) => Promise<any>} onOk called for a 2xx response
   */
  async function send(url, init, deadline, onOk) {
    for (let attempt = 1; ; attempt += 1) {
      const canRetry = attempt === 1;
      let res;
      const startedAt = Date.now();
      try {
        res = await fetchOnce(url, init, deadline);
      } catch (err) {
        if (isAbort(err)) {
          // NEVER retried: a retry would double an already-blown time budget.
          debug('gemini.timeout', { url, attempt, ms: Date.now() - startedAt });
          return fail('timeout', `delai depasse apres ${timeoutMs} ms`, HINT_TIMEOUT);
        }
        debug('gemini.network_error', { url, attempt, error: errText(err) });
        if (canRetry && (await waitBeforeRetry(null, null, deadline))) continue;
        return fail(
          'upstream',
          `Gemini injoignable: ${errText(err)}`,
          'verifie la connectivite reseau du serveur ; deja reessaye une fois',
        );
      }

      const status = Number(res.status);
      debug('gemini.response', { url, attempt, status, ms: Date.now() - startedAt });

      if (status >= 200 && status < 300) return await onOk(res);

      const read = await readCapped(res).catch(() => ({ buf: Buffer.alloc(0) }));
      const bodyText = 'buf' in read ? read.buf.toString('utf8') : '';
      if (canRetry && isRetriableStatus(status)) {
        const { retryDelayMs } = parseError(bodyText);
        if (await waitBeforeRetry(res, retryDelayMs, deadline)) continue;
      }
      return mapStatus(status, bodyText);
    }
  }

  /**
   * Sleep before the single retry. Returns false when the shared deadline leaves
   * no room, in which case the caller reports the original failure rather than
   * burning the remaining budget on a doomed attempt.
   *
   * Google states the wait it wants twice — in `Retry-After` and in the quota
   * error's `details[].retryDelay` — and the longer of the two is honoured:
   * coming back early is exactly how a rate-limited caller stays rate-limited.
   */
  async function waitBeforeRetry(res, retryDelayMs, deadline) {
    const header = res ? retryAfterMs(res) : null;
    const advised = Math.max(header ?? 0, retryDelayMs ?? 0);
    const base = fixedBackoffMs !== null ? fixedBackoffMs : advised > 0 ? advised : 2000 + Math.floor(Math.random() * 1000);
    if (Date.now() + base >= deadline) return false;
    await sleep(base);
    return Date.now() < deadline;
  }

  function notConfigured() {
    return fail(
      'not_configured',
      "cle d'API Gemini absente",
      'renseigne apiKey dans la configuration du plugin gemini-api',
    );
  }

  function authHeaders(extra) {
    return { 'x-goog-api-key': apiKey, ...extra };
  }

  /** A 2xx whose body is not the shape we can use. */
  function badResponse(what, raw) {
    return fail(
      'bad_response',
      `reponse Gemini ${what}: ${String(raw).trim().slice(0, MESSAGE_CAP)}`,
      "reessaie ; si cela persiste, l'API Gemini a change de schema",
    );
  }

  /** Read a 2xx JSON body under the cap. */
  async function readJson(res, cap) {
    const limit = positive(cap, maxBytes);
    const read = await readCapped(res, limit);
    if ('oversized' in read) return oversized(read.bytes, limit);
    const raw = read.buf.toString('utf8');
    try {
      return { ok: true, json: JSON.parse(raw) };
    } catch {
      // 200 + an HTML interstitial, or a truncated body.
      return badResponse('illisible (JSON attendu)', raw);
    }
  }

  // --- public surface ----------------------------------------------------

  /**
   * `POST /v1beta/interactions` — the one call behind text, vision, TTS, image
   * and music generation. The body is passed through almost verbatim: this
   * client owns transport concerns (auth, deadline, retry, caps), the tools own
   * what a request MEANS.
   *
   * @param {{
   *   model: string,
   *   input: unknown,
   *   systemInstruction?: string,
   *   responseFormat?: unknown,
   *   generationConfig?: object,
   *   tools?: unknown[],
   *   previousInteractionId?: string,
   *   maxBytes?: number,
   * }} args
   * @returns {Promise<{ok:true, json:any}|{ok:false, code:string, error:string, hint?:string}>}
   */
  async function interact(args) {
    try {
      const a = args || /** @type {any} */ ({});
      if (!apiKey) return notConfigured();
      if (typeof a.model !== 'string' || a.model === '') return fail('bad_request', 'model manquant');
      if (a.input === undefined || a.input === null) return fail('bad_request', 'input manquant');

      /** @type {Record<string, unknown>} */
      const body = { model: a.model, input: a.input };
      if (typeof a.systemInstruction === 'string' && a.systemInstruction !== '') {
        body.system_instruction = a.systemInstruction;
      }
      if (a.responseFormat !== undefined && a.responseFormat !== null) body.response_format = a.responseFormat;
      if (a.generationConfig && Object.keys(a.generationConfig).length > 0) body.generation_config = a.generationConfig;
      if (Array.isArray(a.tools) && a.tools.length > 0) body.tools = a.tools;
      if (typeof a.previousInteractionId === 'string' && a.previousInteractionId !== '') {
        body.previous_interaction_id = a.previousInteractionId;
      }

      const deadline = Date.now() + timeoutMs;
      const cap = positive(a.maxBytes, maxBytes);
      return await runLimited(async () =>
        send(
          `${API_HOST}${INTERACTIONS_PATH}`,
          {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
            body: JSON.stringify(body),
          },
          deadline,
          (res) => readJson(res, cap),
        ),
      );
    } catch (err) {
      // Last line of defence: a throw here would count toward quarantine.
      return fail('internal', `erreur interne du client Gemini: ${errText(err)}`);
    }
  }

  /**
   * `GET /v1beta/models` — what the account can actually call today. This is
   * what keeps the config's free-text model fields honest: `/status` renders
   * this list, so a 404 on a renamed model is one page-load away from being
   * understood.
   *
   * @returns {Promise<{ok:true, models:Array<{name:string, displayName:string|null, methods:string[]}>}|{ok:false, code:string, error:string, hint?:string}>}
   */
  async function listModels() {
    try {
      if (!apiKey) return notConfigured();
      const deadline = Date.now() + timeoutMs;
      return await runLimited(async () =>
        send(
          `${API_HOST}${MODELS_PATH}?pageSize=200`,
          { method: 'GET', headers: authHeaders({ Accept: 'application/json' }) },
          deadline,
          async (res) => {
            const parsed = await readJson(res, 4 * 1024 * 1024);
            if (!parsed || parsed.ok !== true) return parsed;
            const list = Array.isArray(parsed.json?.models) ? parsed.json.models : null;
            if (!list) return badResponse('sans tableau models', JSON.stringify(parsed.json).slice(0, 200));
            const models = list
              .map((m) => {
                const raw = m && typeof m.name === 'string' ? m.name : '';
                if (!raw) return null;
                return {
                  // `models/gemini-3.7-flash` -> `gemini-3.7-flash`: the form the
                  // config fields and the tools' `model` argument actually take.
                  name: raw.startsWith('models/') ? raw.slice('models/'.length) : raw,
                  displayName: typeof m.displayName === 'string' ? m.displayName : null,
                  methods: Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [],
                };
              })
              .filter(Boolean);
            return { ok: true, models };
          },
        ),
      );
    } catch (err) {
      return fail('internal', `erreur interne du client Gemini: ${errText(err)}`);
    }
  }

  /**
   * `POST /v1beta/models/{model}:predictLongRunning` — start a Veo generation.
   *
   * Video is the ONE surface that is not an interaction: Veo takes minutes, so
   * Google returns an operation name immediately and the caller polls. Nothing
   * here waits — the wait belongs to the tool, which owns the agent's patience.
   *
   * @param {{model: string, instances: unknown[], parameters?: object}} args
   * @returns {Promise<{ok:true, operation:string, raw:any}|{ok:false, code:string, error:string, hint?:string}>}
   */
  async function startVideo(args) {
    try {
      const a = args || /** @type {any} */ ({});
      if (!apiKey) return notConfigured();
      if (typeof a.model !== 'string' || a.model === '') return fail('bad_request', 'model manquant');
      if (!Array.isArray(a.instances) || a.instances.length === 0) return fail('bad_request', 'instances manquant');

      const body = { instances: a.instances };
      if (a.parameters && Object.keys(a.parameters).length > 0) body.parameters = a.parameters;

      const deadline = Date.now() + timeoutMs;
      return await runLimited(async () =>
        send(
          `${API_HOST}/v1beta/models/${encodeURIComponent(a.model)}:predictLongRunning`,
          {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
            body: JSON.stringify(body),
          },
          deadline,
          async (res) => {
            const parsed = await readJson(res, 4 * 1024 * 1024);
            if (!parsed || parsed.ok !== true) return parsed;
            const name = parsed.json && typeof parsed.json.name === 'string' ? parsed.json.name : '';
            if (!name) return badResponse("sans champ 'name' (operation)", JSON.stringify(parsed.json).slice(0, 200));
            return { ok: true, operation: name, raw: parsed.json };
          },
        ),
      );
    } catch (err) {
      return fail('internal', `erreur interne du client Gemini: ${errText(err)}`);
    }
  }

  /**
   * `GET /v1beta/{operation}` — one poll of a long-running operation.
   *
   * An operation that FAILED is reported as `{ok:true, done:true, failure}`: the
   * poll itself succeeded, and conflating "I could not ask" with "the answer is
   * no" would make the caller retry a job Google has already given up on.
   *
   * @param {string} operation full operation name, e.g. `models/veo-.../operations/abc`
   * @returns {Promise<{ok:true, done:boolean, response:any, failure:{code:string,error:string}|null}|{ok:false, code:string, error:string, hint?:string}>}
   */
  async function operationStatus(operation) {
    try {
      if (!apiKey) return notConfigured();
      const name = typeof operation === 'string' ? operation.trim().replace(/^\/+/, '') : '';
      if (!name) return fail('bad_request', 'nom d operation manquant');
      const deadline = Date.now() + timeoutMs;
      return await runLimited(async () =>
        send(
          `${API_HOST}/v1beta/${name}`,
          { method: 'GET', headers: authHeaders({ Accept: 'application/json' }) },
          deadline,
          async (res) => {
            const parsed = await readJson(res, 8 * 1024 * 1024);
            if (!parsed || parsed.ok !== true) return parsed;
            const json = parsed.json || {};
            const opError = json.error && typeof json.error === 'object' ? json.error : null;
            return {
              ok: true,
              done: json.done === true,
              response: json.response ?? null,
              failure: opError
                ? {
                    code: 'generation_failed',
                    error: String(opError.message || JSON.stringify(opError)).slice(0, MESSAGE_CAP),
                  }
                : null,
            };
          },
        ),
      );
    } catch (err) {
      return fail('internal', `erreur interne du client Gemini: ${errText(err)}`);
    }
  }

  /**
   * Stream a generated file straight to disk under a byte cap.
   *
   * TO DISK, never through a Buffer: a Veo clip is tens of megabytes and this
   * runs in the process that serves every team's WebSocket. The partial file is
   * removed on failure so a truncated download can never be mistaken for a video.
   *
   * @param {{uri: string, absPath: string, maxBytes?: number}} args
   * @returns {Promise<{ok:true, bytes:number, contentType:string|null}|{ok:false, code:string, error:string, hint?:string}>}
   */
  async function downloadToFile(args) {
    try {
      const a = args || /** @type {any} */ ({});
      if (!apiKey) return notConfigured();
      if (typeof a.uri !== 'string' || a.uri === '') return fail('bad_request', 'uri manquant');
      if (typeof a.absPath !== 'string' || a.absPath === '') return fail('bad_request', 'absPath manquant');
      const limit = positive(a.maxBytes, VIDEO_MAX_BYTES);
      const deadline = Date.now() + timeoutMs;

      return await runLimited(async () =>
        send(
          a.uri,
          { method: 'GET', headers: authHeaders({ Accept: '*/*' }) },
          deadline,
          async (res) => {
            const contentType =
              res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-type') : null;
            const declared = Number(
              res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN,
            );
            if (Number.isFinite(declared) && declared > limit) return oversized(declared, limit);

            let handle = null;
            let total = 0;
            try {
              handle = await fs.open(a.absPath, 'w');
              const body = res.body;
              if (body && typeof body.getReader === 'function') {
                const reader = body.getReader();
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  total += value.byteLength;
                  if (total > limit) {
                    try {
                      await reader.cancel();
                    } catch {
                      // Best-effort; the cap is already enforced.
                    }
                    throw new RangeError(`fichier trop volumineux (> ${limit} octets)`);
                  }
                  await handle.write(Buffer.from(value));
                }
              } else {
                const buf = Buffer.from(await res.arrayBuffer());
                if (buf.length > limit) throw new RangeError(`fichier trop volumineux (> ${limit} octets)`);
                total = buf.length;
                await handle.write(buf);
              }
            } catch (err) {
              try {
                await handle?.close();
              } catch {
                // Closing a handle we are about to abandon is best-effort.
              }
              handle = null;
              // A half-written file that looks like a video is worse than none.
              try {
                await fs.unlink(a.absPath);
              } catch {
                // Never created, or already gone.
              }
              if (err instanceof RangeError) return oversized(total, limit);
              return fail('internal', `ecriture du fichier impossible: ${errText(err)}`);
            } finally {
              try {
                await handle?.close();
              } catch {
                // Same as above.
              }
            }
            if (total === 0) {
              try {
                await fs.unlink(a.absPath);
              } catch {
                // Best-effort.
              }
              return fail('bad_response', 'Google a renvoye un fichier vide');
            }
            return { ok: true, bytes: total, contentType: contentType || null };
          },
        ),
      );
    } catch (err) {
      return fail('internal', `erreur interne du client Gemini: ${errText(err)}`);
    }
  }

  /**
   * Files API — two-step resumable upload, for inputs too large to inline.
   *
   * Inlining is capped at ~20 MB of TOTAL request size by the API, and base64
   * inflates bytes by a third; past that threshold the file must be uploaded and
   * referenced by uri. Uploaded files live 48 h on Google's side and are not
   * deleted here.
   *
   * @param {{bytes: Buffer, mimeType: string, displayName?: string}} args
   * @returns {Promise<{ok:true, uri:string, name:string, mimeType:string, state:string}|{ok:false, code:string, error:string, hint?:string}>}
   */
  async function uploadFile(args) {
    try {
      const a = args || /** @type {any} */ ({});
      if (!apiKey) return notConfigured();
      const bytes = Buffer.isBuffer(a.bytes) ? a.bytes : null;
      if (!bytes || bytes.length === 0) return fail('bad_request', 'bytes manquant ou vide');
      const mimeType = typeof a.mimeType === 'string' && a.mimeType ? a.mimeType : 'application/octet-stream';
      const displayName = typeof a.displayName === 'string' && a.displayName ? a.displayName.slice(0, 100) : 'upload';
      const deadline = Date.now() + timeoutMs;

      return await runLimited(async () => {
        // Step 1 — announce the upload; the session URL comes back in a header.
        const startRes = await send(
          `${API_HOST}${UPLOAD_PATH}`,
          {
            method: 'POST',
            headers: authHeaders({
              'X-Goog-Upload-Protocol': 'resumable',
              'X-Goog-Upload-Command': 'start',
              'X-Goog-Upload-Header-Content-Length': String(bytes.length),
              'X-Goog-Upload-Header-Content-Type': mimeType,
              'Content-Type': 'application/json',
            }),
            body: JSON.stringify({ file: { display_name: displayName } }),
          },
          deadline,
          async (res) => {
            const url =
              res.headers && typeof res.headers.get === 'function'
                ? res.headers.get('x-goog-upload-url') || res.headers.get('location')
                : null;
            // Drain the (empty) body so the socket is released to the pool.
            await readCapped(res, 64 * 1024).catch(() => ({ buf: Buffer.alloc(0) }));
            if (!url) return badResponse("sans en-tete 'x-goog-upload-url'", '');
            return { ok: true, url };
          },
        );
        if (!startRes || startRes.ok !== true) return startRes;

        // Step 2 — the bytes. `send` retries this once like anything else, and
        // that is safe HERE because the offset is pinned to 0 and the command is
        // `upload, finalize`: a retry is a fresh attempt at the whole payload,
        // never a corrupt append. (It would NOT be safe with a moving offset,
        // which is why the offset is a constant and not a cursor.)
        return await send(
          startRes.url,
          {
            method: 'POST',
            headers: {
              'Content-Length': String(bytes.length),
              'X-Goog-Upload-Offset': '0',
              'X-Goog-Upload-Command': 'upload, finalize',
            },
            body: bytes,
          },
          deadline,
          async (res) => {
            const parsed = await readJson(res, 1024 * 1024);
            if (!parsed || parsed.ok !== true) return parsed;
            const file = parsed.json && parsed.json.file ? parsed.json.file : parsed.json;
            const uri = file && typeof file.uri === 'string' ? file.uri : '';
            if (!uri) return badResponse("sans champ 'uri'", JSON.stringify(parsed.json).slice(0, 200));
            return {
              ok: true,
              uri,
              name: typeof file.name === 'string' ? file.name : '',
              mimeType: typeof file.mimeType === 'string' ? file.mimeType : mimeType,
              state: typeof file.state === 'string' ? file.state : 'UNKNOWN',
            };
          },
        );
      });
    } catch (err) {
      return fail('internal', `erreur interne du client Gemini: ${errText(err)}`);
    }
  }

  /**
   * `GET /v1beta/{name}` for an uploaded file — video and audio uploads land in
   * state `PROCESSING` and are unusable until `ACTIVE`.
   *
   * @param {string} name e.g. `files/abc123`
   * @returns {Promise<{ok:true, state:string, uri:string}|{ok:false, code:string, error:string, hint?:string}>}
   */
  async function fileStatus(name) {
    try {
      if (!apiKey) return notConfigured();
      const n = typeof name === 'string' ? name.trim().replace(/^\/+/, '') : '';
      if (!n) return fail('bad_request', 'nom de fichier manquant');
      const deadline = Date.now() + timeoutMs;
      return await runLimited(async () =>
        send(
          `${API_HOST}/v1beta/${n}`,
          { method: 'GET', headers: authHeaders({ Accept: 'application/json' }) },
          deadline,
          async (res) => {
            const parsed = await readJson(res, 1024 * 1024);
            if (!parsed || parsed.ok !== true) return parsed;
            const file = parsed.json && parsed.json.file ? parsed.json.file : parsed.json;
            return {
              ok: true,
              state: file && typeof file.state === 'string' ? file.state : 'UNKNOWN',
              uri: file && typeof file.uri === 'string' ? file.uri : '',
            };
          },
        ),
      );
    } catch (err) {
      return fail('internal', `erreur interne du client Gemini: ${errText(err)}`);
    }
  }

  /** Queue gauge for the operator's /status route. */
  function stats() {
    return {
      inflight,
      waiting: waiters.filter((w) => !w.cancelled).length,
      maxConcurrent,
    };
  }

  return {
    interact,
    listModels,
    startVideo,
    operationStatus,
    downloadToFile,
    uploadFile,
    fileStatus,
    stats,
    hasKey: () => apiKey !== '',
  };
}

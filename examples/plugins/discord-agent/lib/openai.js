// openai.js — Whisper transcription + TTS synthesis over pure `fetch`.
//
// Node 24 globals only (fetch / FormData / Blob) — no SDK, no ffmpeg, no native
// deps. Both calls do ONE short retry on 429 / 5xx / network errors. The runtime
// image ships no toolchain, so audio stays in formats that need no transcoding:
//   - STT: Discord voice clips are OGG/Opus, accepted by Whisper as-is (the file
//          must be named *.ogg so OpenAI infers the container).
//   - TTS: response_format:'opus' returns OGG/Opus 48 kHz, sendable to Discord
//          as a native voice message with no conversion.

const TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const SPEECH_URL = 'https://api.openai.com/v1/audio/speech';

/** OpenAI TTS hard input cap (characters). */
export const TTS_MAX_INPUT = 4096;
/** Whisper upload cap (bytes) — 25 MiB. */
export const STT_MAX_BYTES = 25 * 1024 * 1024;

const OPENAI_TIMEOUT_MS = 60_000;

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/** A fetch with an AbortController timeout; a timeout is marked retriable. */
async function fetchWithTimeout(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    // Network / abort errors are transient — allow one retry.
    /** @type {any} */ (e).retriable = true;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** @param {number} status */
function isRetriableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Run `fn`, retrying ONCE on a retriable failure after a short jittered wait. */
async function withOneRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err && /** @type {any} */ (err).retriable) {
      await sleep(500 + Math.floor(Math.random() * 500));
      return await fn();
    }
    throw err;
  }
}

/**
 * Transcribe an OGG/Opus voice clip.
 *
 * @param {{ apiKey: string, model: string, language?: string, data: Buffer|Uint8Array, filename?: string }} opts
 * @returns {Promise<string>} the transcript text
 */
export async function whisperTranscribe(opts) {
  const { apiKey, model, language, data, filename = 'audio.ogg' } = opts;
  return withOneRetry(async () => {
    const form = new FormData();
    // OpenAI infers the container from the file NAME — must end in .ogg.
    form.append('file', new Blob([data], { type: 'audio/ogg' }), filename);
    form.append('model', model);
    if (language) form.append('language', language);
    const res = await fetchWithTimeout(
      TRANSCRIBE_URL,
      { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form },
      OPENAI_TIMEOUT_MS,
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const e = new Error(`whisper ${res.status}: ${body.slice(0, 300)}`);
      /** @type {any} */ (e).retriable = isRetriableStatus(res.status);
      throw e;
    }
    const json = await res.json().catch(() => ({}));
    return typeof json.text === 'string' ? json.text : '';
  });
}

/**
 * Synthesize speech to an OGG/Opus buffer (response_format:'opus').
 *
 * @param {{ apiKey: string, model: string, voice: string, input: string }} opts
 * @returns {Promise<Buffer>} OGG/Opus 48 kHz audio
 */
export async function ttsSpeak(opts) {
  const { apiKey, model, voice, input } = opts;
  return withOneRetry(async () => {
    const res = await fetchWithTimeout(
      SPEECH_URL,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, voice, input, response_format: 'opus' }),
      },
      OPENAI_TIMEOUT_MS,
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const e = new Error(`tts ${res.status}: ${body.slice(0, 300)}`);
      /** @type {any} */ (e).retriable = isRetriableStatus(res.status);
      throw e;
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  });
}

/**
 * Download an attachment URL to a Buffer with a timeout and a hard size cap. A
 * network/timeout error, a non-2xx response, or an over-cap body throws. The cap
 * is enforced on the DOWNLOADED bytes (not just the advertised attachment.size,
 * which a client can under-report).
 *
 * @param {string} url
 * @param {number} [timeoutMs]
 * @param {number} [maxBytes]
 * @returns {Promise<Buffer>}
 */
export async function downloadToBuffer(url, timeoutMs = 15_000, maxBytes = STT_MAX_BYTES) {
  const res = await fetchWithTimeout(url, { method: 'GET' }, timeoutMs);
  if (!res.ok) {
    throw new Error(`download ${res.status}`);
  }
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  if (buf.length > maxBytes) {
    throw new Error(`fichier trop volumineux (${buf.length} > ${maxBytes} octets)`);
  }
  return buf;
}

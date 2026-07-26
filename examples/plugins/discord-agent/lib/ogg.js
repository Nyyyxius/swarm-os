// ogg.js — pure-JS helpers for the outbound voice path. No native deps.
//
// `oggDurationSecs`  : read the playback duration of an OGG/Opus buffer (what
//                      OpenAI TTS returns with response_format:'opus') without
//                      decoding it — Discord's voice-message bubble needs a
//                      `duration_secs`.
// `syntheticWaveform`: a tiny base64 amplitude preview for that same bubble
//                      (Discord requires a waveform; we synthesize a neutral one
//                      since we don't decode the PCM).

const OGG_CAPTURE_PATTERN = 0x4f676753; // 'OggS'
const OPUS_SAMPLE_RATE = 48000; // Opus granule positions are always at 48 kHz.
const GRANULE_UNSET = 0xffffffffffffffffn; // -1 as u64 — header/continuation page.

/**
 * Playback duration in seconds of an OGG/Opus stream. Scans BACKWARD for the
 * last Ogg page carrying a valid granule position (skipping pages whose granule
 * is -1) and divides it by the Opus clock (48 kHz). Overestimates by the encoder
 * pre-skip (~80 ms), which is negligible for a voice bubble.
 *
 * Ogg page header layout: 'OggS'(4) | version(1) | header_type(1) |
 * granule_position(8, little-endian) | ... — granule starts at offset +6.
 *
 * @param {Buffer|Uint8Array} buf
 * @returns {number} seconds (0 when no valid page is found)
 */
export function oggDurationSecs(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  for (let i = b.length - 4; i >= 0; i--) {
    if (
      b[i] === 0x4f && // O
      b[i + 1] === 0x67 && // g
      b[i + 2] === 0x67 && // g
      b[i + 3] === 0x53 // S
    ) {
      // Need the full 8-byte granule field after the 6-byte prefix.
      if (i + 14 > b.length) continue;
      const granule = b.readBigUInt64LE(i + 6);
      if (granule === GRANULE_UNSET) continue; // -1 page: keep scanning back.
      return Number(granule) / OPUS_SAMPLE_RATE;
    }
  }
  return 0;
}

/**
 * A small synthetic amplitude preview (base64) for Discord's voice bubble. We do
 * not decode the audio, so the shape is decorative — a gentle wave. Discord caps
 * the waveform near 256 bytes; 64 samples encode to ~88 base64 chars.
 *
 * @param {number} [samples]
 * @returns {string} base64
 */
export function syntheticWaveform(samples = 64) {
  const n = Math.max(1, Math.min(192, samples | 0));
  const arr = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    // A slow envelope with a couple of gentle bumps, clamped to a byte.
    const env = Math.sin((i / n) * Math.PI); // 0 -> 1 -> 0
    const detail = 0.5 + 0.5 * Math.sin((i / n) * Math.PI * 6);
    const v = Math.round(30 + env * detail * 200);
    arr[i] = Math.max(0, Math.min(255, v));
  }
  return arr.toString('base64');
}

// Exported for reference/testing; not otherwise consumed.
export const _OGG_INTERNALS = { OGG_CAPTURE_PATTERN, OPUS_SAMPLE_RATE, GRANULE_UNSET };

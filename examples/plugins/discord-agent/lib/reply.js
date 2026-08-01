// reply.js — the outbound MCP tool `discord-agent.reply`.
//
// The lead's ONLY way back to Discord. Lead-only + a team guard (the tool is
// visible to every lead, so we reject callers that aren't the orch bound to this
// channel). The handler NEVER throws: a throw would be charged to the plugin's
// quarantine counter, so every failure returns { ok:false, error }.
//
// Modes:
//   - 'text'  : chunk to <=2000 chars on paragraph/line/space boundaries and send
//               sequentially; the first chunk carries the reply reference.
//   - 'voice' : OpenAI TTS -> OGG/Opus, sent as a NATIVE Discord voice message via
//               raw REST (discord.js has no send-side voice-message support); a
//               4xx falls back to an ordinary audio attachment.
//   - 'auto'  : resolves to the modality of the last inbound message.
//
// Security: allowedMentions {parse:[]} on every channel.send and no permissive
// allowed_mentions in the raw voice payload — the agent can never ping.

import { Routes } from 'discord.js';
import { ttsSpeak, TTS_MAX_INPUT } from './openai.js';
import { oggDurationSecs, syntheticWaveform } from './ogg.js';

const SEND_TIMEOUT_MS = 5_000;
const REST_TIMEOUT_MS = 15_000; // raw REST voice upload (audio payload can be larger)
const CHUNK_SIZE = 2_000;
const VOICE_FLAG = 8192; // MessageFlags.IsVoiceMessage
const VOICE_FILENAME = 'voice-message.ogg';

/**
 * @param {import('../index.js').Runtime} rt
 * @returns {import('@swarm-os/plugin-sdk').PluginToolDef}
 */
export function buildReplyToolDef(rt) {
  const z = rt.api.zod;
  return {
    name: 'reply',
    title: 'Repondre sur Discord',
    description:
      "Envoie une reponse dans le canal Discord lie a cette equipe. Seul moyen de repondre a l'humain. mode:'voice' pour repondre a un message vocal (clip TTS), 'text' pour du texte, 'auto' pour suivre la modalite du dernier message recu. Passer reply_to_message_id (le discord_message_id de l'inbox) et thread_id si le message venait d'un thread. Si la reponse contient 'partial:true', une partie seulement a ete envoyee (voir message_ids): NE PAS renvoyer tout le texte — renvoyer uniquement la suite non delivree.",
    leadOnly: true,
    inputSchema: {
      text: z.string().min(1).max(8000).describe('Le texte de la reponse.'),
      mode: z
        .enum(['auto', 'text', 'voice'])
        .default('auto')
        .describe("'voice' = clip vocal TTS, 'text' = message texte, 'auto' = modalite du dernier message recu."),
      reply_to_message_id: z
        .string()
        .optional()
        .describe('discord_message_id auquel repondre (reference native Discord).'),
      thread_id: z.string().optional().describe("id du thread ou repondre (sinon le canal principal)."),
    },
    outputSchema: {
      ok: z.boolean(),
      mode: z.string().optional(),
      message_ids: z.array(z.string()).optional(),
      partial: z.boolean().optional(),
      fallback: z.boolean().optional(),
      note: z.string().optional(),
      error: z.string().optional(),
    },
    async handler(args, ctx) {
      try {
        return await handleReply(rt, args, ctx);
      } catch (err) {
        rt.log.warn(
          { event: 'discord-agent.reply_error', error: String(err) },
          'discord-agent reply handler failed',
        );
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/**
 * @param {import('../index.js').Runtime} rt
 * @param {Record<string, unknown>} args
 * @param {import('@swarm-os/plugin-sdk').PluginToolContext} ctx
 */
async function handleReply(rt, args, ctx) {
  const kv = rt.api.storage.kv;

  // Team guard: only the orch bound to this channel may reply.
  const teamId = kv.get('teamId');
  if (!teamId || ctx.orchestratorId !== teamId) {
    return { ok: false, error: "cette equipe n'est pas liee au canal Discord" };
  }
  if (!rt.client || !rt.gateway || !rt.gateway.isReady()) {
    return { ok: false, error: 'gateway Discord non pret' };
  }

  const text = typeof args.text === 'string' ? args.text : '';
  if (!text) return { ok: false, error: 'texte vide' };
  const replyToId = typeof args.reply_to_message_id === 'string' ? args.reply_to_message_id : undefined;
  const threadId = typeof args.thread_id === 'string' ? args.thread_id : undefined;
  const target = threadId || rt.cfg.channelId;

  // Resolve mode.
  let mode = typeof args.mode === 'string' ? args.mode : 'auto';
  if (mode === 'auto') {
    let last = {};
    try {
      last = JSON.parse(kv.get('last_inbound') || '{}');
    } catch {
      last = {};
    }
    mode = last && last.modality === 'voice' ? 'voice' : 'text';
  }

  if (mode === 'voice') {
    if (text.length > TTS_MAX_INPUT) {
      // Too long for TTS — fall back to text with a one-line note.
      const note = '(reponse trop longue pour le vocal — envoyee en texte)';
      const r = await sendText(rt, target, `${note}\n\n${text}`, replyToId);
      return {
        ok: r.ok,
        mode: 'text',
        message_ids: r.message_ids,
        fallback: true,
        note,
        ...(r.partial ? { partial: true } : {}),
        ...(r.error ? { error: r.error } : {}),
      };
    }
    return await sendVoice(rt, target, text, replyToId);
  }

  const r = await sendText(rt, target, text, replyToId);
  return {
    ok: r.ok,
    mode: 'text',
    message_ids: r.message_ids,
    ...(r.partial ? { partial: true } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Send `text` as one or more chunked messages. If a chunk fails after some were
 * already sent, returns `{ ok:false, partial:true, message_ids }` so the lead can
 * resend ONLY the missing tail (never the whole text — see the tool description).
 *
 * @param {import('../index.js').Runtime} rt
 * @param {string} target
 * @param {string} text
 * @param {string|undefined} replyToId
 * @returns {Promise<{ ok: boolean, message_ids: string[], partial?: boolean, error?: string }>}
 */
export async function sendText(rt, target, text, replyToId) {
  const channel = await fetchSendable(rt, target);
  const chunks = chunkText(text, CHUNK_SIZE);
  const ids = [];
  for (let i = 0; i < chunks.length; i++) {
    const payload = {
      content: chunks[i],
      // Deny-all incl. the replied-user ping when a reply reference is attached.
      allowedMentions: { parse: [], repliedUser: false },
    };
    if (i === 0 && replyToId) {
      payload.reply = { messageReference: replyToId, failIfNotExists: false };
    }
    try {
      const sent = await sendWithTimeout(channel, payload);
      if (sent && sent.id) ids.push(sent.id);
    } catch (err) {
      rt.log.warn(
        { event: 'discord-agent.reply_text_partial', sent: ids.length, at: i, total: chunks.length, error: String(err) },
        'discord-agent text reply failed mid-way',
      );
      return {
        ok: false,
        partial: ids.length > 0,
        message_ids: ids,
        error: `chunk ${i + 1}/${chunks.length} echoue: ${String(err)}`,
      };
    }
  }
  rt.log.info({ event: 'discord-agent.reply_text', chunks: chunks.length }, 'discord-agent text reply sent');
  return { ok: true, message_ids: ids };
}

/** channel.send wrapped in a 5s Promise.race with a finally-cleared timer. */
function sendWithTimeout(channel, payload) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`discord send timed out after ${SEND_TIMEOUT_MS}ms`)), SEND_TIMEOUT_MS);
  });
  return Promise.race([channel.send(payload), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Split `text` into <=`max`-char chunks, preferring paragraph, then line, then
 * word boundaries. Implemented in the plugin (the host mailbox does not chunk).
 * @param {string} text
 * @param {number} max
 * @returns {string[]}
 */
export function chunkText(text, max) {
  // TODO(v1.1): boundary-aware for Markdown code fences — a split landing inside
  // a ``` block currently breaks the fence across two messages. Acceptable in v1
  // (voice-style replies avoid code; long code should be sent as an attachment).
  if (text.length <= max) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n\n');
    if (cut < max * 0.5) cut = window.lastIndexOf('\n');
    if (cut < max * 0.5) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = max; // no boundary — hard split
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks.filter((c) => c.length > 0);
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

/**
 * @param {import('../index.js').Runtime} rt
 * @param {string} target
 * @param {string} text
 * @param {string|undefined} replyToId
 */
async function sendVoice(rt, target, text, replyToId) {
  const buf = await ttsSpeak({
    apiKey: rt.cfg.openaiApiKey,
    model: rt.cfg.ttsModel,
    voice: rt.cfg.ttsVoice,
    input: text,
  });
  const duration = oggDurationSecs(buf);
  const waveform = syntheticWaveform();

  const body = {
    flags: VOICE_FLAG,
    attachments: [{ id: '0', filename: VOICE_FILENAME, duration_secs: duration, waveform }],
    // Deny-all incl. the replied-user ping — the agent can never ping.
    allowed_mentions: { parse: [], replied_user: false },
  };
  if (replyToId) {
    body.message_reference = { message_id: replyToId, fail_if_not_exists: false };
  }

  try {
    const sent = await raceTimeout(
      rt.client.rest.post(Routes.channelMessages(target), {
        body,
        files: [{ name: VOICE_FILENAME, contentType: 'audio/ogg', data: buf }],
      }),
      REST_TIMEOUT_MS,
      'discord voice REST',
    );
    const id = sent && typeof sent.id === 'string' ? sent.id : undefined;
    rt.log.info(
      { event: 'discord-agent.reply_voice', durationSecs: duration },
      'discord-agent native voice reply sent',
    );
    return { ok: true, mode: 'voice', message_ids: id ? [id] : [] };
  } catch (err) {
    const status = err && typeof err.status === 'number' ? err.status : undefined;
    const is4xx = typeof status === 'number' && status >= 400 && status < 500;
    // ONLY a 4xx means Discord definitively rejected the native voice payload
    // (missing permission / schema mismatch) with nothing posted — safe to fall
    // back to an ordinary audio attachment. A 5xx / timeout / parse error may
    // have partially applied server-side; falling back would risk a DOUBLE post,
    // so we surface a clean failure instead.
    if (!is4xx) {
      rt.log.warn(
        { event: 'discord-agent.reply_voice_failed', status, error: String(err) },
        'discord-agent native voice send failed (no fallback — non-4xx)',
      );
      return { ok: false, error: `envoi vocal echoue (statut ${status ?? 'n/a'})` };
    }
    rt.log.warn(
      { event: 'discord-agent.reply_voice_fallback', status, error: String(err) },
      'discord-agent native voice send refused (4xx) — falling back to audio attachment',
    );
    try {
      const channel = await fetchSendable(rt, target);
      const payload = {
        files: [{ attachment: buf, name: VOICE_FILENAME }],
        allowedMentions: { parse: [], repliedUser: false },
      };
      if (replyToId) payload.reply = { messageReference: replyToId, failIfNotExists: false };
      const sent = await sendWithTimeout(channel, payload);
      const id = sent && sent.id ? sent.id : undefined;
      return {
        ok: true,
        mode: 'voice',
        message_ids: id ? [id] : [],
        fallback: true,
        note: 'message vocal natif refuse — envoye en piece jointe audio',
      };
    } catch (err2) {
      return { ok: false, error: `voice + fallback echoues: ${String(err2)}` };
    }
  }
}

/** Race a promise against a timeout; the timer is cleared in finally. */
function raceTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} a expire apres ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** @param {import('../index.js').Runtime} rt */
async function fetchSendable(rt, id) {
  const client = rt.client;
  const cached = client.channels.cache.get(id);
  const channel = cached ?? (await client.channels.fetch(id));
  if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased()) {
    throw new Error(`canal ${id} introuvable ou non textuel`);
  }
  return channel;
}

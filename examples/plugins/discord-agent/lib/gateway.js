// gateway.js — the discord.js Gateway connection + inbound pipeline.
//
// Owns the single `Client` (intents Guilds / GuildMessages / MessageContent —
// MessageContent is PRIVILEGED, enable it in the Discord Developer Portal). Every
// event callback is fully try/catch-wrapped: discord.js callbacks are NOT covered
// by the host `guard()`, so an escaping throw would be uncharged and could crash
// the process.
//
// Delivery is AT-MOST-ONCE via a kv cursor (`lastProcessedMessageId`), never a
// redelivery buffer:
//   - MAIN channel: the single delivery path is `pump()` — it fetches messages
//     after the cursor and delivers them in order, advancing the cursor only
//     after a successful delivery. A live `messageCreate` on the main channel is
//     just a trigger for `pump()`; `ready` and `subscribeOrch` also pump. This
//     is gapless and never double-delivers (the cursor is the single source of
//     truth), which a "deliver-from-the-live-event + separate catch-up" split
//     could not guarantee under a reconnect race.
//   - THREAD messages: delivered directly from the live event (catch-up is main
//     channel only in v1); no cursor, best-effort.

import { Client, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import { ensureTeam } from './provision.js';
import { whisperTranscribe, downloadToBuffer, STT_MAX_BYTES } from './openai.js';
import { sendText } from './reply.js';

const LOGIN_TIMEOUT_MS = 15_000;
const DESTROY_TIMEOUT_MS = 3_000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;
/** Inbox body cap in BYTES (mailbox caps at 16384 bytes; leave headroom — note
 *  French accents are 2 bytes in UTF-8, so we budget by bytes, not chars). */
const MAX_INBOX_BYTES = 12_000;

/**
 * @param {import('../index.js').Runtime} rt
 * @returns {import('../index.js').Gateway}
 */
export function createGateway(rt) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      // PRIVILEGED — without it message.content is empty for non-mentions and
      // the inbound flow looks silently broken.
      GatewayIntentBits.MessageContent,
      // P5 approval-by-reaction: receive `messageReactionAdd` on our channel.
      GatewayIntentBits.GuildMessageReactions,
    ],
    // The approval card the operator reacts to predates this session's cache
    // (it was posted by the server hook, possibly before a reconnect). Without
    // these partials discord.js would drop reaction events on uncached
    // messages/channels; we fetch the partial on demand in the handler.
    partials: [Partials.Message, Partials.Reaction, Partials.Channel],
  });
  rt.client = client;
  let ready = false;
  let readyHandled = false;

  client.on('messageCreate', (msg) => {
    try {
      void handleMessage(rt, msg).catch((err) => {
        rt.log.warn(
          { event: 'discord-agent.handle_error', error: String(err) },
          'discord-agent messageCreate handler failed',
        );
      });
    } catch (err) {
      rt.log.warn(
        { event: 'discord-agent.handle_error', error: String(err) },
        'discord-agent messageCreate handler threw',
      );
    }
  });

  // P5 — approval-by-reaction. Sibling of messageCreate: a ✅/♾️/❌ reaction on an
  // approval card resolves the pending approval through the same shared core as a
  // native reply. Fully guarded (a discord.js callback throw is NOT covered by
  // the host guard()); a reaction is never inboxed, so a non-decision is a no-op.
  client.on('messageReactionAdd', (reaction, user) => {
    try {
      void handleReactionAdd(rt, reaction, user).catch((err) => {
        rt.log.warn(
          { event: 'discord-agent.reaction_error', error: String(err) },
          'discord-agent messageReactionAdd handler failed',
        );
      });
    } catch (err) {
      rt.log.warn(
        { event: 'discord-agent.reaction_error', error: String(err) },
        'discord-agent messageReactionAdd handler threw',
      );
    }
  });

  const onReadyOnce = () => {
    if (readyHandled) return;
    readyHandled = true;
    ready = true;
    try {
      void onReady(rt).catch((err) => {
        rt.log.warn(
          { event: 'discord-agent.ready_error', error: String(err) },
          'discord-agent ready handler failed',
        );
      });
    } catch (err) {
      rt.log.warn(
        { event: 'discord-agent.ready_error', error: String(err) },
        'discord-agent ready handler threw',
      );
    }
  };
  // v14.16+ emits 'clientReady'; keep 'ready' as a guarded fallback.
  client.once('clientReady', onReadyOnce);
  client.once('ready', onReadyOnce);

  client.on('error', (err) => {
    try {
      rt.log.warn(
        { event: 'discord-agent.client_error', error: err instanceof Error ? err.message : String(err) },
        'discord-agent client error',
      );
    } catch {
      /* logging must never throw out of an event callback */
    }
  });
  client.on('shardError', (err) => {
    try {
      rt.log.warn(
        { event: 'discord-agent.shard_error', error: err instanceof Error ? err.message : String(err) },
        'discord-agent shard error',
      );
    } catch {
      /* ignore */
    }
  });

  const gateway = {
    isReady: () => ready,

    async start() {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`discord login did not complete within ${LOGIN_TIMEOUT_MS}ms`)),
          LOGIN_TIMEOUT_MS,
        );
      });
      rt.loginTimer = timer;
      try {
        await Promise.race([client.login(rt.cfg.botToken), timeout]);
        rt.log.info({ event: 'discord-agent.login_ok' }, 'discord-agent logged in');
      } catch (err) {
        // Sanitize: never relay the raw error (a discord.js login failure can
        // echo request context). Log a short, redacted reason; notify generically.
        const reason = sanitizeError(err);
        rt.log.warn(
          { event: 'discord-agent.login_failed', reason },
          'discord-agent login failed (plugin stays alive; fix token then PUT config to reload)',
        );
        void rt.api.notify
          .custom({
            title: 'Connexion Discord echouee',
            message:
              "Le bot n'a pas pu se connecter a Discord (voir les logs serveur). Verifier le botToken et l'intent MessageContent, puis re-enregistrer la configuration.",
            level: 'critical',
          })
          .catch(() => {});
      } finally {
        clearTimeout(timer);
        rt.loginTimer = null;
      }
    },

    async destroy() {
      ready = false;
      // Detach handlers SYNCHRONOUSLY first: closes the double-Gateway /
      // double-reply window if a reload races the teardown.
      try {
        client.removeAllListeners();
        // Reattach a no-op 'error' sink BEFORE destroy(): an 'error' emitted
        // during the ~3 s destroy race would otherwise become a fatal
        // uncaughtException (an EventEmitter 'error' with no listener throws).
        client.on('error', () => {});
      } catch {
        /* ignore */
      }
      if (rt.loginTimer) {
        clearTimeout(rt.loginTimer);
        rt.loginTimer = null;
      }
      const grace = new Promise((res) => setTimeout(res, DESTROY_TIMEOUT_MS));
      try {
        await Promise.race([Promise.resolve(client.destroy()), grace]);
      } catch (err) {
        rt.log.warn(
          { event: 'discord-agent.destroy_error', error: String(err) },
          'discord-agent client.destroy failed',
        );
      }
    },

    pump: () => pump(rt),
    schedulePump: () => {
      queueMicrotask(() => {
        pump(rt).catch(() => {});
      });
    },
  };

  rt.gateway = gateway;
  return gateway;
}

// ---------------------------------------------------------------------------
// Inbound pipeline
// ---------------------------------------------------------------------------

/** @param {any} msg */
function isHuman(msg) {
  return msg && msg.author && msg.author.bot !== true && msg.system !== true;
}

/**
 * @param {import('../index.js').Runtime} rt
 * @param {any} msg
 */
function isAllowed(rt, msg) {
  if (rt.cfg.allowedUserIds.size === 0) return false; // fail-closed
  return rt.cfg.allowedUserIds.has(msg.author.id);
}

/** True for a Discord voice message (flag 8192, or a lone waveform attachment). */
function isVoiceMessage(msg) {
  try {
    if (msg.flags && typeof msg.flags.has === 'function' && msg.flags.has(MessageFlags.IsVoiceMessage)) {
      return true;
    }
  } catch {
    /* fall through to attachment heuristic */
  }
  const atts = msg.attachments;
  if (atts && atts.size === 1) {
    const a = atts.first();
    if (a && a.waveform != null) return true;
  }
  return false;
}

/** Resolve the main-channel id a message belongs to (thread -> parent). */
function resolveParentId(rt, msg) {
  const channel = msg.channel || {};
  const isThread = typeof channel.isThread === 'function' && channel.isThread();
  const parentId = isThread ? channel.parentId ?? msg.channelId : msg.channelId;
  return { isThread, parentId, threadName: isThread ? channel.name : undefined };
}

/**
 * Live `messageCreate` handler. Never throws (wrapped by the caller too).
 * @param {import('../index.js').Runtime} rt
 * @param {any} msg
 */
async function handleMessage(rt, msg) {
  if (!isHuman(msg)) return; // drops bots (incl. our own voice replies) + system
  const { isThread, parentId, threadName } = resolveParentId(rt, msg);
  if (parentId !== rt.cfg.channelId) return; // not our channel

  if (rt.cfg.allowedUserIds.size === 0) {
    warnEmptyAllowlistOnce(rt);
    return; // fail-closed
  }
  if (!rt.cfg.allowedUserIds.has(msg.author.id)) return; // not authorised -> drop

  if (isThread) {
    // Thread messages are delivered live (catch-up is main-channel only in v1).
    // No binding yet: create the team INLINE and deliver if it wired in time;
    // otherwise mark the message with ❌ so the user isn't left in silence (no
    // queue — the cursor only covers the main channel).
    if (!rt.binding) {
      await ensureTeam(rt);
    }
    if (rt.binding) {
      await deliverMessage(rt, msg, { threadId: msg.channelId, threadName });
    } else {
      await reactSafe(msg, '❌');
      rt.log.warn(
        { event: 'discord-agent.thread_no_binding', messageId: msg.id },
        'discord-agent thread message could not be delivered (no team wired yet)',
      );
    }
    return;
  }
  // Main channel: the cursor pump is the single delivery path.
  await pump(rt);
}

/**
 * Live `messageReactionAdd` handler — resolve a pending approval when an operator
 * clicks ✅ / ♾️ / ❌ on a card the server posted. Mirrors the native-reply path
 * (`deliverMessage`'s `tryConsumeApprovalReply`) but off a different event: a
 * reaction is NEVER pushed to the inbox, so anything that is not a decision on one
 * of our cards is a silent no-op. Never throws (also wrapped by the caller).
 *
 * @param {import('../index.js').Runtime} rt
 * @param {any} reaction — a MessageReaction (possibly partial)
 * @param {any} user — the User who added it (possibly partial)
 */
async function handleReactionAdd(rt, reaction, user) {
  try {
    // Ignore bots, and above all our OWN pre-seeded reactions: the card is seeded
    // with the three emojis by this bot, and that self-add must not self-resolve.
    if (!user || user.bot) return;
    if (rt.client && rt.client.user && user.id === rt.client.user.id) return;

    // Fail-closed auth, same posture as the inbound message path (deliverMessage
    // only ever runs for allowlisted authors). Resolving an approval drives a
    // bypassPermissions agent, so a non-allowlisted reactor must NOT decide.
    if (!rt.cfg.allowedUserIds || rt.cfg.allowedUserIds.size === 0) return;
    if (!rt.cfg.allowedUserIds.has(user.id)) return;

    // Resolve partials on demand — the card predates this session's cache (it was
    // posted by the server hook, maybe before a reconnect). Each fetch is guarded
    // independently: a fetch failure must never crash the handler.
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch (err) {
        rt.log.warn(
          { event: 'discord-agent.reaction_fetch_failed', error: String(err) },
          'discord-agent could not fetch partial reaction — ignoring',
        );
        return;
      }
    }
    if (reaction.message && reaction.message.partial) {
      try {
        await reaction.message.fetch();
      } catch (err) {
        rt.log.warn(
          { event: 'discord-agent.reaction_msg_fetch_failed', error: String(err) },
          'discord-agent could not fetch partial reaction message — ignoring',
        );
        return;
      }
    }

    const binding = rt.binding;
    if (!binding || typeof binding.sub?.tryConsumeApprovalReaction !== 'function') return;

    const emoji = reaction.emoji?.name;
    const messageId = reaction.message?.id;
    if (!messageId) return;

    let result;
    try {
      result = binding.sub.tryConsumeApprovalReaction({
        messageId,
        emoji,
        reactor: user.username || user.id,
      });
    } catch (err) {
      // A resolver failure must never escape — a reaction is best-effort.
      rt.log.warn(
        { event: 'discord-agent.approval_reaction_failed', messageId, error: String(err) },
        'discord-agent approval reaction routing failed',
      );
      return;
    }

    if (!result || !result.consumed) return; // not a decision on one of our cards

    if (result.confirmation) {
      // Post the confirmation into the channel the card lives in, as a reply to it.
      const channelId = reaction.message?.channelId || rt.cfg.channelId;
      void sendText(rt, channelId, result.confirmation, messageId).catch(() => {
        /* best-effort — the store record is authoritative regardless */
      });
    }
    rt.log.info(
      {
        event: 'discord-agent.approval_resolved_via_reaction',
        orchId: binding.orchId,
        messageId,
        emoji,
      },
      'discord-agent approval resolved via reaction (not pushed to inbox)',
    );
  } catch (err) {
    rt.log.warn(
      { event: 'discord-agent.reaction_error', error: String(err) },
      'discord-agent reaction handler failed',
    );
  }
}

/** @param {import('../index.js').Runtime} rt — on connect, just pump (doPump
 *  self-heals an empty cursor by seeding to latest before ever delivering). */
async function onReady(rt) {
  rt.log.info({ event: 'discord-agent.ready' }, 'discord-agent gateway ready');
  await pump(rt);
}

/**
 * Serialised main-channel catch-up. Delivers every allowed human message after
 * the cursor, in ascending id order, advancing the cursor after each success.
 * @param {import('../index.js').Runtime} rt
 * @returns {Promise<void>}
 */
function pump(rt) {
  rt.pumpChain = rt.pumpChain.then(() => doPump(rt)).catch((err) => {
    rt.log.warn(
      { event: 'discord-agent.pump_error', error: String(err) },
      'discord-agent pump failed',
    );
  });
  return rt.pumpChain;
}

/** @param {import('../index.js').Runtime} rt */
async function doPump(rt) {
  if (!rt.gateway || !rt.gateway.isReady()) return;
  const channel = await fetchMainChannel(rt);
  if (!channel || !channel.messages || typeof channel.messages.fetch !== 'function') return;
  const kv = rt.api.storage.kv;

  // Self-healing seed. An EMPTY cursor must NEVER deliver: fetch({after:''})
  // returns the latest 100 messages, which would replay pre-install history to a
  // bypassPermissions agent. Seed to the latest message id and RETURN — delivery
  // only ever covers messages that arrive AFTER the cursor exists. Idempotent, so
  // a transient seed failure self-repairs on the next pump (no fragile one-shot).
  if (!kv.get('lastProcessedMessageId')) {
    const coll = await channel.messages.fetch({ limit: 1 });
    const latest = coll && coll.size > 0 ? coll.first() : null;
    if (latest) {
      kv.set('lastProcessedMessageId', latest.id);
      rt.log.info(
        { event: 'discord-agent.cursor_seeded', cursor: latest.id },
        'discord-agent cursor seeded to latest message',
      );
    }
    return;
  }

  for (let page = 0; page < MAX_PAGES; page++) {
    const cursor = kv.get('lastProcessedMessageId'); // guaranteed non-empty (seeded above)
    const batch = await fetchAfter(channel, cursor);
    if (batch.length === 0) break;

    // If there is a deliverable message but no binding yet, create the team and
    // return WITHOUT advancing the cursor — delivery resumes when subscribeOrch
    // fires and re-pumps (no polling / grace window).
    const hasDeliverable = batch.some((m) => isHuman(m) && isAllowed(rt, m));
    if (hasDeliverable && !rt.binding) {
      void ensureTeam(rt);
      return;
    }

    for (const m of batch) {
      if (isHuman(m)) {
        if (rt.cfg.allowedUserIds.size === 0) {
          warnEmptyAllowlistOnce(rt);
        } else if (rt.cfg.allowedUserIds.has(m.author.id)) {
          if (!rt.binding) {
            void ensureTeam(rt);
            return; // cursor unchanged for this message; retried on next pump
          }
          const delivered = await deliverMessage(rt, m, {});
          if (!delivered) return; // hard failure — retry next pump, don't advance
        }
        // not-allowed human -> drop (advance cursor past it)
      }
      // M1 (push -> cursor window): `deliverMessage`'s `pushToLeadInbox` and this
      // `kv.set` run synchronously in the SAME tick (no await between them), so a
      // crash landing between the two is a negligible window. The mailbox now
      // persists write-through, so a redeliver after a crash would surface an
      // already-persisted message; the plan's at-most-once loss-vs-duplicate
      // reasoning holds — we advance the cursor only after a returned success.
      kv.set('lastProcessedMessageId', m.id);
    }

    if (batch.length < PAGE_LIMIT) break;
  }
}

/**
 * Deliver one message into the lead's inbox. Returns true on success (cursor may
 * advance) or false on a hard failure (retry). A transcription failure is a
 * SOFT failure: a text note is delivered and the message counts as processed.
 *
 * @param {import('../index.js').Runtime} rt
 * @param {any} msg
 * @param {{ threadId?: string, threadName?: string }} threadCtx
 * @returns {Promise<boolean>}
 */
async function deliverMessage(rt, msg, threadCtx) {
  try {
    const binding = rt.binding;
    if (!binding) return false;

    // ---- P5: is this a native REPLY that DECIDES a pending approval? --------
    // Mirrors the built-in bot (discord/bot.ts handleMessageCreate): checked
    // BEFORE any transcription and BEFORE pushToLeadInbox — a decision needs no
    // lead, and a consumed reply must NOT also land in the inbox. Only native
    // replies (`msg.reference.messageId`) correlate; this works for BOTH text
    // and voice replies and in threads (they all carry `msg.reference`). The
    // resolver is synchronous; the confirmation post is fire-and-forget (the
    // store record is authoritative regardless). Consuming counts as a processed
    // message so the caller advances the cursor (return true).
    if (msg.reference?.messageId && typeof binding.sub?.tryConsumeApprovalReply === 'function') {
      try {
        const result = binding.sub.tryConsumeApprovalReply({
          referenceMessageId: msg.reference.messageId,
          content: msg.content ?? '',
          author: msg.author?.username ?? 'inconnu',
        });
        if (result && result.consumed) {
          if (result.confirmation) {
            // Reply into the same channel/thread the operator wrote in.
            void sendText(rt, msg.channelId, result.confirmation, msg.id).catch(() => {
              /* best-effort — the store record is authoritative regardless */
            });
          }
          rt.log.info(
            {
              event: 'discord-agent.approval_resolved_via_reply',
              orchId: binding.orchId,
              messageId: msg.id,
              referenceMessageId: msg.reference.messageId,
            },
            'discord-agent approval resolved via native reply (not pushed to inbox)',
          );
          return true; // consumed decision — advance cursor, do NOT push inbox
        }
      } catch (err) {
        // A resolver failure must never block normal delivery: fall through.
        rt.log.warn(
          { event: 'discord-agent.approval_reply_failed', messageId: msg.id, error: String(err) },
          'discord-agent approval reply routing failed — delivering to inbox as usual',
        );
      }
    }

    const voice = isVoiceMessage(msg);
    const modality = voice ? 'voice' : 'text';
    const header = `[discord] de:@${msg.author?.username ?? 'inconnu'} | msg:${msg.id} | modalite:${
      voice ? 'vocal' : 'texte'
    }`;

    let bodyText;
    if (voice) {
      const t = await transcribeVoice(rt, msg);
      if (t.ok) {
        bodyText = t.text || '(transcription vide)';
      } else {
        void reactSafe(msg, '🔁');
        bodyText = `(message vocal non transcrit — erreur: ${t.error})`;
      }
    } else {
      bodyText = renderTextContent(msg) || '(message sans texte)';
    }

    const content = truncate(`${header}\n${bodyText}`, MAX_INBOX_BYTES);
    binding.sub.pushToLeadInbox(content, {
      from: `discord:${msg.author?.username ?? 'inconnu'}`,
      sourceKind: 'discord',
      sourceMessageId: msg.id,
      ...(threadCtx.threadId ? { threadId: threadCtx.threadId } : {}),
      ...(threadCtx.threadName ? { threadName: threadCtx.threadName } : {}),
    });
    binding.sub.notifyLead();

    rt.api.storage.kv.set(
      'last_inbound',
      JSON.stringify({ messageId: msg.id, modality, threadId: threadCtx.threadId ?? null }),
    );
    rt.log.info(
      { event: 'discord-agent.delivered', messageId: msg.id, modality, threadId: threadCtx.threadId },
      'discord-agent message delivered to lead',
    );
    return true;
  } catch (err) {
    rt.log.warn(
      { event: 'discord-agent.deliver_failed', messageId: msg.id, error: String(err) },
      'discord-agent delivery failed',
    );
    return false;
  }
}

/**
 * Download + transcribe a voice clip.
 * @param {import('../index.js').Runtime} rt
 * @param {any} msg
 * @returns {Promise<{ ok: true, text: string } | { ok: false, error: string }>}
 */
async function transcribeVoice(rt, msg) {
  try {
    const att = msg.attachments && msg.attachments.size > 0 ? msg.attachments.first() : null;
    if (!att || !att.url) return { ok: false, error: 'aucune piece jointe audio' };
    if (typeof att.size === 'number' && att.size > STT_MAX_BYTES) {
      return { ok: false, error: 'clip trop volumineux (>25 Mo)' };
    }
    const buf = await downloadToBuffer(att.url, 15_000);
    const text = await whisperTranscribe({
      apiKey: rt.cfg.openaiApiKey,
      model: rt.cfg.sttModel,
      language: rt.cfg.language,
      data: buf,
      filename: 'voice-message.ogg',
    });
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @param {import('../index.js').Runtime} rt */
async function fetchMainChannel(rt) {
  const id = rt.cfg.channelId;
  const client = rt.client;
  const cached = client.channels.cache.get(id);
  const channel = cached ?? (await client.channels.fetch(id).catch(() => null));
  if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased()) return null;
  return channel;
}

/**
 * Fetch up to PAGE_LIMIT messages after `cursor`, ascending by id. When `cursor`
 * is empty this would return the newest messages — callers only pump AFTER the
 * cursor is seeded (onReady), so that path is not hit in normal operation.
 */
async function fetchAfter(channel, cursor) {
  const opts = { limit: PAGE_LIMIT };
  if (cursor) opts.after = cursor;
  const coll = await channel.messages.fetch(opts);
  const arr = [...coll.values()];
  arr.sort((a, b) => {
    const ai = BigInt(a.id);
    const bi = BigInt(b.id);
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
  return arr;
}

/** @param {any} msg */
function renderTextContent(msg) {
  const parts = [];
  if (msg.content && msg.content.length > 0) parts.push(msg.content);
  if (msg.attachments && msg.attachments.size > 0) {
    const urls = [...msg.attachments.values()].map((a) => a.url).filter(Boolean);
    if (urls.length > 0) parts.push(`Pieces jointes:\n${urls.join('\n')}`);
  }
  return parts.join('\n\n');
}

/** Truncate `s` to at most `maxBytes` UTF-8 bytes, appending a marker. */
function truncate(s, maxBytes) {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const marker = '\n… [tronque]';
  const budget = maxBytes - Buffer.byteLength(marker, 'utf8');
  let slice = s.slice(0, budget); // chars <= bytes, so this is an upper bound
  while (slice.length > 0 && Buffer.byteLength(slice, 'utf8') > budget) {
    slice = slice.slice(0, slice.length - 16);
  }
  return slice + marker;
}

/** Best-effort reaction — never throws. @param {any} msg */
export async function reactSafe(msg, emoji) {
  try {
    if (msg && typeof msg.react === 'function') await msg.react(emoji);
  } catch {
    /* reactions are optional */
  }
}

/** A short, redacted reason safe to log — never the raw error or any token. */
function sanitizeError(err) {
  let msg = err instanceof Error ? err.message || err.name || 'Error' : String(err);
  // Redact token-shaped substrings (dot-separated base64-ish runs, or any long run).
  msg = msg.replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_.-]{6,}/g, '<redacted>');
  msg = msg.replace(/[A-Za-z0-9_-]{40,}/g, '<redacted>');
  return msg.slice(0, 200);
}

/** @param {import('../index.js').Runtime} rt */
function warnEmptyAllowlistOnce(rt) {
  const kv = rt.api.storage.kv;
  if (kv.get('warnedEmptyAllowlist')) return;
  kv.set('warnedEmptyAllowlist', '1');
  void rt.api.notify
    .custom({
      title: 'Allowlist Discord vide',
      message:
        "La liste 'allowedUserIds' est vide: par securite TOUS les messages Discord sont ignores (l'agent a un acces bypassPermissions au swarm). Renseigner les IDs Discord autorises dans la configuration du plugin.",
      level: 'warn',
    })
    .catch(() => {});
  rt.log.warn(
    { event: 'discord-agent.allowlist_empty' },
    'discord-agent allowlist empty — all inbound dropped (fail-closed)',
  );
}

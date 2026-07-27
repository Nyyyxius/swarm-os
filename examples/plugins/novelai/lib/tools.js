// tools.js — the plugin's entire public surface: the two MCP tools every agent
// of the swarm sees (`novelai.generate_text`, `novelai.generate_voice`) and the
// operator-facing `GET /plugin-api/novelai/status` route.
//
// THREE NON-NEGOTIABLE RULES FOR AN MCP HANDLER — each one is load-bearing:
//
//  1. A HANDLER NEVER THROWS. Every exit is a value. A throw reaches the host's
//     guard() and counts toward plugin quarantine (5 crashes / 60 s -> backoff up
//     to 1 h; packages/server/src/modules/plugins/host.ts:61-62 and :1066-1070),
//     so one malformed argument from one worker could silence the plugin for the
//     whole swarm. `lib/nai.js` upholds the same contract, which is why its
//     `{ok:false}` results are RELAYED VERBATIM here — rewriting a `code` or a
//     `hint` would only blur the diagnosis.
//  2. IN `outputSchema`, ONLY `ok` IS REQUIRED. The MCP SDK runs a
//     `safeParseAsync` over `structuredContent` and throws an `McpError` on any
//     mismatch, so a field that is absent on the error path must be `.optional()`
//     or the agent gets an opaque MCP failure instead of a readable `{ok:false}`.
//     Precedent: `discord-agent/lib/reply.js:53-61`.
//  3. NO `leadOnly`. `requireLead` throws an McpError (mcp-registry.ts:140), and
//     these tools have no reason to be reserved: a worker writing prose or a
//     voice line is the normal case.
//
// THREE PATHS PER FILE, AND IT IS NOT REDUNDANCY. Under the ssh transport the
// `claude` process runs on the HOST while this plugin runs in the CONTAINER, so
// one file legitimately has two absolute names:
//   - `path`               resolved in the AGENT's namespace (Read/ls work on it)
//   - `workspace_relative` the portable form, to hand to another tool or plugin
//   - `container_path`     what the server sees; the gap with `path` is exactly
//                          what makes a translation bug diagnosable.
//
// NO MUTABLE MODULE STATE. The loader's ESM cache-buster is applied to index.js
// only (loader.ts:29-30) and a relative import resolved from that busted URL
// drops the query, so this module stays in Node's ESM cache across plugin
// reloads. Everything per-activation lives in the `Runtime` passed to the
// builders below.
//
// Strings addressed to an agent or an operator follow the repo convention:
// French, WITHOUT accents (precedent: discord-agent/lib/status.js:23-31).

import * as path from 'node:path';

import { buildFileName, dateDir, ensureOutputDir, extFromContentType, sweep, writeAudio } from './files.js';
import { chunkForTts, contextCharsFor, jwtExpMs, surfaceFor } from './nai.js';
import { resolveOutputDir, toAgentPath, workspaceRoot } from './paths.js';
import { buildStoryPrompt } from './story.js';

/** Warn the operator this long before the persistent token expires. */
const EXPIRY_WARN_MS = 3 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** KV key holding the last failure surfaced to an agent (JSON, best-effort). */
const LAST_ERROR_KEY = 'last_error';

/** Hard ceiling applied by `chunkForTts` — mirrored here to detect truncation. */
const MAX_TTS_CHUNKS = 12;

/** Longest slice of the synthesised text used to build a file name. */
const SLUG_SOURCE_MAX = 60;

/** Two deliberately opposite voices for the differential probe. */
const PROBE_VOICE_A = 'Aini';
const PROBE_VOICE_B = 'Aulon';
/** Same short text both times: only the voice may differ. */
const PROBE_TEXT = 'test';

// ---------------------------------------------------------------------------
// Small argument helpers — defensive on purpose. The MCP layer already validates
// against `inputSchema`, but these handlers are also called directly by tests and
// by the daily probe, and rule 1 leaves no room for a TypeError.
// ---------------------------------------------------------------------------

/** @param {unknown} v @returns {string|undefined} */
function optStr(v) {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

/** @param {unknown} v @returns {number|undefined} */
function optNum(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** @param {unknown} v @returns {number|undefined} */
function optInt(v) {
  const n = optNum(v);
  return n === undefined ? undefined : Math.trunc(n);
}

/** @param {unknown} v @returns {string[]|undefined} */
function optStrArray(v) {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((s) => typeof s === 'string' && s.length > 0);
  return out.length > 0 ? out : undefined;
}

/**
 * Relay a client failure WITHOUT rewriting it. `lib/nai.js` already mapped the
 * upstream status to a stable `code` and wrote a hint aimed at whoever can act;
 * a second interpretation here would only lose information.
 *
 * @param {unknown} res whatever the client returned
 * @param {string} fallback error text when the value is not a shaped failure
 * @returns {{ok:false, code:string, error:string, hint?:string}}
 */
function relayFailure(res, fallback) {
  const r = /** @type {any} */ (res);
  if (r && typeof r === 'object') {
    const code = typeof r.code === 'string' && r.code ? r.code : 'internal';
    const error = typeof r.error === 'string' && r.error ? r.error : fallback;
    return typeof r.hint === 'string' && r.hint ? { ok: false, code, error, hint: r.hint } : { ok: false, code, error };
  }
  return { ok: false, code: 'internal', error: fallback };
}

/** The plugin has no usable token. Same wording for both tools. */
function notConfigured() {
  return {
    ok: false,
    code: 'not_configured',
    error: 'token NovelAI absent : le plugin novelai est installe mais pas configure',
    hint: "demande a l'operateur de renseigner apiToken dans la configuration du plugin novelai",
  };
}

/** The runtime has no client (called between deactivate and activate). */
function noClient() {
  return {
    ok: false,
    code: 'internal',
    error: 'client NovelAI indisponible (plugin en cours de rechargement)',
    hint: 'reessaie dans quelques secondes',
  };
}

/**
 * Remember the last failure for the operator's /status route. Best-effort by
 * construction: `rt.kv` already swallows a missing `db-kv` grant, and a failure
 * to record a failure must never become one.
 *
 * @param {import('../index.js').Runtime} rt
 * @param {string} tool
 * @param {{code?:string, error?:string}} failure
 */
function recordLastError(rt, tool, failure) {
  try {
    rt.kv.set(
      LAST_ERROR_KEY,
      JSON.stringify({
        at: new Date().toISOString(),
        tool,
        code: failure.code || 'internal',
        error: String(failure.error || '').slice(0, 300),
      }),
    );
  } catch {
    // Diagnostics are never worth failing a call for.
  }
}

/**
 * Fire the retention sweep and forget about it. NEVER awaited: an agent waiting
 * on its audio has no reason to wait on a directory walk, and `sweep()` is
 * throttled to one pass per hour anyway.
 *
 * @param {import('../index.js').Runtime} rt
 * @param {string} absDir
 */
function sweepBestEffort(rt, absDir) {
  try {
    void Promise.resolve(
      sweep({ absDir, retentionDays: rt.cfg.retentionDays, kv: rt.kv, log: rt.log }),
    ).catch(() => {});
  } catch {
    // sweep() is documented never to throw; this is belt and braces.
  }
}

// ---------------------------------------------------------------------------
// 1. novelai.generate_text
// ---------------------------------------------------------------------------

// Kept deliberately SHORT. A tool description is loaded into the context of
// EVERY session of EVERY agent in the swarm, including the ones that will never
// write a line of fiction. Only what makes the tool fail outright when ignored
// belongs here; the full method lives behind `novelai.writing_guide`, which
// costs nothing until it is called. The last line is what makes that guide
// discoverable — a manual nobody knows about is a manual nobody reads.
const TEXT_DESCRIPTION =
  'Genere de la prose avec un modele NovelAI et la retourne dans `text`. ' +
  "**NovelAI CONTINUE un texte, il ne repond pas a une consigne.** Pour ecrire une histoire, " +
  'utilise `story` (ce qui est deja ecrit), `memory` (personnages, decor, voix) et ' +
  '`authors_note` (ce qui doit arriver MAINTENANT) : le plugin assemble le contexte et place ' +
  'la direction au bon endroit. Un paragraphe par appel — genere, juge, garde ou relance. ' +
  'Ne consomme aucun Anlas. Une generation a la fois (5-20 s) ; si `code:"busy"`, reessaie. ' +
  'Avant ta premiere histoire, appelle `novelai.writing_guide`.';

/**
 * @param {import('../index.js').Runtime} rt
 * @returns {import('@swarm-os/plugin-sdk').PluginToolDef}
 */
export function buildTextToolDef(rt) {
  const z = rt.api.zod;
  return {
    name: 'generate_text',
    title: 'Generer de la prose (NovelAI Erato)',
    description: TEXT_DESCRIPTION,
    inputSchema: {
      // --- mode « histoire » : le plugin assemble --------------------------
      story: z
        .string()
        .max(200000)
        .optional()
        .describe(
          "Le texte deja ecrit. Envoie-le en entier : le plugin garde automatiquement la fin qui tient dans la fenetre du modele et coupe le debut.",
        ),
      memory: z
        .string()
        .max(4000)
        .optional()
        .describe(
          'Faits permanents, remis en tete a CHAQUE appel : qui sont les personnages, ou on est, les regles du monde, la voix narrative. Sans lui le modele oublie tout ce qui sort de la fenetre.',
        ),
      authors_note: z
        .string()
        .max(1000)
        .optional()
        .describe(
          "Ce qui doit arriver dans le paragraphe a venir, en une phrase. Le plugin la place a l'endroit ou elle pese le plus. C'est LE levier de direction.",
        ),
      attg: z
        .string()
        .max(300)
        .optional()
        .describe("Registre global : 'Titre: X; Tags: a, b; Genre: fantasy'. Place tout en haut."),
      opening: z
        .string()
        .max(500)
        .optional()
        .describe(
          "Fragment d'amorce ajoute en dernier, coupe en plein milieu d'une phrase — par exemple « Elle leva les yeux vers le messager et ». Un contexte qui finit sur un point invite le modele a changer de sujet.",
        ),
      // --- mode « brut » : tu assembles toi-meme ---------------------------
      prompt: z
        .string()
        .min(1)
        .max(20000)
        .optional()
        .describe(
          "Contexte deja assemble, envoye tel quel. S'utilise SEUL, jamais avec story/memory/authors_note/attg/opening.",
        ),
      max_length: z.number().int().min(1).max(300).optional().describe('Tokens a generer. Defaut 150.'),
      min_length: z.number().int().min(1).max(300).optional().describe('Doit rester <= max_length.'),
      temperature: z
        .number()
        .min(0.1)
        .max(3)
        .optional()
        .describe('Defaut 1.0. Plus haut = plus creatif et plus instable.'),
      top_p: z.number().min(0).max(1).optional(),
      top_k: z.number().int().min(0).optional(),
      repetition_penalty: z.number().min(1).max(3).optional(),
      stop_sequences: z
        .array(z.string().min(1))
        .max(8)
        .optional()
        .describe('Chaines qui coupent la generation des leur apparition.'),
      // A FREE STRING, deliberately not an enum. NovelAI ships models on a
      // schedule this repo does not control, and a closed list silently rejected
      // every one of them (`xialong-v1` was invisible for exactly that reason).
      // An unknown id now routes to the OpenAI-compatible surface, self-corrects
      // if that was the wrong guess, and otherwise surfaces NovelAI's own 400.
      model: z
        .string()
        .max(64)
        .optional()
        .describe(
          "Identifiant NovelAI. Prose classique : llama-3-erato-v1, kayra-v1, clio-v1. Plus recents : xialong-v1, glm-4-6. La liste a jour est dans GET /plugin-api/novelai/status.",
        ),
    },
    // Rule 2: `ok` is the ONLY required field.
    outputSchema: {
      ok: z.boolean(),
      text: z.string().optional(),
      model: z.string().optional(),
      surface: z.string().optional(),
      tokens_requested: z.number().optional(),
      prompt_chars: z.number().optional(),
      context_trimmed: z.number().optional(),
      warnings: z.array(z.string()).optional(),
      duration_ms: z.number().optional(),
      note: z.string().optional(),
      code: z.string().optional(),
      error: z.string().optional(),
      hint: z.string().optional(),
    },
    /** @param {Record<string, unknown>} args */
    async handler(args) {
      try {
        return await handleText(rt, args || {});
      } catch (err) {
        // Rule 1: the last line of defence before the host's quarantine counter.
        rt.log.warn(
          { event: 'novelai.generate_text_error', error: String(err) },
          'novelai: handler generate_text en echec',
        );
        return { ok: false, code: 'internal', error: String(err) };
      }
    },
  };
}

/**
 * @param {import('../index.js').Runtime} rt
 * @param {Record<string, unknown>} args
 * @returns {Promise<object>}
 */
async function handleText(rt, args) {
  const startedAt = Date.now();
  if (!rt.cfg.apiToken) return notConfigured();
  if (!rt.client) return noClient();

  // The model decides the surface AND the context window, so it is resolved
  // before the prompt is assembled.
  const model = optStr(args.model) ?? rt.cfg.textModel;
  const assembled = assemblePrompt(args, model);
  if ('error' in assembled) return assembled;

  const maxLength = optInt(args.max_length) ?? rt.cfg.defaultMaxLength;
  const minLength = optInt(args.min_length);
  // A ZodRawShape cannot express a CROSS-field constraint, so the check lives
  // here — otherwise NovelAI answers 400 and the agent has to guess why.
  if (minLength !== undefined && minLength > maxLength) {
    return {
      ok: false,
      code: 'bad_request',
      error: `min_length (${minLength}) doit rester <= max_length (${maxLength})`,
      hint: "baisse min_length ou monte max_length ; max_length vaut par defaut la valeur de la configuration du plugin",
    };
  }

  /** @type {Record<string, unknown>} */
  const parameters = {
    max_length: maxLength,
    min_length: minLength ?? 1,
    temperature: optNum(args.temperature) ?? rt.cfg.defaultTemperature,
  };
  const topP = optNum(args.top_p);
  if (topP !== undefined) parameters.top_p = topP;
  const topK = optInt(args.top_k);
  if (topK !== undefined) parameters.top_k = topK;
  const repetitionPenalty = optNum(args.repetition_penalty);
  if (repetitionPenalty !== undefined) parameters.repetition_penalty = repetitionPenalty;
  const stopSequences = optStrArray(args.stop_sequences);
  if (stopSequences !== undefined) parameters.stop_sequences = stopSequences;

  const res = await rt.client.generateText({ input: assembled.prompt, model, parameters });
  const durationMs = Date.now() - startedAt;

  if (!res || res.ok !== true) {
    const failure = relayFailure(res, 'appel NovelAI en echec sans detail');
    recordLastError(rt, 'generate_text', failure);
    return { ...failure, duration_ms: durationMs };
  }

  const text = typeof res.text === 'string' ? res.text : '';
  /** @type {Record<string, unknown>} */
  const out = {
    ok: true,
    text,
    model,
    tokens_requested: maxLength,
    prompt_chars: assembled.prompt.length,
    duration_ms: durationMs,
  };
  // Reported only when the client actually switched — the field is the trace of
  // a stale routing table, which is precisely what one wants to see in a log.
  if (typeof res.surface === 'string') out.surface = res.surface;
  if (assembled.cut > 0) out.context_trimmed = assembled.cut;
  if (assembled.warnings.length > 0) out.warnings = assembled.warnings;
  if (text.trim() === '') {
    // A RESULT, not an error: NovelAI answered 200 with an empty string. The
    // agent would otherwise read `text: ""` and conclude the tool is broken.
    out.note =
      'Generation vide : NovelAI a repondu sans produire de texte. Causes habituelles : parametres trop restrictifs ' +
      "(max_length tres bas, temperature tres basse) ou une stop_sequence declenchee des le premier token. " +
      'Reessaie avec un max_length plus grand ou sans stop_sequences.';
  }
  return out;
}

/**
 * Resolve the two mutually exclusive input modes into ONE prompt string.
 *
 * `prompt` is the escape hatch for an agent that wants full control; the
 * structured fields are the paved road, where the plugin owns the placement
 * rules that are easy to get wrong (see lib/story.js). Mixing them is REFUSED
 * rather than silently arbitrated: whichever one we chose to honour, the agent
 * would spend the next three calls wondering why half its input vanished.
 *
 * @param {Record<string, unknown>} args
 * @param {string} model decides the context window
 * @returns {{prompt:string, cut:number, warnings:string[]}|{ok:false, code:string, error:string, hint:string}}
 */
function assemblePrompt(args, model) {
  const raw = optStr(args.prompt);
  const story = optStr(args.story);
  const memory = optStr(args.memory);
  const authorsNote = optStr(args.authors_note);
  const attg = optStr(args.attg);
  const opening = optStr(args.opening);
  const structured = story || memory || authorsNote || attg || opening;

  if (raw && structured) {
    return {
      ok: false,
      code: 'bad_request',
      error: 'prompt et story/memory/authors_note/attg/opening sont exclusifs',
      hint: "utilise soit `prompt` seul (tu assembles), soit les champs structures (le plugin assemble)",
    };
  }
  if (raw) return { prompt: raw, cut: 0, warnings: [] };
  if (!structured) {
    return {
      ok: false,
      code: 'bad_request',
      error: 'aucune entree : il faut au moins story, authors_note ou prompt',
      hint: "pour ecrire une histoire, passe `story` (le texte deja ecrit) et `authors_note` (ce qui doit arriver) ; appelle novelai.writing_guide pour la methode complete",
    };
  }
  return buildStoryPrompt({
    story,
    memory,
    authorsNote,
    attg,
    opening,
    windowChars: contextCharsFor(model),
  });
}

// ---------------------------------------------------------------------------
// 2. novelai.generate_voice
// ---------------------------------------------------------------------------

const VOICE_DESCRIPTION =
  'Synthetise du texte en audio avec les voix NovelAI et **ecrit le fichier dans le workspace**. ' +
  '`files[].path` est resolu dans **ton** espace de noms : tu peux faire `Read`/`ls` dessus directement. ' +
  'Pour passer le fichier a un autre outil ou plugin, utilise `files[].workspace_relative`, qui est la forme portable. ' +
  'Ne consomme aucun Anlas. NovelAI plafonne a ~1000 caracteres par appel : au-dela, le texte est decoupe sur ' +
  'les frontieres de phrases et **plusieurs fichiers ordonnes** sont retournes ' +
  "(aucun reencodage — l'image ne contient pas de ffmpeg).";

/**
 * @param {import('../index.js').Runtime} rt
 * @returns {import('@swarm-os/plugin-sdk').PluginToolDef}
 */
export function buildVoiceToolDef(rt) {
  const z = rt.api.zod;
  return {
    name: 'generate_voice',
    title: 'Synthetiser de la voix (NovelAI TTS)',
    description: VOICE_DESCRIPTION,
    inputSchema: {
      text: z
        .string()
        .min(1)
        .max(20000)
        .describe(
          'Texte a synthetiser. Au-dela de 1000 caracteres il est decoupe en plusieurs fichiers (limite dure de NovelAI).',
        ),
      voice: z
        .string()
        .max(40)
        .optional()
        .describe(
          'Voix NovelAI. Feminines : Ligeia, Aini, Orea, Claea, Lim, Aurae, Naia. Masculines : Aulon, Elei, Ogma, Raid, Pega, Lam. Defaut : config.',
        ),
      // NOT named `seed`: the HTTP query parameter called `seed` carries the
      // voice NAME in TTS v2. Exposing `seed: number` would contradict the wire.
      seed_mix: z.number().optional().describe('Melange de voix. Laisser vide pour la voix telle quelle.'),
      format: z
        .enum(['opus', 'mp3'])
        .optional()
        .describe(
          "Defaut : config. 'opus' produit un OGG/Opus envoyable tel quel comme message vocal Discord.",
        ),
      filename_hint: z
        .string()
        .max(40)
        .optional()
        .describe('Slug utilise dans le nom de fichier (sinon derive du texte).'),
    },
    // Rule 2: `ok` is the ONLY required field — `files` is present on the
    // PARTIAL-FAILURE path too, so it must stay optional either way.
    outputSchema: {
      ok: z.boolean(),
      files: z
        .array(
          z.object({
            path: z.string(),
            workspace_relative: z.string(),
            container_path: z.string(),
            bytes: z.number(),
            chars: z.number(),
          }),
        )
        .optional(),
      voice: z.string().optional(),
      format: z.string().optional(),
      chunks: z.number().optional(),
      truncated: z.boolean().optional(),
      duration_ms: z.number().optional(),
      note: z.string().optional(),
      code: z.string().optional(),
      error: z.string().optional(),
      hint: z.string().optional(),
    },
    /** @param {Record<string, unknown>} args */
    async handler(args) {
      try {
        return await handleVoice(rt, args || {});
      } catch (err) {
        rt.log.warn(
          { event: 'novelai.generate_voice_error', error: String(err) },
          'novelai: handler generate_voice en echec',
        );
        return { ok: false, code: 'internal', error: String(err) };
      }
    },
  };
}

/**
 * @param {import('../index.js').Runtime} rt
 * @param {Record<string, unknown>} args
 * @returns {Promise<object>}
 */
async function handleVoice(rt, args) {
  const startedAt = Date.now();
  if (!rt.cfg.apiToken) return notConfigured();
  if (!rt.client) return noClient();

  const text = typeof args.text === 'string' ? args.text : '';
  const chunks = chunkForTts(text);
  if (chunks.length === 0) {
    return { ok: false, code: 'bad_request', error: 'text manquant ou vide' };
  }

  // Truncation detection. `chunkForTts` silently drops everything past the 12th
  // piece; the agent must be told rather than left believing its whole text was
  // spoken. A non-truncated run always ends on the tail of the source.
  const normalised = text.replace(/\r\n/g, '\n').trimEnd();
  const truncated = chunks.length >= MAX_TTS_CHUNKS && !normalised.endsWith(chunks[chunks.length - 1]);

  const voice = optStr(args.voice) ?? rt.cfg.defaultVoice;
  const format = args.format === 'mp3' || args.format === 'opus' ? args.format : rt.cfg.ttsFormat;
  const seedMix = optNum(args.seed_mix);
  const slugSource = optStr(args.filename_hint) ?? text.slice(0, SLUG_SOURCE_MAX);

  // Containment: the ONLY non-constant write path of the plugin, and its value
  // comes from the operator's config, never from the agent.
  let outRoot;
  try {
    outRoot = resolveOutputDir(rt.cfg.outputDir);
  } catch (err) {
    const failure = {
      ok: false,
      code: 'not_configured',
      error: `configuration invalide : ${err instanceof Error ? err.message : String(err)}`,
      hint: "demande a l'operateur de corriger outputDir dans la configuration du plugin novelai",
    };
    recordLastError(rt, 'generate_voice', failure);
    return failure;
  }

  const now = new Date();
  const dayDir = path.join(outRoot, dateDir(now));
  try {
    // Once per level: the root carries the `.gitignore` that keeps generated
    // audio out of the bind-mounted Git repository, the day directory is where
    // the files land (files.js documents both calls as safe).
    await ensureOutputDir(outRoot);
    await ensureOutputDir(dayDir);
  } catch (err) {
    const failure = {
      ok: false,
      code: 'internal',
      error: `impossible de creer le dossier de sortie : ${err instanceof Error ? err.message : String(err)}`,
      hint: `verifie les droits d'ecriture sur ${dayDir}`,
    };
    recordLastError(rt, 'generate_voice', failure);
    return failure;
  }

  const wsRoot = workspaceRoot();
  /** @type {Array<{path:string, workspace_relative:string, container_path:string, bytes:number, chars:number}>} */
  const files = [];

  // SERIALLY. The client queues internally anyway, but firing twelve promises at
  // once would just fill that queue with our own calls and make every other
  // agent see `busy`.
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const res = await rt.client.generateVoice({ text: chunk, voice, seedMix, opus: format !== 'mp3' });

    if (!res || res.ok !== true) {
      const failure = relayFailure(res, 'appel TTS NovelAI en echec sans detail');
      recordLastError(rt, 'generate_voice', failure);
      sweepBestEffort(rt, outRoot);
      // PARTIAL FAILURE: the files already written are real and usable. Losing
      // them (or hiding them) would force the agent to redo work it paid for.
      return withPartial(failure, files, chunks.length, i, voice, format, truncated, Date.now() - startedAt);
    }

    let written;
    try {
      const name = buildFileName({
        now: new Date(),
        slug: slugSource,
        index: i,
        ext: extFromContentType(res.contentType),
      });
      // Normalise to a Buffer FIRST. `writeAudio` reports `data.byteLength`, and
      // anything else (a string, say) writes a perfectly good file while
      // reporting `bytes: undefined` — which fails the outputSchema and turns a
      // successful generation into an opaque McpError. Rule 2, in the wild.
      const payload = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data);
      written = await writeAudio({ absDir: dayDir, name, data: payload });
    } catch (err) {
      const failure = {
        ok: false,
        code: 'internal',
        error: `ecriture du fichier audio impossible : ${err instanceof Error ? err.message : String(err)}`,
        hint: `verifie les droits d'ecriture et l'espace disque sur ${dayDir}`,
      };
      recordLastError(rt, 'generate_voice', failure);
      sweepBestEffort(rt, outRoot);
      return withPartial(failure, files, chunks.length, i, voice, format, truncated, Date.now() - startedAt);
    }

    files.push({
      // The agent's namespace — this is the one Read/ls understand.
      path: toAgentPath(written.path),
      workspace_relative: path.relative(wsRoot, written.path),
      container_path: written.path,
      bytes: written.bytes,
      chars: chunk.length,
    });
  }

  sweepBestEffort(rt, outRoot);

  /** @type {Record<string, unknown>} */
  const out = {
    ok: true,
    files,
    voice,
    format,
    chunks: files.length,
    duration_ms: Date.now() - startedAt,
  };
  if (truncated) {
    out.truncated = true;
    out.note = `Texte tronque : seuls les ${MAX_TTS_CHUNKS} premiers morceaux ont ete synthetises (plafond du plugin). Relance un appel avec la suite du texte.`;
  }
  return out;
}

/**
 * Decorate a failure with the work already done. `files` may be empty — the
 * shape stays the same so the agent never has to branch on its presence.
 *
 * @param {{ok:false, code:string, error:string, hint?:string}} failure
 * @param {Array<object>} files
 * @param {number} total
 * @param {number} failedIndex zero-based
 * @param {string} voice
 * @param {string} format
 * @param {boolean} truncated
 * @param {number} durationMs
 * @returns {Record<string, unknown>}
 */
function withPartial(failure, files, total, failedIndex, voice, format, truncated, durationMs) {
  /** @type {Record<string, unknown>} */
  const out = { ...failure, files, voice, format, chunks: total, duration_ms: durationMs };
  if (truncated) out.truncated = true;
  if (files.length > 0) {
    out.note =
      `Echec au morceau ${failedIndex + 1}/${total} : les ${files.length} fichier(s) deja ecrits sont conserves ` +
      'et listes dans files[]. Ne resynthetise que la suite manquante.';
    if (!out.hint) out.hint = 'reprends la synthese a partir du morceau suivant';
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. novelai.writing_guide — the method, paid for only when it is asked for
// ---------------------------------------------------------------------------
//
// The layering that governs where documentation goes, cheapest first:
//   `title`               1 line, in EVERY session's preamble
//   tool `description`    ~8 lines, in EVERY session's context
//   THIS TOOL             ~0 permanent, the full method on demand
//   agent-assets GUIDE.md 0 context at all, a file on disk
//   error `hint`s         0 until something fails, and perfectly timed
//
// Same text behind the last three: `agent-assets/GUIDE.md` is the single source,
// read once at activation. Two copies of a method drift, and the copy the agent
// reads is never the one you remembered to update.

/**
 * @param {import('../index.js').Runtime} rt
 * @returns {import('@swarm-os/plugin-sdk').PluginToolDef}
 */
export function buildGuideToolDef(rt) {
  const z = rt.api.zod;
  return {
    name: 'writing_guide',
    title: "Methode d'ecriture NovelAI (a lire avant la premiere histoire)",
    description:
      'Retourne la marche a suivre pour ecrire une histoire complete avec novelai.generate_text : ' +
      "les etapes, l'ordre du contexte, et les quatre erreurs qui font derailler un texte long. " +
      'Aucun appel reseau, aucun cout, aucun Anlas.',
    inputSchema: {},
    outputSchema: {
      ok: z.boolean(),
      guide: z.string().optional(),
      source: z.string().optional(),
      code: z.string().optional(),
      error: z.string().optional(),
    },
    async handler() {
      try {
        return {
          ok: true,
          guide: rt.guide,
          // The same text as a file the agent can read, diff or copy. Absolute
          // and transport-correct, so it resolves from the agent's namespace.
          ...(rt.guidePath ? { source: rt.guidePath } : {}),
        };
      } catch (err) {
        return { ok: false, code: 'internal', error: String(err) };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 4. GET /plugin-api/novelai/status — operator diagnostic, NOT an agent tool
// ---------------------------------------------------------------------------

/**
 * @param {import('../index.js').Runtime} rt
 * @returns {import('@swarm-os/plugin-sdk').Router}
 */
export function buildStatusRouter(rt) {
  const router = rt.api.http.createRouter();
  router.get('/status', async (req, res) => {
    try {
      const probe = req && req.query ? String(req.query.probe ?? '') : '';
      if (probe === 'voice') {
        res.json(await probeVoice(rt));
        return;
      }
      res.json(await buildStatusPayload(rt));
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
  return router;
}

/**
 * @param {import('../index.js').Runtime} rt
 * @returns {Promise<Record<string, unknown>>}
 */
async function buildStatusPayload(rt) {
  const cfg = rt.cfg;
  const tokenSet = Boolean(cfg.apiToken);

  // Local, network-free reading of the TOKEN's own clock. `GET /user/subscription`
  // is the wrong oracle for this: it carries the SUBSCRIPTION's deadline, an
  // independent clock that answers "all good" in the exact case to catch
  // (valid yearly plan, token expired yesterday).
  const expMs = tokenSet ? jwtExpMs(cfg.apiToken) : null;
  const daysUntilExpiry = expMs === null ? null : Math.floor((expMs - Date.now()) / DAY_MS);

  // BOTH path forms: the gap between them is what makes a translation bug
  // visible without reproducing it.
  /** @type {{agent: string|null, container: string|null, configured: string, error?: string}} */
  const outputDir = { agent: null, container: null, configured: cfg.outputDir };
  try {
    const abs = resolveOutputDir(cfg.outputDir);
    outputDir.container = abs;
    outputDir.agent = toAgentPath(abs);
  } catch (err) {
    outputDir.error = err instanceof Error ? err.message : String(err);
  }

  let queue = { inflight: 0, waiting: 0 };
  try {
    if (rt.client) queue = rt.client.stats();
  } catch {
    // A broken gauge must not break the diagnostic that reads it.
  }

  // Cold call, no cache: the caller is a human asking a question NOW. A failure
  // goes INTO the field rather than failing the route — the rest of the payload
  // is exactly what is needed to understand why the call failed.
  /** @type {unknown} */
  let subscription = null;
  if (tokenSet && rt.client) {
    try {
      subscription = await rt.client.subscription();
    } catch (err) {
      subscription = { ok: false, code: 'internal', error: String(err) };
    }
  }

  // The live model list, straight from NovelAI — this is what replaced the
  // hardcoded allowlist. The legacy trio has no discovery endpoint, so it is
  // merged in here; `/oa/v1/models` supplies everything else.
  const models = { legacy: ['llama-3-erato-v1', 'kayra-v1', 'clio-v1'], openai: [], error: null };
  if (tokenSet && rt.client) {
    try {
      const listed = await rt.client.listModels();
      if (listed && listed.ok === true) models.openai = listed.models;
      else models.error = listed && listed.error ? String(listed.error) : 'liste indisponible';
    } catch (err) {
      models.error = err instanceof Error ? err.message : String(err);
    }
  }

  const hints = [];
  if (!tokenSet) {
    hints.push('Aucun token: les deux outils repondent code:not_configured. Renseigne apiToken dans la configuration du plugin.');
  }
  if (expMs !== null && expMs <= Date.now()) {
    hints.push(`Le token a EXPIRE le ${new Date(expMs).toISOString()}: regenere-le maintenant.`);
  } else if (expMs !== null && expMs - Date.now() <= EXPIRY_WARN_MS) {
    hints.push(`Le token expire dans moins de 3 jours (${new Date(expMs).toISOString()}): regenere-le des maintenant.`);
  }
  if (tokenSet && expMs === null) {
    hints.push("Le token n'est pas un JWT lisible: son expiration ne peut pas etre surveillee localement, un 401 la revelera.");
  }
  if (outputDir.error) {
    hints.push(`outputDir invalide: ${outputDir.error}`);
  }
  if (models.openai.length > 0 && !models.legacy.includes(cfg.textModel) && !models.openai.includes(cfg.textModel)) {
    hints.push(
      `Le modele configure (${cfg.textModel}) n'apparait dans aucune des deux listes: verifie son identifiant, ` +
        `NovelAI repondra 400. Disponibles: ${[...models.legacy, ...models.openai].join(', ')}.`,
    );
  }
  hints.push('Cree un token persistant dans NovelAI -> Account -> Get Persistent API Token.');
  hints.push('Les tokens persistants NovelAI expirent apres 30 jours: prevois une rotation.');
  hints.push("Apres un enable ou un changement de configuration, redemarre ou reprends la session du lead pour voir les nouveaux outils (une session deja lancee a mis en cache sa liste d'outils MCP).");
  hints.push("Sonde differentielle de voix: ajoute ?probe=voice a cette URL pour verifier que l'API respecte bien la voix demandee.");

  return {
    ok: true,
    plugin: 'novelai',
    // A BOOLEAN and a date — never the token itself, on any code path.
    token_set: tokenSet,
    token_expires_at: expMs === null ? null : new Date(expMs).toISOString(),
    days_until_expiry: daysUntilExpiry,
    text_model: cfg.textModel,
    // Which of the two NovelAI APIs the configured model is routed to. An
    // operator debugging a 403 needs this before anything else.
    text_surface: surfaceFor(cfg.textModel),
    models,
    default_voice: cfg.defaultVoice,
    tts_format: cfg.ttsFormat,
    output_dir: outputDir,
    retention_days: cfg.retentionDays,
    request_timeout_sec: cfg.requestTimeoutSec,
    queue,
    last_error: safeJson(rt.kv.get(LAST_ERROR_KEY)),
    subscription,
    hints,
  };
}

/**
 * Differential voice probe — the ONLY oracle for the one failure mode nothing
 * else can see: a silently ignored voice parameter produces valid audio, in the
 * wrong voice, with HTTP 200 and no error anywhere.
 *
 * Synthesises the SAME short text with two opposite voices and compares the
 * bytes. Identical output means the parameter is ignored. Writes NO file (the
 * buffers are compared in memory) and is triggered by a human only, never on the
 * hot path.
 *
 * @param {import('../index.js').Runtime} rt
 * @returns {Promise<Record<string, unknown>>}
 */
async function probeVoice(rt) {
  if (!rt.cfg.apiToken) {
    return { ok: false, probe: 'voice', ...notConfigured() };
  }
  if (!rt.client) {
    return { ok: false, probe: 'voice', ...noClient() };
  }

  const a = await rt.client.generateVoice({ text: PROBE_TEXT, voice: PROBE_VOICE_A, opus: true });
  if (!a || a.ok !== true) {
    return { probe: 'voice', voices: [PROBE_VOICE_A, PROBE_VOICE_B], ...relayFailure(a, `synthese ${PROBE_VOICE_A} en echec`) };
  }
  const b = await rt.client.generateVoice({ text: PROBE_TEXT, voice: PROBE_VOICE_B, opus: true });
  if (!b || b.ok !== true) {
    return { probe: 'voice', voices: [PROBE_VOICE_A, PROBE_VOICE_B], ...relayFailure(b, `synthese ${PROBE_VOICE_B} en echec`) };
  }

  const bufA = Buffer.isBuffer(a.data) ? a.data : Buffer.from(a.data || []);
  const bufB = Buffer.isBuffer(b.data) ? b.data : Buffer.from(b.data || []);
  const identical = bufA.length === bufB.length && Buffer.compare(bufA, bufB) === 0;

  return {
    ok: true,
    probe: 'voice',
    identical,
    voices: [PROBE_VOICE_A, PROBE_VOICE_B],
    sizes: [bufA.length, bufB.length],
    verdict: identical
      ? `Octets IDENTIQUES pour ${PROBE_VOICE_A} et ${PROBE_VOICE_B} : le parametre de voix est IGNORE par l'API NovelAI. L'audio produit reste valide mais la voix demandee n'est pas respectee — voir la section "Sonde de voix" du README.`
      : `Octets differents pour ${PROBE_VOICE_A} et ${PROBE_VOICE_B} : le parametre de voix est bien pris en compte par l'API NovelAI.`,
  };
}

/** @param {string|null} s @returns {unknown} */
function safeJson(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

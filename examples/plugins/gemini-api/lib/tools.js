// tools.js — the plugin's entire public surface: the MCP tools every agent of
// the swarm sees, and the operator-facing `GET /plugin-api/gemini-api/status`.
//
// THREE NON-NEGOTIABLE RULES FOR AN MCP HANDLER — each one is load-bearing:
//
//  1. A HANDLER NEVER THROWS. Every exit is a value. A throw reaches the host's
//     guard() and counts toward plugin quarantine (5 crashes / 60 s -> backoff up
//     to 1 h; packages/server/src/modules/plugins/host.ts:61-62 and :1066-1070),
//     so one malformed argument from one worker could silence the plugin for the
//     whole swarm. `lib/gemini.js` upholds the same contract, which is why its
//     `{ok:false}` results are RELAYED VERBATIM here — rewriting a `code` or a
//     `hint` would only blur the diagnosis.
//  2. IN `outputSchema`, ONLY `ok` IS REQUIRED. The MCP SDK runs a
//     `safeParseAsync` over `structuredContent` and throws an `McpError` on any
//     mismatch, so a field that is absent on the error path must be `.optional()`
//     or the agent gets an opaque MCP failure instead of a readable `{ok:false}`.
//  3. NO `leadOnly`. `requireLead` throws an McpError (mcp-registry.ts:140), and
//     none of these tools has a reason to be reserved: a worker captioning a
//     screenshot or synthesising a voice line is the normal case.
//
// SCHEMAS ARE STRINGS WHERE GOOGLE MOVES AND ENUMS WHERE IT DOES NOT. Model ids
// (`model`) and voice names are FREE STRINGS: Google renames models every few
// months, and novelai learned the expensive version of this lesson — an
// allowlist did not merely hide a new model, it silently REWROTE the operator's
// value back to the default, so a valid new model produced the old one with no
// error at all. Aspect ratios and image sizes ARE enums: that set is stable, and
// the API rejects a lowercase `2k`, which an enum prevents an agent from typing.
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

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  buildFileName,
  dateDir,
  ensureOutputDir,
  extFromMime,
  sweep,
  toPlayableAudio,
  writeMedia,
} from './files.js';
import { blockedReason, extractMedia, extractText, extractUsage, VIDEO_MAX_BYTES } from './gemini.js';
import { buildInput } from './media.js';
import { refreshModelEnums, REFRESH_SUMMARY_KEY } from './model-lists.js';
import { getJob, listJobs, newJobId, saveJob } from './jobs.js';
import { resolveOutputDir, toAgentPath, toContainerPath, workspaceRoot } from './paths.js';

/** KV key holding the last failure surfaced to an agent (JSON, best-effort). */
const LAST_ERROR_KEY = 'last_error';

/** Longest slice of a prompt used to build a file name. */
const SLUG_SOURCE_MAX = 60;

/** The 30 documented TTS voices. Descriptive only — `voice` is a free string. */
const VOICES =
  'Zephyr, Puck, Charon, Kore, Fenrir, Leda, Orus, Aoede, Callirrhoe, Autonoe, Enceladus, Iapetus, ' +
  'Umbriel, Algieba, Despina, Erinome, Algenib, Rasalgethi, Laomedeia, Achernar, Alnilam, Schedar, ' +
  'Gacrux, Pulcherrima, Achird, Zubenelgenubi, Vindemiatrix, Sadachbia, Sadaltager, Sulafat';

/** Aspect ratios the image models accept. Stable set — safe to close. */
const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

/** Image sizes. The API rejects a lowercase `k`, hence an enum and not a string. */
const IMAGE_SIZES = ['512px', '1K', '2K', '4K'];

/** A first frame handed to Veo must be inlined; keep it sane. */
const MAX_FRAME_BYTES = 6 * 1024 * 1024;

/** Bounds on how long `generate_video` may block before handing back a job id. */
const VIDEO_WAIT_MAX_SEC = 240;
/** Interval between two polls while blocking inside `generate_video`. */
const VIDEO_POLL_MS = 10_000;

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

/** @param {unknown} v @returns {boolean|undefined} */
function optBool(v) {
  return typeof v === 'boolean' ? v : undefined;
}

/** @param {unknown} v @returns {string[]} */
function strArray(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((s) => typeof s === 'string' && s.trim() !== '').map((s) => s.trim());
}

/** @param {number} n @param {number} lo @param {number} hi @returns {number} */
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Relay a client failure WITHOUT rewriting it. `lib/gemini.js` already mapped
 * the upstream status to a stable `code` and wrote a hint aimed at whoever can
 * act; a second interpretation here would only lose information.
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

/** The plugin has no usable key. Same wording for every tool. */
function notConfigured() {
  return {
    ok: false,
    code: 'not_configured',
    error: "cle d'API Gemini absente : le plugin gemini-api est installe mais pas configure",
    hint: "demande a l'operateur de renseigner apiKey dans la configuration du plugin gemini-api",
  };
}

/** The runtime has no client (called between deactivate and activate). */
function noClient() {
  return {
    ok: false,
    code: 'internal',
    error: 'client Gemini indisponible (plugin en cours de rechargement)',
    hint: 'reessaie dans quelques secondes',
  };
}

/**
 * A 200 that carried nothing usable. Distinguishes a SAFETY BLOCK — which the
 * agent can act on by rewriting its prompt — from an empty answer, which it
 * cannot. Guessing "blocked" for every empty response would send agents editing
 * innocent prompts forever, so `blockedReason` only reports what the body
 * actually says.
 *
 * @param {any} json
 * @param {string} what human name of the expected payload
 * @returns {{ok:false, code:string, error:string, hint?:string}}
 */
function noOutput(json, what) {
  const reason = blockedReason(json);
  if (reason) {
    return {
      ok: false,
      code: 'blocked',
      error: `Gemini a bloque la generation (${reason})`,
      hint: 'reformule la demande : le filtre de securite de Google a refuse le prompt ou le resultat',
    };
  }
  return {
    ok: false,
    code: 'no_output',
    error: `Gemini a repondu sans ${what}`,
    hint: 'reessaie, eventuellement avec un autre modele ; verifie que le modele choisi sait produire ce media',
  };
}

/**
 * Remember the last failure for the operator's /status route. Best-effort by
 * construction: `rt.kv` already swallows a missing `db-kv` grant, and a failure
 * to record a failure must never become one.
 *
 * @param {import('../index.js').Runtime} rt
 * @param {string} tool
 * @param {{code:string, error:string}} failure
 */
function recordLastError(rt, tool, failure) {
  try {
    rt.kv.set(
      LAST_ERROR_KEY,
      JSON.stringify({
        at: new Date().toISOString(),
        tool,
        code: failure.code,
        error: String(failure.error || '').slice(0, 300),
      }),
    );
  } catch {
    // Diagnostics are never worth failing a tool call for.
  }
}

/**
 * Fire the retention sweep without ever awaiting it — it is a housekeeping pass,
 * not part of the agent's request.
 *
 * @param {import('../index.js').Runtime} rt
 * @param {string} absDir
 */
function sweepBestEffort(rt, absDir) {
  void sweep({ absDir, retentionDays: rt.cfg.retentionDays, kv: rt.kv, log: rt.log }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Output directory plumbing — shared by every media-writing tool
// ---------------------------------------------------------------------------

/**
 * Resolve + create `<outputDir>/<YYYY-MM-DD>`.
 *
 * @param {import('../index.js').Runtime} rt
 * @param {string} tool for the error record
 * @returns {Promise<{ok:true, outRoot:string, dayDir:string}|{ok:false, code:string, error:string, hint?:string}>}
 */
async function prepareDir(rt, tool) {
  let outRoot;
  try {
    outRoot = resolveOutputDir(rt.cfg.outputDir);
  } catch (err) {
    const failure = {
      ok: false,
      code: 'not_configured',
      error: `configuration invalide : ${err instanceof Error ? err.message : String(err)}`,
      hint: "demande a l'operateur de corriger outputDir dans la configuration du plugin gemini-api",
    };
    recordLastError(rt, tool, failure);
    return failure;
  }
  const dayDir = path.join(outRoot, dateDir(new Date()));
  try {
    // Once per level: the root carries the `.gitignore` that keeps generated
    // media out of the bind-mounted Git repository, the day directory is where
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
    recordLastError(rt, tool, failure);
    return failure;
  }
  return { ok: true, outRoot, dayDir };
}

/**
 * The three names of one written file, plus its size and type.
 *
 * @param {string} absPath container path
 * @param {number} bytes
 * @param {string} mime
 * @returns {{path:string, workspace_relative:string, container_path:string, bytes:number, mime:string}}
 */
function describeFile(absPath, bytes, mime) {
  return {
    // The agent's namespace — this is the one Read/ls understand.
    path: toAgentPath(absPath),
    workspace_relative: path.relative(workspaceRoot(), absPath),
    container_path: absPath,
    bytes,
    mime: mime || '',
  };
}

/**
 * Write every generated payload of one call into the day directory.
 *
 * @param {import('../index.js').Runtime} rt
 * @param {{tool:string, slug:string, items:Array<{data:Buffer, mime:string, ext?:string}>}} args
 * @returns {Promise<{ok:true, files:object[], outRoot:string}|{ok:false, code:string, error:string, hint?:string}>}
 */
async function writeAll(rt, args) {
  const { tool, slug, items } = args;
  const dirs = await prepareDir(rt, tool);
  if (!dirs || dirs.ok !== true) return dirs;

  /** @type {object[]} */
  const files = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    try {
      const name = buildFileName({
        now: new Date(),
        slug,
        index: i,
        ext: item.ext || extFromMime(item.mime),
      });
      const written = await writeMedia({ absDir: dirs.dayDir, name, data: item.data });
      files.push(describeFile(written.path, written.bytes, item.mime));
    } catch (err) {
      const failure = {
        ok: false,
        code: 'internal',
        error: `ecriture du fichier impossible : ${err instanceof Error ? err.message : String(err)}`,
        hint: `verifie les droits d'ecriture et l'espace disque sur ${dirs.dayDir}`,
      };
      recordLastError(rt, tool, failure);
      // PARTIAL FAILURE: the files already written are real and usable. Losing
      // them (or hiding them) would force the agent to redo work it paid for.
      return files.length > 0 ? { ...failure, files } : failure;
    }
  }
  sweepBestEffort(rt, dirs.outRoot);
  return { ok: true, files, outRoot: dirs.outRoot };
}

/**
 * Wrap a handler so rule 1 holds even if the handler itself has a bug.
 *
 * @param {import('../index.js').Runtime} rt
 * @param {string} tool
 * @param {(args: Record<string, unknown>) => Promise<object>} fn
 */
function guarded(rt, tool, fn) {
  return async (
    /** @type {Record<string, unknown>} */ args,
    /** @type {import('@swarm-os/plugin-sdk').PluginToolContext} */ ctx,
  ) => {
    try {
      return await fn(args || {}, ctx);
    } catch (err) {
      rt.log.warn({ event: `gemini.${tool}_error`, error: String(err) }, `gemini-api: handler ${tool} en echec`);
      return { ok: false, code: 'internal', error: String(err) };
    }
  };
}

/**
 * The generation knobs shared by the text-shaped tools.
 *
 * @param {Record<string, unknown>} args
 * @returns {Record<string, unknown>}
 */
function generationConfig(args) {
  /** @type {Record<string, unknown>} */
  const cfg = {};
  const temperature = optNum(args.temperature);
  if (temperature !== undefined) cfg.temperature = clamp(temperature, 0, 2);
  const maxTokens = optInt(args.max_output_tokens);
  if (maxTokens !== undefined) cfg.max_output_tokens = clamp(maxTokens, 1, 65536);
  const thinking = optStr(args.thinking_level);
  if (thinking !== undefined) cfg.thinking_level = thinking;
  return cfg;
}

/** `[{type:'google_search'}]` when the agent asked for grounding, else undefined. */
function toolsFor(args) {
  return optBool(args.google_search) === true ? [{ type: 'google_search' }] : undefined;
}

// ---------------------------------------------------------------------------
// 1. gemini-api.generate_text
// ---------------------------------------------------------------------------

const TEXT_DESCRIPTION =
  "Genere du texte avec un modele Gemini et le retourne dans la reponse (aucun fichier ecrit). " +
  "Utile quand tu veux un SECOND AVIS d'un autre modele, une recherche web fraiche (google_search), " +
  'ou du JSON strictement conforme a un schema (json_schema). ' +
  "Ce n'est PAS le bon outil pour analyser une image ou un fichier : utilise gemini-api.analyze_media.";

/**
 * @param {import('../index.js').Runtime} rt
 * @returns {import('@swarm-os/plugin-sdk').PluginToolDef}
 */
export function buildTextToolDef(rt) {
  const z = rt.api.zod;
  return {
    name: 'generate_text',
    title: 'Generer du texte (Gemini)',
    description: TEXT_DESCRIPTION,
    inputSchema: {
      prompt: z.string().min(1).max(200000).describe('La demande adressee au modele.'),
      system_instruction: z
        .string()
        .max(20000)
        .optional()
        .describe("Consigne de role/format appliquee a toute la reponse (equivalent d'un system prompt)."),
      model: z
        .string()
        .max(80)
        .optional()
        .describe('Identifiant du modele. Defaut : celui de la configuration du plugin. Ex : gemini-3.7-flash.'),
      temperature: z.number().optional().describe('0 = deterministe, 2 = tres creatif. Defaut : celui du modele.'),
      max_output_tokens: z.number().optional().describe('Plafond de tokens generes.'),
      thinking_level: z
        .string()
        .max(20)
        .optional()
        .describe("Effort de raisonnement : low | medium | high. Plus haut = plus lent et plus cher."),
      google_search: z
        .boolean()
        .optional()
        .describe('true = le modele peut interroger Google Search et cite ses sources. Utile pour tout fait recent.'),
      json_schema: z
        .string()
        .max(20000)
        .optional()
        .describe(
          "Schema JSON (encode en chaine) que la reponse doit respecter. Quand il est fourni, `text` contient du JSON valide et rien d'autre.",
        ),
    },
    outputSchema: {
      ok: z.boolean(),
      text: z.string().optional(),
      model: z.string().optional(),
      usage: z
        .object({ input: z.number(), output: z.number(), total: z.number(), thoughts: z.number() })
        .optional(),
      duration_ms: z.number().optional(),
      code: z.string().optional(),
      error: z.string().optional(),
      hint: z.string().optional(),
    },
    handler: guarded(rt, 'generate_text', (args) => handleText(rt, args)),
  };
}

/**
 * @param {import('../index.js').Runtime} rt
 * @param {Record<string, unknown>} args
 */
async function handleText(rt, args) {
  const startedAt = Date.now();
  if (!rt.cfg.apiKey) return notConfigured();
  if (!rt.client) return noClient();

  const prompt = optStr(args.prompt);
  if (!prompt) return { ok: false, code: 'bad_request', error: 'prompt manquant ou vide' };
  const model = optStr(args.model) ?? rt.cfg.textModel;

  /** @type {unknown} */
  let responseFormat;
  const rawSchema = optStr(args.json_schema);
  if (rawSchema) {
    let schema;
    try {
      schema = JSON.parse(rawSchema);
    } catch (err) {
      // Reported HERE rather than relayed as Google's 400: the agent wrote this
      // string, and a JSON parse error names the exact character it got wrong.
      return {
        ok: false,
        code: 'bad_request',
        error: `json_schema n'est pas du JSON valide : ${err instanceof Error ? err.message : String(err)}`,
        hint: 'passe le schema encode en chaine, par exemple {"type":"object","properties":{...}}',
      };
    }
    responseFormat = { type: 'text', mime_type: 'application/json', schema };
  }

  const res = await rt.client.interact({
    model,
    input: prompt,
    systemInstruction: optStr(args.system_instruction),
    responseFormat,
    generationConfig: generationConfig(args),
    tools: toolsFor(args),
  });
  if (!res || res.ok !== true) {
    const failure = relayFailure(res, 'appel Gemini en echec sans detail');
    recordLastError(rt, 'generate_text', failure);
    return failure;
  }

  const text = extractText(res.json);
  if (!text) {
    const failure = noOutput(res.json, 'texte');
    recordLastError(rt, 'generate_text', failure);
    return failure;
  }

  const usage = extractUsage(res.json);
  /** @type {Record<string, unknown>} */
  const out = { ok: true, text, model, duration_ms: Date.now() - startedAt };
  if (usage) out.usage = usage;
  return out;
}

// ---------------------------------------------------------------------------
// 2. gemini-api.analyze_media  (vision, audio, video, PDF)
// ---------------------------------------------------------------------------

const ANALYZE_DESCRIPTION =
  'Fait ANALYSER des fichiers par Gemini et retourne sa reponse en texte : decrire une image, lire une capture ' +
  "d'ecran ou un scan, transcrire ou resumer un audio, resumer une video (y compris une URL YouTube), " +
  'extraire des donnees d\'un PDF. Passe les chemins des fichiers du workspace dans `files` ' +
  '(les chemins que te renvoient les autres outils fonctionnent tels quels) et ta question dans `question`. ' +
  "Les gros fichiers sont televerses automatiquement. C'est l'outil de VISION du plugin.";

/**
 * @param {import('../index.js').Runtime} rt
 * @returns {import('@swarm-os/plugin-sdk').PluginToolDef}
 */
export function buildAnalyzeToolDef(rt) {
  const z = rt.api.zod;
  return {
    name: 'analyze_media',
    title: 'Analyser une image / un audio / une video / un PDF (Gemini)',
    description: ANALYZE_DESCRIPTION,
    inputSchema: {
      question: z
        .string()
        .min(1)
        .max(100000)
        .describe('Ce que tu veux savoir des fichiers. Sois precis : "transcris", "liste les erreurs visibles", etc.'),
      files: z
        .array(z.string())
        .min(1)
        .max(16)
        .describe(
          'Chemins dans le workspace (relatifs ou absolus) et/ou URL http(s), y compris une URL YouTube. ' +
            'Formats : images (png/jpeg/webp/heic), audio (wav/mp3/ogg/flac/m4a), video (mp4/mov/webm), PDF, texte.',
        ),
      model: z.string().max(80).optional().describe('Identifiant du modele. Defaut : celui de la configuration.'),
      system_instruction: z.string().max(20000).optional().describe('Consigne de role/format.'),
      temperature: z.number().optional().describe('0 = deterministe, 2 = tres creatif.'),
      max_output_tokens: z.number().optional().describe('Plafond de tokens generes.'),
      thinking_level: z.string().max(20).optional().describe('low | medium | high.'),
      json_schema: z
        .string()
        .max(20000)
        .optional()
        .describe('Schema JSON (encode en chaine) impose a la reponse — ideal pour extraire des donnees structurees.'),
    },
    outputSchema: {
      ok: z.boolean(),
      text: z.string().optional(),
      model: z.string().optional(),
      files_sent: z.number().optional(),
      uploaded: z.number().optional(),
      usage: z
        .object({ input: z.number(), output: z.number(), total: z.number(), thoughts: z.number() })
        .optional(),
      duration_ms: z.number().optional(),
      code: z.string().optional(),
      error: z.string().optional(),
      hint: z.string().optional(),
    },
    handler: guarded(rt, 'analyze_media', (args) => handleAnalyze(rt, args)),
  };
}

/**
 * @param {import('../index.js').Runtime} rt
 * @param {Record<string, unknown>} args
 */
async function handleAnalyze(rt, args) {
  const startedAt = Date.now();
  if (!rt.cfg.apiKey) return notConfigured();
  if (!rt.client) return noClient();

  const question = optStr(args.question);
  if (!question) return { ok: false, code: 'bad_request', error: 'question manquante ou vide' };
  const files = strArray(args.files);
  if (files.length === 0) {
    return {
      ok: false,
      code: 'bad_request',
      error: 'files manquant',
      hint: 'pour une question sans fichier, utilise gemini-api.generate_text',
    };
  }

  const built = await buildInput({ client: rt.client, text: question, attachments: files, log: rt.log });
  if (!built || built.ok !== true) {
    const failure = relayFailure(built, 'preparation des fichiers en echec');
    recordLastError(rt, 'analyze_media', failure);
    return failure;
  }

  const model = optStr(args.model) ?? rt.cfg.textModel;

  /** @type {unknown} */
  let responseFormat;
  const rawSchema = optStr(args.json_schema);
  if (rawSchema) {
    try {
      responseFormat = { type: 'text', mime_type: 'application/json', schema: JSON.parse(rawSchema) };
    } catch (err) {
      return {
        ok: false,
        code: 'bad_request',
        error: `json_schema n'est pas du JSON valide : ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const res = await rt.client.interact({
    model,
    input: built.input,
    systemInstruction: optStr(args.system_instruction),
    responseFormat,
    generationConfig: generationConfig(args),
  });
  if (!res || res.ok !== true) {
    const failure = relayFailure(res, 'appel Gemini en echec sans detail');
    recordLastError(rt, 'analyze_media', failure);
    return failure;
  }

  const text = extractText(res.json);
  if (!text) {
    const failure = noOutput(res.json, 'texte');
    recordLastError(rt, 'analyze_media', failure);
    return failure;
  }

  const usage = extractUsage(res.json);
  /** @type {Record<string, unknown>} */
  const out = {
    ok: true,
    text,
    model,
    files_sent: files.length,
    uploaded: built.uploaded,
    duration_ms: Date.now() - startedAt,
  };
  if (usage) out.usage = usage;
  return out;
}

// ---------------------------------------------------------------------------
// 3. gemini-api.text_to_speech
// ---------------------------------------------------------------------------

const SPEECH_DESCRIPTION =
  'Synthetise du texte en audio avec les voix Gemini et **ecrit le fichier WAV dans le workspace**. ' +
  '`files[].path` est resolu dans **ton** espace de noms : tu peux faire `Read`/`ls` dessus directement. ' +
  'Pour passer le fichier a un autre outil ou plugin, utilise `files[].workspace_relative`. ' +
  'Plus de 100 langues, detectees automatiquement (le francais est correctement prononce). ' +
  "Le TON se pilote en langage naturel DANS le texte : \"Dis ceci d'une voix inquiete : ...\". " +
  'Pour un dialogue, passe `speakers` et prefixe chaque replique par le nom du locuteur.';

/**
 * @param {import('../index.js').Runtime} rt
 * @returns {import('@swarm-os/plugin-sdk').PluginToolDef}
 */
export function buildSpeechToolDef(rt) {
  const z = rt.api.zod;
  return {
    name: 'text_to_speech',
    title: 'Synthetiser de la voix (Gemini TTS)',
    description: SPEECH_DESCRIPTION,
    inputSchema: {
      text: z
        .string()
        .min(1)
        .max(50000)
        .describe(
          'Texte a dire. Peut commencer par une consigne de ton ("Dis joyeusement : ..."). ' +
            'Pour un dialogue : une replique par ligne, prefixee du nom du locuteur declare dans `speakers`.',
        ),
      voice: z.string().max(40).optional().describe(`Voix unique. Defaut : config. Voix disponibles : ${VOICES}.`),
      speakers: z
        .array(z.object({ name: z.string(), voice: z.string() }))
        .max(2)
        .optional()
        .describe(
          'Dialogue multi-locuteurs (2 maximum) : [{"name":"Joe","voice":"Kore"},{"name":"Jane","voice":"Puck"}]. ' +
            'Ignore `voice` quand il est present.',
        ),
      model: z.string().max(80).optional().describe('Modele TTS. Defaut : celui de la configuration.'),
      filename_hint: z.string().max(40).optional().describe('Slug utilise dans le nom de fichier (sinon derive du texte).'),
    },
    outputSchema: {
      ok: z.boolean(),
      files: z
        .array(
          z.object({
            path: z.string(),
            workspace_relative: z.string(),
            container_path: z.string(),
            bytes: z.number(),
            mime: z.string(),
          }),
        )
        .optional(),
      voice: z.string().optional(),
      model: z.string().optional(),
      wrapped_pcm: z.boolean().optional(),
      duration_ms: z.number().optional(),
      note: z.string().optional(),
      code: z.string().optional(),
      error: z.string().optional(),
      hint: z.string().optional(),
    },
    handler: guarded(rt, 'text_to_speech', (args) => handleSpeech(rt, args)),
  };
}

/**
 * @param {import('../index.js').Runtime} rt
 * @param {Record<string, unknown>} args
 */
async function handleSpeech(rt, args) {
  const startedAt = Date.now();
  if (!rt.cfg.apiKey) return notConfigured();
  if (!rt.client) return noClient();

  const text = optStr(args.text);
  if (!text) return { ok: false, code: 'bad_request', error: 'text manquant ou vide' };

  // `speech_config` is an ARRAY in both modes: one entry without `speaker` for a
  // single voice, one entry per speaker for a dialogue.
  const rawSpeakers = Array.isArray(args.speakers) ? args.speakers : [];
  /** @type {Array<{speaker?: string, voice: string}>} */
  const speechConfig = [];
  for (const s of rawSpeakers) {
    const name = optStr(/** @type {any} */ (s)?.name);
    const voice = optStr(/** @type {any} */ (s)?.voice);
    if (name && voice) speechConfig.push({ speaker: name, voice });
  }
  const singleVoice = optStr(args.voice) ?? rt.cfg.defaultVoice;
  if (speechConfig.length === 0) speechConfig.push({ voice: singleVoice });

  const model = optStr(args.model) ?? rt.cfg.ttsModel;
  const res = await rt.client.interact({
    model,
    input: text,
    responseFormat: { type: 'audio' },
    generationConfig: { speech_config: speechConfig },
  });
  if (!res || res.ok !== true) {
    const failure = relayFailure(res, 'appel TTS Gemini en echec sans detail');
    recordLastError(rt, 'text_to_speech', failure);
    return failure;
  }

  const media = extractMedia(res.json, 'audio').filter((m) => m.data);
  if (media.length === 0) {
    const failure = noOutput(res.json, 'audio');
    recordLastError(rt, 'text_to_speech', failure);
    return failure;
  }

  // THE STEP THAT MAKES THE FILE PLAYABLE. Gemini TTS returns RAW PCM with no
  // container; written as-is, every player refuses the file and nothing in the
  // response says why. `toPlayableAudio` inspects the bytes and adds a WAV
  // header only when they are not already a container.
  let wrapped = false;
  const items = media.map((m) => {
    const playable = toPlayableAudio(/** @type {Buffer} */ (m.data), m.mime);
    if (playable.wrapped) wrapped = true;
    return {
      data: playable.data,
      mime: playable.ext === '.wav' ? 'audio/wav' : m.mime || 'audio/mpeg',
      ext: playable.ext,
    };
  });

  const slug = optStr(args.filename_hint) ?? text.slice(0, SLUG_SOURCE_MAX);
  const written = await writeAll(rt, { tool: 'text_to_speech', slug, items });
  if (!written || written.ok !== true) return written;

  return {
    ok: true,
    files: written.files,
    voice: speechConfig.length === 1 && !speechConfig[0].speaker ? speechConfig[0].voice : 'multi',
    model,
    wrapped_pcm: wrapped,
    duration_ms: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// 4. gemini-api.generate_image
// ---------------------------------------------------------------------------

const IMAGE_DESCRIPTION =
  "Genere ou MODIFIE une image et **ecrit le fichier dans le workspace** (`files[].path` est directement lisible " +
  'par toi). Sans `input_images` : creation a partir du prompt. Avec `input_images` : edition — retouche, ' +
  "changement de style, fusion de plusieurs references, incrustation d'un objet. Decris le resultat VOULU, " +
  "pas la manipulation ('la meme piece en plein jour' plutot que 'augmente la luminosite'). " +
  'Le texte dans les images est bien rendu : affiches, schemas legendes, maquettes.';

/**
 * @param {import('../index.js').Runtime} rt
 * @returns {import('@swarm-os/plugin-sdk').PluginToolDef}
 */
export function buildImageToolDef(rt) {
  const z = rt.api.zod;
  return {
    name: 'generate_image',
    title: "Generer ou modifier une image (Gemini / Nano Banana)",
    description: IMAGE_DESCRIPTION,
    inputSchema: {
      prompt: z
        .string()
        .min(1)
        .max(20000)
        .describe(
          "Description du resultat voulu. Une phrase riche vaut mieux qu'une liste de mots-cles : sujet, cadrage, " +
            'lumiere, style, ambiance.',
        ),
      input_images: z
        .array(z.string())
        .max(14)
        .optional()
        .describe(
          'Chemins des images de reference a editer/fusionner (14 maximum). Vide = generation a partir de zero.',
        ),
      aspect_ratio: z.enum(ASPECT_RATIOS).optional().describe('Format de sortie. Defaut : celui du modele (1:1).'),
      image_size: z.enum(IMAGE_SIZES).optional().describe('Resolution. 4K est reserve aux modeles pro.'),
      mime_type: z.enum(['image/png', 'image/jpeg']).optional().describe('Format du fichier. Defaut : image/png.'),
      model: z.string().max(80).optional().describe('Modele image. Defaut : celui de la configuration.'),
      google_search: z
        .boolean()
        .optional()
        .describe("true = le modele peut chercher sur Google avant de dessiner (utile pour un sujet reel precis)."),
      filename_hint: z.string().max(40).optional().describe('Slug utilise dans le nom de fichier.'),
    },
    outputSchema: {
      ok: z.boolean(),
      files: z
        .array(
          z.object({
            path: z.string(),
            workspace_relative: z.string(),
            container_path: z.string(),
            bytes: z.number(),
            mime: z.string(),
          }),
        )
        .optional(),
      text: z.string().optional(),
      model: z.string().optional(),
      duration_ms: z.number().optional(),
      note: z.string().optional(),
      code: z.string().optional(),
      error: z.string().optional(),
      hint: z.string().optional(),
    },
    handler: guarded(rt, 'generate_image', (args) => handleImage(rt, args)),
  };
}

/**
 * @param {import('../index.js').Runtime} rt
 * @param {Record<string, unknown>} args
 */
async function handleImage(rt, args) {
  const startedAt = Date.now();
  if (!rt.cfg.apiKey) return notConfigured();
  if (!rt.client) return noClient();

  const prompt = optStr(args.prompt);
  if (!prompt) return { ok: false, code: 'bad_request', error: 'prompt manquant ou vide' };

  const refs = strArray(args.input_images);
  const built = await buildInput({ client: rt.client, text: prompt, attachments: refs, log: rt.log });
  if (!built || built.ok !== true) {
    const failure = relayFailure(built, 'preparation des images de reference en echec');
    recordLastError(rt, 'generate_image', failure);
    return failure;
  }

  /** @type {Record<string, unknown>} */
  const responseFormat = { type: 'image', mime_type: optStr(args.mime_type) ?? 'image/png' };
  const aspect = optStr(args.aspect_ratio);
  if (aspect) responseFormat.aspect_ratio = aspect;
  const size = optStr(args.image_size);
  if (size) responseFormat.image_size = size;

  const model = optStr(args.model) ?? rt.cfg.imageModel;
  const res = await rt.client.interact({
    model,
    input: built.input,
    responseFormat,
    tools: toolsFor(args),
  });
  if (!res || res.ok !== true) {
    const failure = relayFailure(res, 'generation d image en echec sans detail');
    recordLastError(rt, 'generate_image', failure);
    return failure;
  }

  const media = extractMedia(res.json, 'image').filter((m) => m.data);
  if (media.length === 0) {
    const failure = noOutput(res.json, 'image');
    recordLastError(rt, 'generate_image', failure);
    return failure;
  }

  const slug = optStr(args.filename_hint) ?? prompt.slice(0, SLUG_SOURCE_MAX);
  const written = await writeAll(rt, {
    tool: 'generate_image',
    slug,
    items: media.map((m) => ({ data: /** @type {Buffer} */ (m.data), mime: m.mime || 'image/png' })),
  });
  if (!written || written.ok !== true) return written;

  /** @type {Record<string, unknown>} */
  const out = { ok: true, files: written.files, model, duration_ms: Date.now() - startedAt };
  // These models narrate what they drew; it is the only feedback available when
  // the result is not what was asked for.
  const text = extractText(res.json);
  if (text) out.text = text;
  return out;
}

// ---------------------------------------------------------------------------
// 5. gemini-api.generate_music
// ---------------------------------------------------------------------------

const MUSIC_DESCRIPTION =
  'Compose un morceau instrumental ou chante avec Lyria et **ecrit le fichier audio dans le workspace**. ' +
  "Decris le genre, les instruments, le tempo (BPM), la tonalite et l'ambiance ; tu peux structurer avec des " +
  'balises [Intro] [Verse] [Chorus] [Outro] et des reperes de temps [0:00-0:10]. ' +
  'Le modele clip produit ~30 s, le modele pro un morceau complet (plusieurs minutes, donc plusieurs minutes ' +
  "d'attente). Une image de reference peut servir d'inspiration.";

/**
 * @param {import('../index.js').Runtime} rt
 * @returns {import('@swarm-os/plugin-sdk').PluginToolDef}
 */
export function buildMusicToolDef(rt) {
  const z = rt.api.zod;
  return {
    name: 'generate_music',
    title: 'Composer de la musique (Lyria)',
    description: MUSIC_DESCRIPTION,
    inputSchema: {
      prompt: z
        .string()
        .min(1)
        .max(20000)
        .describe('Description du morceau : genre, instruments, BPM, tonalite, ambiance, structure.'),
      reference_images: z
        .array(z.string())
        .max(4)
        .optional()
        .describe("Images dont l'ambiance et les couleurs inspirent le morceau (optionnel)."),
      model: z
        .string()
        .max(80)
        .optional()
        .describe('Modele musique. Defaut : configuration. lyria-3-clip-preview = 30 s, lyria-3-pro-preview = complet.'),
      filename_hint: z.string().max(40).optional().describe('Slug utilise dans le nom de fichier.'),
    },
    outputSchema: {
      ok: z.boolean(),
      files: z
        .array(
          z.object({
            path: z.string(),
            workspace_relative: z.string(),
            container_path: z.string(),
            bytes: z.number(),
            mime: z.string(),
          }),
        )
        .optional(),
      model: z.string().optional(),
      text: z.string().optional(),
      duration_ms: z.number().optional(),
      code: z.string().optional(),
      error: z.string().optional(),
      hint: z.string().optional(),
    },
    handler: guarded(rt, 'generate_music', (args) => handleMusic(rt, args)),
  };
}

/**
 * @param {import('../index.js').Runtime} rt
 * @param {Record<string, unknown>} args
 */
async function handleMusic(rt, args) {
  const startedAt = Date.now();
  if (!rt.cfg.apiKey) return notConfigured();
  if (!rt.client) return noClient();

  const prompt = optStr(args.prompt);
  if (!prompt) return { ok: false, code: 'bad_request', error: 'prompt manquant ou vide' };

  const refs = strArray(args.reference_images);
  const built = await buildInput({ client: rt.client, text: prompt, attachments: refs, log: rt.log });
  if (!built || built.ok !== true) {
    const failure = relayFailure(built, 'preparation des images de reference en echec');
    recordLastError(rt, 'generate_music', failure);
    return failure;
  }

  const model = optStr(args.model) ?? rt.cfg.musicModel;
  const res = await rt.client.interact({
    model,
    // A single text block would do, but `built.input` is what carries the
    // optional reference images, and Lyria accepts the same block array.
    input: built.input,
    responseFormat: { type: 'audio' },
  });
  if (!res || res.ok !== true) {
    const failure = relayFailure(res, 'generation musicale en echec sans detail');
    recordLastError(rt, 'generate_music', failure);
    return failure;
  }

  const media = extractMedia(res.json, 'audio').filter((m) => m.data);
  if (media.length === 0) {
    const failure = noOutput(res.json, 'audio');
    recordLastError(rt, 'generate_music', failure);
    return failure;
  }

  // Lyria returns a real container (MP3, or WAV on the pro model), so
  // `toPlayableAudio` normally passes the bytes through untouched — it is called
  // anyway because the ONE thing that must never happen is a raw-PCM file with a
  // .mp3 name that no player will open.
  const items = media.map((m) => {
    const playable = toPlayableAudio(/** @type {Buffer} */ (m.data), m.mime);
    const mime = playable.ext === '.wav' ? 'audio/wav' : playable.ext === '.ogg' ? 'audio/ogg' : 'audio/mpeg';
    return { data: playable.data, mime, ext: playable.ext };
  });

  const slug = optStr(args.filename_hint) ?? prompt.slice(0, SLUG_SOURCE_MAX);
  const written = await writeAll(rt, { tool: 'generate_music', slug, items });
  if (!written || written.ok !== true) return written;

  /** @type {Record<string, unknown>} */
  const out = { ok: true, files: written.files, model, duration_ms: Date.now() - startedAt };
  const text = extractText(res.json);
  if (text) out.text = text;
  return out;
}

// ---------------------------------------------------------------------------
// 6. gemini-api.generate_video + gemini-api.video_status
//
// Video is the only ASYNCHRONOUS surface of the plugin, and the split is not a
// stylistic choice: Veo takes one to six minutes, while an MCP client gives up
// on a tool call long before that. `generate_video` therefore starts the job and
// returns a `job_id`; `video_status` collects it. `wait_seconds` lets an agent
// that has nothing better to do block for a while — bounded, and never by
// default.
// ---------------------------------------------------------------------------

const VIDEO_DESCRIPTION =
  'Lance une generation de video Veo (avec audio natif) et retourne un `job_id` IMMEDIATEMENT : ' +
  "la generation prend 1 a 6 minutes. Recupere le resultat avec gemini-api.video_status(job_id) — " +
  'la video est alors ecrite dans le workspace. Optionnel : `first_frame` fixe la premiere image ' +
  "(animation d'une image existante). ATTENTION, c'est l'outil le plus couteux du plugin : " +
  'la facturation est a la seconde de video. Demande confirmation avant de generer en boucle.';

/**
 * @param {import('../index.js').Runtime} rt
 * @returns {import('@swarm-os/plugin-sdk').PluginToolDef}
 */
export function buildVideoToolDef(rt) {
  const z = rt.api.zod;
  return {
    name: 'generate_video',
    title: 'Generer une video (Veo) — asynchrone',
    description: VIDEO_DESCRIPTION,
    inputSchema: {
      prompt: z
        .string()
        .min(1)
        .max(20000)
        .describe(
          'Description du plan : sujet, action, mouvement de camera, lumiere, ambiance sonore. ' +
            'Les dialogues entre guillemets sont joues avec le son.',
        ),
      first_frame: z
        .string()
        .max(500)
        .optional()
        .describe("Chemin d'une image du workspace utilisee comme premiere image de la video."),
      negative_prompt: z.string().max(2000).optional().describe('Ce qui ne doit PAS apparaitre.'),
      aspect_ratio: z.enum(['16:9', '9:16']).optional().describe('Format. Defaut : 16:9.'),
      resolution: z.enum(['720p', '1080p']).optional().describe('Resolution. Defaut : 720p.'),
      duration_seconds: z.number().optional().describe('Duree demandee en secondes (typiquement 4 a 8).'),
      model: z.string().max(80).optional().describe('Modele Veo. Defaut : celui de la configuration.'),
      wait_seconds: z
        .number()
        .optional()
        .describe(
          `Attendre au plus N secondes (0 a ${VIDEO_WAIT_MAX_SEC}) avant de rendre la main. ` +
            'Defaut 0 : retour immediat avec le job_id. Ne bloque que si tu n as rien d autre a faire.',
        ),
      filename_hint: z.string().max(40).optional().describe('Slug utilise dans le nom de fichier.'),
    },
    outputSchema: {
      ok: z.boolean(),
      job_id: z.string().optional(),
      status: z.string().optional(),
      operation: z.string().optional(),
      model: z.string().optional(),
      files: z
        .array(
          z.object({
            path: z.string(),
            workspace_relative: z.string(),
            container_path: z.string(),
            bytes: z.number(),
            mime: z.string(),
          }),
        )
        .optional(),
      next_step: z.string().optional(),
      waited_ms: z.number().optional(),
      elapsed_ms: z.number().optional(),
      note: z.string().optional(),
      code: z.string().optional(),
      error: z.string().optional(),
      hint: z.string().optional(),
    },
    handler: guarded(rt, 'generate_video', (args, ctx) => handleVideo(rt, args, ctx)),
  };
}

/**
 * @param {import('../index.js').Runtime} rt
 * @param {Record<string, unknown>} args
 * @param {import('@swarm-os/plugin-sdk').PluginToolContext} [ctx]
 */
async function handleVideo(rt, args, ctx) {
  const startedAt = Date.now();
  if (!rt.cfg.apiKey) return notConfigured();
  if (!rt.client) return noClient();

  const prompt = optStr(args.prompt);
  if (!prompt) return { ok: false, code: 'bad_request', error: 'prompt manquant ou vide' };

  /** @type {Record<string, unknown>} */
  const instance = { prompt };

  // A first frame must be INLINE: `:predictLongRunning` takes `inlineData`, not
  // a Files API uri, so this path deliberately does not reuse buildInput().
  const frameRef = optStr(args.first_frame);
  if (frameRef) {
    let abs;
    try {
      abs = toContainerPath(frameRef);
    } catch (err) {
      return { ok: false, code: 'bad_request', error: err instanceof Error ? err.message : String(err) };
    }
    let bytes;
    try {
      bytes = await fs.readFile(abs);
    } catch {
      return { ok: false, code: 'not_found', error: `image introuvable: ${frameRef}` };
    }
    if (bytes.length > MAX_FRAME_BYTES) {
      return {
        ok: false,
        code: 'oversized',
        error: `first_frame pese ${bytes.length} octets (limite ${MAX_FRAME_BYTES})`,
        hint: 'reduis la resolution de l image avant de la soumettre',
      };
    }
    const mime = /\.png$/i.test(abs) ? 'image/png' : /\.webp$/i.test(abs) ? 'image/webp' : 'image/jpeg';
    instance.image = { inlineData: { mimeType: mime, data: bytes.toString('base64') } };
  }

  const negative = optStr(args.negative_prompt);
  if (negative) instance.negativePrompt = negative;

  /** @type {Record<string, unknown>} */
  const parameters = {};
  const aspect = optStr(args.aspect_ratio);
  if (aspect) parameters.aspectRatio = aspect;
  const resolution = optStr(args.resolution);
  if (resolution) parameters.resolution = resolution;
  const duration = optInt(args.duration_seconds);
  // Sent as a STRING: that is the form Google's own reference uses, and a number
  // is rejected by some Veo revisions.
  if (duration !== undefined) parameters.durationSeconds = String(clamp(duration, 1, 60));

  const model = optStr(args.model) ?? rt.cfg.videoModel;
  const started = await rt.client.startVideo({ model, instances: [instance], parameters });
  if (!started || started.ok !== true) {
    const failure = relayFailure(started, 'demarrage de la generation video en echec');
    recordLastError(rt, 'generate_video', failure);
    return failure;
  }

  const job = {
    id: newJobId(),
    operation: started.operation,
    model,
    prompt: prompt.slice(0, 300),
    slug: optStr(args.filename_hint) ?? prompt.slice(0, SLUG_SOURCE_MAX),
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sessionName: ctx && typeof ctx.sessionName === 'string' ? ctx.sessionName : undefined,
  };
  const tracked = saveJob(rt.kv, job);

  /** @type {Record<string, unknown>} */
  const out = {
    ok: true,
    job_id: job.id,
    status: 'running',
    operation: job.operation,
    model,
    next_step: `appelle gemini-api.video_status avec job_id="${job.id}" dans une minute ou deux`,
    waited_ms: 0,
  };
  if (!tracked) {
    // Without db-kv nothing can look the job up later — so the OPERATION name is
    // the recovery handle, and video_status accepts it directly.
    out.note =
      "le suivi des travaux est indisponible (capacite db-kv non accordee au plugin) : passe `operation` a " +
      'gemini-api.video_status au lieu de job_id.';
  }

  const wait = clamp(optNum(args.wait_seconds) ?? 0, 0, VIDEO_WAIT_MAX_SEC) * 1000;
  if (wait <= 0) return out;

  // Blocking mode: poll until the operation finishes or the agent's budget runs
  // out. Never longer than `wait`, whatever Google does.
  const deadline = Date.now() + wait;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(VIDEO_POLL_MS, left)));
    const status = await handleVideoStatus(rt, { job_id: job.id, operation: job.operation });
    // Only a TERMINAL answer ends the wait. A transient poll failure (a 503
    // while Google renders) carries no `status` at all, and treating it as an
    // answer would hand the agent an error for a video that is still coming.
    const terminal = status && (status.status === 'done' || status.status === 'failed');
    if (terminal) return { ...status, waited_ms: Date.now() - startedAt };
  }
  out.waited_ms = Date.now() - startedAt;
  out.note = `${out.note ? `${out.note} ` : ''}toujours en cours apres ${Math.round(wait / 1000)} s d attente.`;
  return out;
}

const VIDEO_STATUS_DESCRIPTION =
  "Recupere l'etat d'une generation video lancee par gemini-api.generate_video. " +
  "Tant que `status` vaut 'running', rappelle plus tard (compte 1 a 6 minutes au total). " +
  "Quand `status` vaut 'done', la video est DEJA ecrite dans le workspace et `files[].path` est lisible par toi. " +
  "Sans argument, retourne les derniers travaux connus.";

/**
 * @param {import('../index.js').Runtime} rt
 * @returns {import('@swarm-os/plugin-sdk').PluginToolDef}
 */
export function buildVideoStatusToolDef(rt) {
  const z = rt.api.zod;
  return {
    name: 'video_status',
    title: "Etat d'une generation video (Veo)",
    description: VIDEO_STATUS_DESCRIPTION,
    inputSchema: {
      job_id: z.string().max(64).optional().describe('Identifiant rendu par gemini-api.generate_video.'),
      operation: z
        .string()
        .max(300)
        .optional()
        .describe("Nom d'operation Google — solution de repli quand le suivi des travaux est indisponible."),
    },
    outputSchema: {
      ok: z.boolean(),
      status: z.string().optional(),
      job_id: z.string().optional(),
      files: z
        .array(
          z.object({
            path: z.string(),
            workspace_relative: z.string(),
            container_path: z.string(),
            bytes: z.number(),
            mime: z.string(),
          }),
        )
        .optional(),
      elapsed_ms: z.number().optional(),
      operation: z.string().optional(),
      jobs: z
        .array(
          z.object({
            job_id: z.string(),
            status: z.string(),
            model: z.string(),
            prompt: z.string(),
            created_at: z.string(),
          }),
        )
        .optional(),
      note: z.string().optional(),
      code: z.string().optional(),
      error: z.string().optional(),
      hint: z.string().optional(),
    },
    handler: guarded(rt, 'video_status', (args) => handleVideoStatus(rt, args)),
  };
}

/**
 * @param {import('../index.js').Runtime} rt
 * @param {Record<string, unknown>} args
 */
async function handleVideoStatus(rt, args) {
  if (!rt.cfg.apiKey) return notConfigured();
  if (!rt.client) return noClient();

  const jobId = optStr(args.job_id);
  const explicitOperation = optStr(args.operation);

  // No argument: list what is known. Cheap, and the natural thing an agent does
  // after a restart when it has lost the id.
  if (!jobId && !explicitOperation) {
    const jobs = listJobs(rt.kv, 10).map((j) => ({
      job_id: j.id,
      status: j.status,
      model: j.model,
      prompt: j.prompt,
      created_at: new Date(j.createdAt || 0).toISOString(),
    }));
    return {
      ok: true,
      status: 'listing',
      jobs,
      note: jobs.length === 0 ? 'aucune generation video connue' : undefined,
    };
  }

  const job = jobId ? getJob(rt.kv, jobId) : null;
  if (jobId && !job && !explicitOperation) {
    return {
      ok: false,
      code: 'not_found',
      error: `job_id inconnu : ${jobId}`,
      hint: 'appelle gemini-api.video_status sans argument pour lister les travaux connus',
    };
  }

  // Already collected: return the same files instead of paying for a second
  // download. The operation stays readable on Google's side for a while, so
  // without this an agent polling twice would rewrite the video twice.
  //
  // Known limit: this settles the SEQUENTIAL case, not two polls racing in
  // parallel from two workers — both would see `running` and both would
  // download. The outcome is a duplicate file, not a corrupt one and not a
  // second charge (the download is free; the generation was billed once), so it
  // is documented rather than locked.
  if (job && job.status === 'done' && Array.isArray(job.files) && job.files.length > 0) {
    return { ok: true, status: 'done', job_id: job.id, files: job.files, elapsed_ms: (job.updatedAt || 0) - (job.createdAt || 0) };
  }
  if (job && job.status === 'failed') {
    return { ok: false, status: 'failed', job_id: job.id, code: job.code || 'generation_failed', error: job.error || 'generation echouee', hint: job.hint };
  }

  const operation = explicitOperation || (job ? job.operation : '');
  const poll = await rt.client.operationStatus(operation);
  if (!poll || poll.ok !== true) {
    // A failed POLL is not a failed JOB: report it without touching the record,
    // so a transient 503 does not bury a video that is still being rendered.
    return relayFailure(poll, "impossible d'interroger l'operation");
  }
  if (!poll.done) {
    return {
      ok: true,
      status: 'running',
      job_id: job ? job.id : undefined,
      elapsed_ms: job ? Date.now() - (job.createdAt || Date.now()) : undefined,
      note: 'generation en cours : rappelle cet outil dans une minute',
    };
  }
  if (poll.failure) {
    const failure = { ok: false, status: 'failed', code: poll.failure.code, error: poll.failure.error };
    if (job) saveJob(rt.kv, { ...job, status: 'failed', code: failure.code, error: failure.error });
    recordLastError(rt, 'video_status', failure);
    return { ...failure, job_id: job ? job.id : undefined };
  }

  return await collectVideo(rt, job, poll.response, operation);
}

/**
 * Walk an operation response for every generated video, whatever Google nested
 * it under.
 *
 * Veo's payload has moved between revisions
 * (`generateVideoResponse.generatedSamples[].video.uri`, `generatedVideos[]`,
 * `predictions[]`), so this is a bounded-depth WALK rather than a path lookup:
 * the plugin should keep working through the next rename, and a walk that finds
 * nothing fails just as clearly as a path that does not resolve.
 *
 * @param {any} response
 * @returns {Array<{uri?: string, b64?: string, mime: string|null}>}
 */
export function collectVideoRefs(response) {
  /** @type {Array<{uri?: string, b64?: string, mime: string|null}>} */
  const out = [];
  const seenUri = new Set();
  const seenB64 = new Set();

  /** @param {any} node @param {number} depth */
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    const mime =
      typeof node.mimeType === 'string' ? node.mimeType : typeof node.mime_type === 'string' ? node.mime_type : null;
    const uri = typeof node.uri === 'string' && /^https?:\/\//i.test(node.uri) ? node.uri : null;
    if (uri && !seenUri.has(uri)) {
      seenUri.add(uri);
      out.push({ uri, mime });
    }
    const b64 =
      typeof node.bytesBase64Encoded === 'string'
        ? node.bytesBase64Encoded
        : typeof node.data === 'string' && node.data.length > 64
          ? node.data
          : null;
    if (b64) {
      const key = `${b64.length}:${b64.slice(0, 32)}`;
      if (!seenB64.has(key)) {
        seenB64.add(key);
        out.push({ b64, mime });
      }
    }
    for (const value of Object.values(node)) visit(value, depth + 1);
  };

  visit(response, 0);
  return out;
}

/**
 * Download every generated video into the workspace and close the job.
 *
 * The file is STREAMED to its final path (lib/gemini.js `downloadToFile`) rather
 * than buffered: a Veo clip is tens of megabytes and this runs in the process
 * that serves every team's WebSocket.
 *
 * @param {import('../index.js').Runtime} rt
 * @param {any} job may be null when the caller only had an operation name
 * @param {any} response
 * @param {string} operation
 */
async function collectVideo(rt, job, response, operation) {
  const refs = collectVideoRefs(response);
  if (refs.length === 0) {
    const failure = {
      ok: false,
      status: 'failed',
      code: 'no_output',
      error: "l'operation est terminee mais ne contient aucune video",
      hint: "le prompt a peut-etre ete refuse par le filtre de securite ; consulte GET /plugin-api/gemini-api/status",
    };
    if (job) saveJob(rt.kv, { ...job, status: 'failed', code: failure.code, error: failure.error });
    recordLastError(rt, 'video_status', failure);
    return { ...failure, job_id: job ? job.id : undefined };
  }

  const dirs = await prepareDir(rt, 'video_status');
  if (!dirs || dirs.ok !== true) return dirs;

  const slug = (job && job.slug) || 'video';
  /** @type {object[]} */
  const files = [];
  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i];
    const ext = extFromMime(ref.mime, '.mp4');
    const name = buildFileName({ now: new Date(), slug, index: i, ext });
    const absPath = path.join(dirs.dayDir, name);

    if (ref.uri) {
      const dl = await rt.client.downloadToFile({ uri: ref.uri, absPath, maxBytes: VIDEO_MAX_BYTES });
      if (!dl || dl.ok !== true) {
        const failure = relayFailure(dl, 'telechargement de la video en echec');
        recordLastError(rt, 'video_status', failure);
        // The job stays `running`: the video EXISTS on Google's side and the
        // operation is still readable, so a later poll can collect it. Marking it
        // failed here would throw away a video that was paid for.
        return { ...failure, status: 'running', job_id: job ? job.id : undefined, files, operation };
      }
      files.push(describeFile(absPath, dl.bytes, ref.mime || 'video/mp4'));
      continue;
    }

    try {
      const written = await writeMedia({ absDir: dirs.dayDir, name, data: Buffer.from(/** @type {string} */ (ref.b64), 'base64') });
      files.push(describeFile(written.path, written.bytes, ref.mime || 'video/mp4'));
    } catch (err) {
      const failure = { ok: false, code: 'internal', error: `ecriture de la video impossible : ${String(err)}` };
      recordLastError(rt, 'video_status', failure);
      return { ...failure, status: 'running', job_id: job ? job.id : undefined, files };
    }
  }

  sweepBestEffort(rt, dirs.outRoot);
  if (job) saveJob(rt.kv, { ...job, status: 'done', files });
  return {
    ok: true,
    status: 'done',
    job_id: job ? job.id : undefined,
    files,
    elapsed_ms: job ? Date.now() - (job.createdAt || Date.now()) : undefined,
  };
}

// ---------------------------------------------------------------------------
// 7. gemini-api.list_models
// ---------------------------------------------------------------------------

const MODELS_DESCRIPTION =
  'Liste les modeles Gemini que cette cle peut reellement appeler aujourd hui. ' +
  "A utiliser quand un outil repond code:'model_not_found' : Google renomme et retire des modeles regulierement.";

/**
 * @param {import('../index.js').Runtime} rt
 * @returns {import('@swarm-os/plugin-sdk').PluginToolDef}
 */
export function buildModelsToolDef(rt) {
  const z = rt.api.zod;
  return {
    name: 'list_models',
    title: 'Lister les modeles Gemini disponibles',
    description: MODELS_DESCRIPTION,
    inputSchema: {
      filter: z
        .string()
        .max(40)
        .optional()
        .describe("Sous-chaine filtrant les identifiants (exemple : 'image', 'tts', 'veo', 'lyria')."),
    },
    outputSchema: {
      ok: z.boolean(),
      models: z.array(z.string()).optional(),
      count: z.number().optional(),
      configured: z
        .object({
          text: z.string(),
          image: z.string(),
          tts: z.string(),
          music: z.string(),
          video: z.string(),
        })
        .optional(),
      code: z.string().optional(),
      error: z.string().optional(),
      hint: z.string().optional(),
    },
    handler: guarded(rt, 'list_models', async (args) => {
      if (!rt.cfg.apiKey) return notConfigured();
      if (!rt.client) return noClient();
      const res = await rt.client.listModels();
      if (!res || res.ok !== true) return relayFailure(res, 'liste des modeles indisponible');
      // Free side effect: an agent asking what exists is also the plugin's cue
      // to refresh the operator's dropdowns. Throttled, never awaited — the
      // agent's answer does not wait on a manifest write.
      void refreshModelEnums(rt).catch(() => {});
      const filter = (optStr(args.filter) || '').toLowerCase();
      const models = res.models.map((m) => m.name).filter((n) => (filter ? n.toLowerCase().includes(filter) : true));
      return {
        ok: true,
        models,
        count: models.length,
        configured: {
          text: rt.cfg.textModel,
          image: rt.cfg.imageModel,
          tts: rt.cfg.ttsModel,
          music: rt.cfg.musicModel,
          video: rt.cfg.videoModel,
        },
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// 8. gemini-api.guide
// ---------------------------------------------------------------------------

/**
 * Cheap in context (no parameters, three lines of schema) and the only thing
 * that makes the method discoverable — every other tool's description points at
 * it by name.
 *
 * @param {import('../index.js').Runtime} rt
 * @returns {import('@swarm-os/plugin-sdk').PluginToolDef}
 */
export function buildGuideToolDef(rt) {
  const z = rt.api.zod;
  return {
    name: 'guide',
    title: 'Mode d emploi des outils Gemini',
    description:
      'Retourne le mode d emploi complet des outils gemini-api : quel outil pour quel besoin, comment ecrire un ' +
      'prompt d image, de musique ou de video qui marche, ce que coute chaque appel, et les pieges connus. ' +
      'Aucun appel reseau, aucun cout.',
    inputSchema: {},
    outputSchema: {
      ok: z.boolean(),
      guide: z.string().optional(),
      guide_path: z.string().optional(),
    },
    handler: guarded(rt, 'guide', async () => {
      /** @type {Record<string, unknown>} */
      const out = { ok: true, guide: rt.guide };
      if (rt.guidePath) out.guide_path = rt.guidePath;
      return out;
    }),
  };
}

// ---------------------------------------------------------------------------
// 9. GET /plugin-api/gemini-api/status — the operator's diagnostic
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
      if (probe === 'text') {
        res.json(await probeText(rt));
        return;
      }
      // `?refresh=models` rebuilds the config form's dropdowns NOW, bypassing
      // the throttle — the operator who just fixed the key should not have to
      // wait out an interval to see the fields fill in.
      const refresh = req && req.query ? String(req.query.refresh ?? '') : '';
      if (refresh === 'models') {
        res.json({ ...(await refreshModelEnums(rt, { force: true })), action: 'refresh_models' });
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
  const keySet = Boolean(cfg.apiKey);

  // BOTH path forms: the gap between them is what makes a transport translation
  // bug visible without reproducing it.
  /** @type {{agent: string|null, container: string|null, configured: string, error?: string}} */
  const outputDir = { agent: null, container: null, configured: cfg.outputDir };
  try {
    const abs = resolveOutputDir(cfg.outputDir);
    outputDir.container = abs;
    outputDir.agent = toAgentPath(abs);
  } catch (err) {
    outputDir.error = err instanceof Error ? err.message : String(err);
  }

  let queue = { inflight: 0, waiting: 0, maxConcurrent: cfg.maxConcurrent };
  try {
    if (rt.client) queue = rt.client.stats();
  } catch {
    // A broken gauge must not break the diagnostic that reads it.
  }

  // The live model list, straight from Google — this is what makes the free-text
  // model fields checkable. A failure goes INTO the field rather than failing the
  // route: the rest of the payload is exactly what is needed to understand why.
  /** @type {{available: string[], error: string|null}} */
  const models = { available: [], error: null };
  if (keySet && rt.client) {
    try {
      const listed = await rt.client.listModels();
      if (listed && listed.ok === true) models.available = listed.models.map((m) => m.name);
      else models.error = listed && listed.error ? String(listed.error) : 'liste indisponible';
    } catch (err) {
      models.error = err instanceof Error ? err.message : String(err);
    }
  }

  // The operator's page is exactly when the dropdowns should be current — and
  // the list is already in hand, so the refresh costs nothing more. Throttled,
  // and never awaited: a manifest write must not delay a diagnostic.
  if (models.available.length > 0) {
    void refreshModelEnums(rt, { liveNames: models.available }).catch(() => {});
  }

  const configured = {
    text: cfg.textModel,
    image: cfg.imageModel,
    tts: cfg.ttsModel,
    music: cfg.musicModel,
    video: cfg.videoModel,
  };

  const hints = [];
  if (!keySet) {
    hints.push(
      "Aucune cle : tous les outils repondent code:not_configured. Renseigne apiKey dans la configuration du plugin (https://aistudio.google.com/apikey).",
    );
  }
  if (outputDir.error) hints.push(`outputDir invalide: ${outputDir.error}`);
  if (models.available.length > 0) {
    // The single most common failure of this plugin, caught BEFORE an agent
    // meets it: a model renamed out from under the configuration.
    const unknown = Object.entries(configured)
      .filter(([, id]) => !models.available.includes(id))
      .map(([slot, id]) => `${slot}=${id}`);
    if (unknown.length > 0) {
      hints.push(
        `Modele(s) configure(s) absent(s) de la liste Google (${unknown.join(', ')}) : ces outils repondront ` +
          'code:model_not_found. Corrige la configuration avec un identifiant de la liste `models.available`.',
      );
    }
  }
  hints.push(
    "Ajoute ?probe=text a cette URL pour verifier la cle par un vrai appel (cout negligeable, quelques tokens).",
  );
  hints.push(
    "Les cinq champs de modele de la configuration sont des listes deroulantes que le plugin remplit lui-meme a partir de cette liste. Ajoute ?refresh=models a cette URL pour les reconstruire immediatement.",
  );
  hints.push(
    "Apres un enable ou un changement de configuration, redemarre ou reprends la session du lead pour voir les nouveaux outils (une session deja lancee a mis en cache sa liste d'outils MCP).",
  );
  hints.push(
    'La video Veo est facturee a la seconde generee : surveille jobs[] si la note Google grimpe.',
  );

  const jobs = listJobs(rt.kv, 10).map((j) => ({
    job_id: j.id,
    status: j.status,
    model: j.model,
    prompt: j.prompt,
    session: j.sessionName || null,
    created_at: new Date(j.createdAt || 0).toISOString(),
    files: Array.isArray(j.files) ? j.files.length : 0,
  }));

  return {
    ok: true,
    plugin: 'gemini-api',
    // A BOOLEAN and a fingerprint — never the key itself, on any code path.
    key_set: keySet,
    key_fingerprint: keySet ? `${cfg.apiKey.slice(0, 4)}...${cfg.apiKey.slice(-4)}` : null,
    models_configured: configured,
    models,
    default_voice: cfg.defaultVoice,
    output_dir: outputDir,
    retention_days: cfg.retentionDays,
    request_timeout_sec: cfg.requestTimeoutSec,
    queue,
    // What the config form's model dropdowns currently offer, and when they were
    // last rebuilt. `null` means they have never been filled in — the fields are
    // still free text (no key yet, an unreachable API, or a read-only plugin
    // directory; the plugin's log line says which).
    model_dropdowns: safeJson(rt.kv.get(REFRESH_SUMMARY_KEY)),
    video_jobs: jobs,
    last_error: safeJson(rt.kv.get(LAST_ERROR_KEY)),
    hints,
  };
}

/**
 * Live check of the key, on the CHEAPEST possible call: a one-token completion
 * on the configured text model.
 *
 * Probing the endpoint the tools actually use covers four regressions instead of
 * one — revoked key, quota exhausted, model renamed, API not enabled on the
 * project — where a mere "is the key non-empty" check covers none.
 *
 * @param {import('../index.js').Runtime} rt
 * @returns {Promise<Record<string, unknown>>}
 */
async function probeText(rt) {
  if (!rt.cfg.apiKey) return { probe: 'text', ...notConfigured() };
  if (!rt.client) return { probe: 'text', ...noClient() };
  const startedAt = Date.now();
  const res = await rt.client.interact({
    model: rt.cfg.textModel,
    input: 'ping',
    // TWO VALUES THAT LOOK HARMLESS AND ARE NOT.
    //   `thinking_level` accepts low | medium | high ONLY. 'minimal' is what the
    //   Interactions API advertises elsewhere, and Gemini rejects it outright:
    //   "'minimal' is not a supported thinking level for this model". The probe
    //   then failed EVERY day while the key, the quota and the API were fine —
    //   a monitor that cries wolf is worse than no monitor.
    //   `max_output_tokens` caps the REASONING as well as the text, so at 1 the
    //   call succeeds but comes back `status: "incomplete"` having generated
    //   nothing (measured: 2 tokens billed, empty output). The probe passed
    //   without ever exercising generation — it would have stayed green on a
    //   model that could no longer answer. At 256 the same ping completes in
    //   ~84 tokens, which is what makes the probe worth running.
    generationConfig: { max_output_tokens: 256, thinking_level: 'low' },
  });
  if (!res || res.ok !== true) {
    return { probe: 'text', model: rt.cfg.textModel, ...relayFailure(res, 'sonde en echec') };
  }
  return {
    ok: true,
    probe: 'text',
    model: rt.cfg.textModel,
    duration_ms: Date.now() - startedAt,
    usage: extractUsage(res.json),
    verdict: `La cle fonctionne et le modele ${rt.cfg.textModel} repond.`,
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

// gemini-api — expose Google's Gemini API to every agent of the swarm as a small
// set of MCP tools: text, multimodal analysis (vision/audio/video/PDF), speech,
// images, music and video. The operator types one API key in the plugin's config
// form; agents never see a key, a URL or a binary format.
//
// This file owns four things and nothing else: config parsing, the
// per-activation runtime, the DEFENSIVE wiring order, and the daily key probe.
//
// WIRING ORDER IS LOAD-BEARING. `api.http.registerRouter` and
// `api.schedule.cron` call `requireCap(...)`, which THROWS when the operator did
// not grant `http-routes` / `schedule` (packages/server/src/modules/plugins/api.ts:152-156
// and :561). Registering the MCP tools FIRST, then wrapping every optional
// capability in its own try/catch, means a missing DIAGNOSTIC capability can
// never take down the plugin's reason to exist — otherwise `activate()` rejects,
// `doEnable` reports `error`, and no tool is ever exposed.
//
// NO NETWORK CALL IN `activate()`: the host budget is 10 s (host.ts:59).
//
// The config is deliberately read ONCE per activation and `api.config.onChange`
// is deliberately NOT implemented: without a subscriber the host hot-restarts
// the plugin on a config PUT (host.ts:670-681), which is exactly right here
// since the key, the output directory, the models and the timeouts are all
// captured at activation. Consequence to document: changing the config
// interrupts a generation in flight — but NOT a video job, which lives in KV on
// purpose (lib/jobs.js).
//
// @typedef {import('@swarm-os/plugin-sdk').SwarmPlugin} SwarmPlugin
// @typedef {import('@swarm-os/plugin-sdk').SwarmPluginApi} SwarmPluginApi

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createGeminiClient } from './lib/gemini.js';
import { refreshModelEnums } from './lib/model-lists.js';
import {
  buildAnalyzeToolDef,
  buildGuideToolDef,
  buildImageToolDef,
  buildModelsToolDef,
  buildMusicToolDef,
  buildSpeechToolDef,
  buildStatusRouter,
  buildTextToolDef,
  buildVideoStatusToolDef,
  buildVideoToolDef,
} from './lib/tools.js';

/**
 * Fallback if `agent-assets/GUIDE.md` cannot be read (partial copy, bad modes).
 * Short on purpose: the point is that the tool still answers something useful.
 */
const GUIDE_FALLBACK =
  'Outils gemini-api : generate_text (texte, JSON strict, recherche Google), analyze_media (VISION : image, ' +
  'audio, video, PDF -> texte), text_to_speech (voix -> fichier WAV), generate_image (creation ET edition ' +
  "d'images), generate_music (Lyria), generate_video + video_status (Veo, asynchrone), list_models. " +
  'Tout media genere est ecrit dans le workspace ; utilise files[].path pour le relire, ' +
  'files[].workspace_relative pour le passer a un autre outil.';

/** Warn the operator at most this often about the same problem. */
const NOTIFY_THROTTLE_MS = 60 * 60 * 1000;

/** Daily probe: cron expression (host timezone defaults to UTC). */
const PROBE_CRON = '0 4 * * *';

/**
 * Delay before the FIRST model-list refresh after an activation.
 *
 * Not in `activate()`: the host budget there is 10 s (host.ts:59) and this is a
 * network call. Not on the daily cron alone either — the operator pastes the key
 * and opens the config form within the minute, and a dropdown that only fills in
 * at 04:00 the next day is a dropdown nobody believes in. Fifteen seconds is
 * after the enable settles and long before anyone has finished reading the page.
 */
const FIRST_REFRESH_MS = 15_000;

/**
 * Parsed configuration — flat, static for the lifetime of one activation.
 *
 * @typedef {object} GeminiConfig
 * @property {string} apiKey            Google AI Studio API key ('' when unset)
 * @property {string} textModel         default model for text + media analysis
 * @property {string} imageModel        default model for image generation
 * @property {string} ttsModel          default model for speech
 * @property {string} musicModel        default model for music
 * @property {string} videoModel        default Veo model
 * @property {string} defaultVoice      default TTS voice name
 * @property {string} outputDir         media directory, RELATIVE to the workspace root
 * @property {number} retentionDays     0 = never purge
 * @property {number} requestTimeoutSec per-request deadline
 * @property {number} maxConcurrent     simultaneous calls, all agents together
 */

/**
 * KV that degrades to a no-op instead of throwing when `db-kv` was not granted.
 *
 * @typedef {object} SafeKv
 * @property {(k: string) => string|null} get
 * @property {(k: string, v: string) => void} set
 * @property {(k: string) => void} delete
 * @property {(p?: string) => Array<{key: string, value: string}>} list
 */

/**
 * Shared per-activation runtime handed to every lib module. Created by
 * `activate()`, never at module scope — modules under lib/ survive a reload
 * (loader.ts:29-30 busts index.js only), so all state must live here.
 *
 * @typedef {object} Runtime
 * @property {SwarmPluginApi} api
 * @property {import('@swarm-os/plugin-sdk').Logger} log
 * @property {GeminiConfig} cfg
 * @property {any} client                 Gemini HTTP client (lib/gemini.js)
 * @property {SafeKv} kv
 * @property {string} guide               agent-assets/GUIDE.md, read once at activation
 * @property {string|null} guidePath      same file, resolved in the AGENT's namespace
 * @property {string} manifestPath        this plugin's own plugin.json (it rewrites its dropdowns)
 * @property {Array<{ dispose(): void }>} dispose
 */

/**
 * Read `agent-assets/GUIDE.md` from the plugin's own directory.
 *
 * Read ONCE per activation rather than per call: it is static, and caching it in
 * a module-level variable is forbidden here (lib/ and index.js do not share a
 * reload lifetime — see the header). Cheap enough for the 10 s activation
 * budget, and it is local disk, not network.
 *
 * @returns {string}
 */
function readGuide() {
  try {
    const text = fs.readFileSync(new URL('./agent-assets/GUIDE.md', import.meta.url), 'utf8');
    return typeof text === 'string' && text.trim() !== '' ? text : GUIDE_FALLBACK;
  } catch {
    return GUIDE_FALLBACK;
  }
}

/**
 * Where the agent can read that same file. Requires the `agent-assets` grant, so
 * the accessor is guarded: a missing capability costs the path, not the guide.
 *
 * @param {SwarmPluginApi} api
 * @returns {string|null}
 */
function guidePathFor(api) {
  try {
    const base = api.agentAssets.basePath;
    return typeof base === 'string' && base ? `${base}/GUIDE.md` : null;
  } catch {
    return null;
  }
}

/** @type {Runtime|null} — per-activation, reset by deactivate(). */
let runtime = null;

/**
 * Read `api.config.get()` and apply the manifest's defaults. Exported because it
 * is unit-tested and because it is the single source of truth for what a config
 * value means at runtime.
 *
 * Values are re-validated here even though the host validates a `PUT`: a config
 * row can predate a schema change, and a hand-edited `config_json` must not be
 * able to produce `requestTimeoutSec: 0` (every call would abort instantly) or
 * `maxConcurrent: 0` (every call would hang until the wait budget expired).
 *
 * @param {SwarmPluginApi} api
 * @returns {GeminiConfig}
 */
export function parseConfig(api) {
  /** @type {Record<string, unknown>} */
  let raw = {};
  try {
    raw = /** @type {Record<string, unknown>} */ (api.config.get() || {});
  } catch {
    raw = {};
  }

  /** @param {string} k @param {string} d @returns {string} */
  const str = (k, d) => {
    const v = raw[k];
    if (typeof v !== 'string') return d;
    const t = v.trim();
    return t === '' ? d : t;
  };
  /** @param {string} k @param {number} d @returns {number} */
  const num = (k, d) => {
    const v = raw[k];
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
    return Number.isFinite(n) ? n : d;
  };
  /** @param {number} n @param {number} lo @param {number} hi @returns {number} */
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  return {
    apiKey: str('apiKey', ''),
    // FREE STRINGS, not closed lists. Google renames models every few months
    // (gemini-3.7-flash, gemini-3.1-flash-image and lyria-3 all postdate the
    // first draft of this plugin), and novelai learned the expensive version of
    // the lesson: an allowlist did not merely hide a new model, it silently
    // REWROTE the operator's value back to the default, so a valid new model
    // produced the old one with no error at all. An unknown id is now sent as
    // typed, Google's own 404 says so, and /status lists what exists.
    textModel: str('textModel', 'gemini-3.7-flash'),
    imageModel: str('imageModel', 'gemini-3.1-flash-image'),
    ttsModel: str('ttsModel', 'gemini-3.1-flash-tts-preview'),
    musicModel: str('musicModel', 'lyria-3-clip-preview'),
    videoModel: str('videoModel', 'veo-3.1-generate-preview'),
    defaultVoice: str('defaultVoice', 'Kore'),
    outputDir: str('outputDir', 'gemini'),
    retentionDays: Math.max(0, Math.trunc(num('retentionDays', 7))),
    requestTimeoutSec: clamp(num('requestTimeoutSec', 120), 10, 600),
    maxConcurrent: Math.trunc(clamp(num('maxConcurrent', 2), 1, 8)),
  };
}

/**
 * Wrap `api.storage.kv` so a missing `db-kv` grant degrades to a no-op. Every
 * consumer (the retention throttle, the notification anti-spam, the video job
 * store) is a nice-to-have; none of them may take down a generation.
 * `api.ts:226-241` throws on each accessor when the capability was not granted.
 *
 * @param {SwarmPluginApi} api
 * @returns {SafeKv}
 */
function makeSafeKv(api) {
  return {
    get(k) {
      try {
        return api.storage.kv.get(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        api.storage.kv.set(k, v);
      } catch {
        /* db-kv not granted — the feature simply degrades */
      }
    },
    delete(k) {
      try {
        api.storage.kv.delete(k);
      } catch {
        /* same */
      }
    },
    list(p) {
      try {
        return api.storage.kv.list(p) || [];
      } catch {
        return [];
      }
    },
  };
}

/**
 * Send a custom notification at most once per hour per `kind`. Both failure
 * modes are swallowed: `requireCap('notify')` throws synchronously when the
 * capability is missing, and the delivery promise can reject
 * (precedent: `discord-agent/lib/provision.js:138`).
 *
 * @param {Runtime} rt
 * @param {string} kind anti-spam bucket
 * @param {{ title: string, message: string, level?: 'info'|'warn'|'critical' }} input
 */
function notifyOnce(rt, kind, input) {
  const key = `notify.${kind}.last`;
  const now = Date.now();
  const last = Number(rt.kv.get(key) || '0') || 0;
  if (last && now - last < NOTIFY_THROTTLE_MS) return;
  rt.kv.set(key, String(now));
  try {
    void rt.api.notify.custom(input).catch(() => {});
  } catch {
    /* notify not granted */
  }
}

/**
 * Daily probe (04:00) — one one-token call on the configured text model.
 *
 * A Gemini key does not expire, so there is no clock to watch the way novelai
 * watches a 30-day token; what DOES break silently is everything around it: a
 * revoked key, a project whose billing lapsed, a quota consumed by another
 * workload, a model retired out from under the configuration. All four surface
 * on the very endpoint the tools use, which is why the probe calls it rather
 * than asking a metadata endpoint whether things look fine.
 *
 * Never throws: it runs inside a host-guarded cron callback.
 *
 * @param {Runtime} rt
 * @returns {Promise<void>}
 */
async function probeDaily(rt) {
  try {
    if (!rt.cfg.apiKey || !rt.client) return;

    // Same visit, two errands: the daily call is also when the config form's
    // model dropdowns are brought back in line with what Google serves.
    await refreshModelEnums(rt, { force: true });

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
    if (res && res.ok === true) return;

    const code = res && typeof res.code === 'string' ? res.code : 'upstream';
    const detail = res && typeof res.error === 'string' ? res.error : '';

    // Same record shape as `recordLastError` in lib/tools.js, so `/status`
    // renders a probe failure exactly like a tool failure. Without this the
    // 04:00 cron would notify the operator and `/status` — the first place they
    // look afterwards — would show nothing at all.
    rt.kv.set(
      'last_error',
      JSON.stringify({ at: new Date().toISOString(), tool: 'probe', code, error: detail.slice(0, 300) }),
    );

    if (code === 'unauthorized') {
      notifyOnce(rt, 'unauthorized', {
        title: 'Gemini API: cle refusee',
        level: 'warn',
        message: `La sonde quotidienne recoit un refus d authentification de Google : la cle est invalide ou revoquee. Regenere-la sur https://aistudio.google.com/apikey puis colle-la dans la configuration du plugin gemini-api. Detail: ${detail.slice(0, 300)}`,
      });
    } else if (code === 'forbidden') {
      notifyOnce(rt, 'forbidden', {
        title: 'Gemini API: acces refuse',
        level: 'warn',
        message: `La sonde quotidienne recoit un refus d acces : cle restreinte, API Generative Language non activee sur le projet, ou modele indisponible dans la region. Detail: ${detail.slice(0, 300)}`,
      });
    } else if (code === 'rate_limited') {
      notifyOnce(rt, 'rate_limited', {
        title: 'Gemini API: quota epuise',
        level: 'warn',
        message: `La sonde quotidienne recoit un quota depasse. Les outils gemini-api echoueront tant que le quota n est pas reinitialise. Baisse maxConcurrent, ou active la facturation du projet Google Cloud. Detail: ${detail.slice(0, 300)}`,
      });
    } else if (code === 'model_not_found') {
      notifyOnce(rt, 'model_not_found', {
        title: 'Gemini API: modele introuvable',
        level: 'warn',
        message: `Le modele texte configure (${rt.cfg.textModel}) n existe plus chez Google. Ouvre GET /plugin-api/gemini-api/status pour la liste a jour et corrige la configuration du plugin. Detail: ${detail.slice(0, 300)}`,
      });
    } else {
      rt.log.warn(
        { event: 'gemini.probe_failed', code },
        'gemini-api: sonde quotidienne en echec (pas de notification, cause non actionnable)',
      );
    }
  } catch (err) {
    rt.log.warn({ event: 'gemini.probe_error', error: String(err) }, 'gemini-api: sonde quotidienne interrompue');
  }
}

/** @type {SwarmPlugin} */
const plugin = {
  /** @param {SwarmPluginApi} api */
  async activate(api) {
    const cfg = parseConfig(api);
    /** @type {Runtime} */
    const rt = {
      api,
      log: api.log,
      cfg,
      client: null,
      kv: makeSafeKv(api),
      guide: readGuide(),
      guidePath: guidePathFor(api),
      // The plugin's OWN manifest, resolved from this module's URL rather than
      // from a configured root: the plugin is a directory copy and always sits
      // next to its own plugin.json, wherever the operator dropped it.
      manifestPath: fileURLToPath(new URL('./plugin.json', import.meta.url)),
      dispose: [],
    };
    runtime = rt;

    // Factory, not module state: the client must be rebuilt on every activation
    // (lib/ modules are NOT re-imported after a reload).
    rt.client = createGeminiClient({
      apiKey: cfg.apiKey,
      timeoutMs: cfg.requestTimeoutSec * 1000,
      maxConcurrent: cfg.maxConcurrent,
      log: api.log,
    });

    // The reason this plugin exists — registered FIRST, before anything that can
    // throw. Their Disposables are already tracked by the host's store
    // (api.ts registerTool -> disposables.add), so they are not pushed here.
    api.mcp.registerTool(buildTextToolDef(rt));
    api.mcp.registerTool(buildAnalyzeToolDef(rt));
    api.mcp.registerTool(buildSpeechToolDef(rt));
    api.mcp.registerTool(buildImageToolDef(rt));
    api.mcp.registerTool(buildMusicToolDef(rt));
    api.mcp.registerTool(buildVideoToolDef(rt));
    api.mcp.registerTool(buildVideoStatusToolDef(rt));
    api.mcp.registerTool(buildModelsToolDef(rt));
    api.mcp.registerTool(buildGuideToolDef(rt));

    // Operator diagnostic. Optional: never let it take the tools down.
    try {
      api.http.registerRouter(buildStatusRouter(rt));
    } catch (err) {
      api.log.warn(
        { event: 'gemini.no_http', error: String(err) },
        'gemini-api: route /status non enregistree (capacite http-routes non accordee)',
      );
    }

    // Daily key probe. Optional for the same reason.
    try {
      rt.dispose.push(api.schedule.cron(PROBE_CRON, () => probeDaily(rt)));
    } catch (err) {
      api.log.warn(
        { event: 'gemini.no_schedule', error: String(err) },
        'gemini-api: sonde quotidienne desactivee (capacite schedule non accordee)',
      );
    }

    // First refresh of the config form's model dropdowns. A raw timer rather
    // than `api.schedule.*`, because neither `cron` nor `interval` can express
    // "once, shortly" — and because it must NOT depend on the `schedule` grant:
    // the dropdowns are part of configuring the plugin, not a scheduled task.
    // The host does not dispose timers it did not create, so this one is
    // unref'd (it can never hold the process open) and pushed onto the teardown
    // set like every other resource here.
    const firstRefresh = setTimeout(() => {
      void refreshModelEnums(rt, { force: true });
    }, FIRST_REFRESH_MS);
    if (typeof firstRefresh.unref === 'function') firstRefresh.unref();
    rt.dispose.push({ dispose: () => clearTimeout(firstRefresh) });

    // Cheap local diagnostics — CPU only, no network, no notification.
    if (!cfg.apiKey) {
      api.log.warn(
        { event: 'gemini.not_configured' },
        'gemini-api: apiKey absente — les outils repondront code:not_configured',
      );
    }

    api.log.info(
      {
        event: 'gemini.activated',
        textModel: cfg.textModel,
        imageModel: cfg.imageModel,
        outputDir: cfg.outputDir,
        maxConcurrent: cfg.maxConcurrent,
      },
      'gemini-api active',
    );
  },

  async deactivate() {
    const rt = runtime;
    runtime = null;
    if (!rt) return;
    for (const d of rt.dispose.splice(0)) {
      try {
        d?.dispose?.();
      } catch (err) {
        rt.log.warn({ event: 'gemini.dispose_error', error: String(err) }, 'gemini-api: dispose en echec');
      }
    }
    // A video job in flight is NOT cancelled: it lives on Google's side and its
    // record lives in KV, so `video_status` collects it after the next enable.
    rt.client = null;
  },
};

export default plugin;

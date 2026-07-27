// novelai — expose the NovelAI API to every Claude Code agent of the swarm as
// two MCP tools: `novelai.generate_text` (Erato prose, returned inline) and
// `novelai.generate_voice` (TTS written into the workspace, path returned). The
// operator types the API token once in the plugin's config form; agents never
// see a token, a URL or a binary format.
//
// This file owns four things and nothing else: config parsing, the
// per-activation runtime, the DEFENSIVE wiring order, and the daily token probe.
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
// since the token, the output directory and the timeout are captured at
// activation. Consequence to document: changing the config interrupts a
// generation in flight.
//
// @typedef {import('@swarm-os/plugin-sdk').SwarmPlugin} SwarmPlugin
// @typedef {import('@swarm-os/plugin-sdk').SwarmPluginApi} SwarmPluginApi

import * as fs from 'node:fs';

import { createNaiClient, jwtExpMs } from './lib/nai.js';
import {
  buildGuideToolDef,
  buildStatusRouter,
  buildTextToolDef,
  buildVoiceToolDef,
} from './lib/tools.js';

/**
 * Fallback if `agent-assets/GUIDE.md` cannot be read (partial copy, bad modes).
 * Short on purpose: the point is that the tool still answers something useful.
 */
const GUIDE_FALLBACK =
  "NovelAI CONTINUE un texte, il ne repond pas a une consigne. Pour ecrire une histoire : " +
  'passe `story` (tout le texte deja ecrit), `memory` (personnages, decor, voix narrative) et ' +
  '`authors_note` (ce qui doit arriver dans le paragraphe a venir, en une phrase), plus un ' +
  "`opening` coupe en plein milieu d'une phrase. Un paragraphe par appel (max_length 110-250) : " +
  'genere, juge, garde ou relance. Ajoute a `memory` tout fait qui doit survivre.';

/** TTS containers the plugin can produce without transcoding (no ffmpeg here). */
const TTS_FORMATS = ['opus', 'mp3'];

/** Warn the operator this long before the persistent token expires. */
const EXPIRY_WARN_MS = 3 * 24 * 60 * 60 * 1000;

/** At most one notification of a given kind per hour (KV-backed, survives reload). */
const NOTIFY_THROTTLE_MS = 60 * 60 * 1000;

/** Daily probe: cron expression (host timezone defaults to UTC). */
const PROBE_CRON = '0 4 * * *';

/**
 * Parsed configuration — flat, static for the lifetime of one activation.
 *
 * @typedef {object} NovelAiConfig
 * @property {string} apiToken           persistent NovelAI token ('' when unset)
 * @property {string} textModel          default model for generate_text
 * @property {string} defaultVoice       default TTS voice name
 * @property {number} defaultMaxLength   default generated tokens (1..300)
 * @property {number} defaultTemperature default sampling temperature (0.1..3)
 * @property {string} outputDir          audio directory, RELATIVE to the workspace root
 * @property {string} ttsFormat          'opus' | 'mp3'
 * @property {number} retentionDays      0 = never purge
 * @property {number} requestTimeoutSec  per-request deadline
 */

/**
 * KV that degrades to a no-op instead of throwing when `db-kv` was not granted.
 *
 * @typedef {object} SafeKv
 * @property {(k: string) => string|null} get
 * @property {(k: string, v: string) => void} set
 */

/**
 * Shared per-activation runtime handed to every lib module. Created by
 * `activate()`, never at module scope — modules under lib/ survive a reload
 * (loader.ts:29-30 busts index.js only), so all state must live here.
 *
 * @typedef {object} Runtime
 * @property {SwarmPluginApi} api
 * @property {import('@swarm-os/plugin-sdk').Logger} log
 * @property {NovelAiConfig} cfg
 * @property {any} client                 NovelAI HTTP client (lib/nai.js)
 * @property {SafeKv} kv
 * @property {string} guide               agent-assets/GUIDE.md, read once at activation
 * @property {string|null} guidePath      same file, resolved in the AGENT's namespace
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
 * able to produce `requestTimeoutSec: 0` (every call would abort instantly).
 *
 * @param {SwarmPluginApi} api
 * @returns {NovelAiConfig}
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
  /** @param {string} k @param {string[]} allowed @param {string} d @returns {string} */
  const oneOf = (k, allowed, d) => {
    const v = str(k, d);
    return allowed.includes(v) ? v : d;
  };
  /** @param {number} n @param {number} lo @param {number} hi @returns {number} */
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  return {
    apiToken: str('apiToken', ''),
    // FREE STRING, not a closed list. NovelAI adds models on its own schedule
    // (xialong-v1, glm-4-6 postdate this plugin) and an allowlist did not merely
    // hide them — `oneOf` silently rewrote an unknown value back to the default,
    // so an operator who typed a valid new model got Erato with no error at all.
    // An unknown id is now sent as typed; `surfaceFor` routes it and NovelAI's
    // own 400 says so if it does not exist.
    textModel: str('textModel', 'llama-3-erato-v1'),
    defaultVoice: str('defaultVoice', 'Aini'),
    defaultMaxLength: Math.trunc(clamp(num('defaultMaxLength', 150), 1, 300)),
    defaultTemperature: clamp(num('defaultTemperature', 1.0), 0.1, 3),
    outputDir: str('outputDir', 'novelai'),
    ttsFormat: oneOf('ttsFormat', TTS_FORMATS, 'opus'),
    retentionDays: Math.max(0, Math.trunc(num('retentionDays', 7))),
    requestTimeoutSec: clamp(num('requestTimeoutSec', 45), 5, 300),
  };
}

/**
 * Wrap `api.storage.kv` so a missing `db-kv` grant degrades to a no-op. Every
 * consumer (the retention throttle, the notification anti-spam) is a
 * nice-to-have; none of them may take down a generation. `api.ts:226-241` throws
 * on each accessor when the capability was not granted.
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
 * Read a `code` off a mapped error — the client may either RETURN `{ok:false,
 * code}` or REJECT with an error carrying `.code`; both are handled so this
 * probe cannot become the reason a reload breaks.
 *
 * @param {unknown} x
 * @returns {string|null}
 */
function errCode(x) {
  if (!x || typeof x !== 'object') return null;
  const c = /** @type {any} */ (x).code;
  return typeof c === 'string' ? c : null;
}

/**
 * Daily probe (04:00). Two independent clocks, because they fail independently:
 *
 *  1. LOCAL check of the JWT `exp` — zero network, zero dependency, works even
 *     when NovelAI is down, and gives a real 3-day notice. `GET /user/subscription`
 *     would be the wrong oracle: it carries the SUBSCRIPTION deadline, not the
 *     token's, and would answer "all good" in precisely the case to catch.
 *  2. ACTIVE probe of `POST /ai/generate` with `max_length: 1` — probing the very
 *     endpoint the tools use covers four regressions instead of one (401 expired
 *     token, 402 lapsed subscription, 400 deprecated model, broken `use_string`).
 *     Costs no Anlas.
 *
 * Never throws: it runs inside a host-guarded cron callback.
 *
 * @param {Runtime} rt
 * @returns {Promise<void>}
 */
async function probeDaily(rt) {
  try {
    const expMs = jwtExpMs(rt.cfg.apiToken);
    if (expMs !== null) {
      const left = expMs - Date.now();
      if (left <= EXPIRY_WARN_MS) {
        const days = Math.max(0, Math.floor(left / (24 * 60 * 60 * 1000)));
        notifyOnce(rt, 'token_expiry', {
          title: 'NovelAI: token bientot expire',
          level: 'warn',
          message:
            left <= 0
              ? "Le token persistant NovelAI a EXPIRE. Regenerer un token dans les reglages du compte NovelAI (Account -> Get Persistent API Token) puis le coller dans la config du plugin novelai."
              : `Le token persistant NovelAI expire dans ${days} jour(s), le ${new Date(expMs).toISOString()}. Les tokens persistants durent 30 jours: en regenerer un dans les reglages du compte NovelAI puis le coller dans la config du plugin novelai.`,
        });
      }
    }

    if (!rt.cfg.apiToken || !rt.client) return;

    /** @type {string|null} */
    let code = null;
    let detail = '';
    try {
      const res = await rt.client.generateText({ input: '.', parameters: { max_length: 1 } });
      if (res && res.ok === false) {
        code = errCode(res);
        detail = String(/** @type {any} */ (res).error ?? '');
      }
    } catch (err) {
      code = errCode(err) || 'upstream';
      detail = err instanceof Error ? err.message : String(err);
    }
    if (!code) return;

    // Same record shape as `recordLastError` in lib/tools.js, so `/status`
    // renders a probe failure exactly like a tool failure. Without this the
    // 04:00 cron would notify the operator about a 401 and `/status` — the
    // first place they look afterwards — would show nothing at all.
    try {
      rt.kv.set(
        'last_error',
        JSON.stringify({
          at: new Date().toISOString(),
          tool: 'probe',
          code,
          error: detail.slice(0, 300),
        }),
      );
    } catch {
      // Diagnostics are never worth failing the probe for.
    }

    if (code === 'unauthorized') {
      notifyOnce(rt, 'unauthorized', {
        title: 'NovelAI: token refuse',
        level: 'warn',
        message: `La sonde quotidienne recoit un 401 de NovelAI: token invalide ou expire. Les tokens persistants durent 30 jours: en regenerer un dans les reglages du compte puis le coller dans la config du plugin novelai. Detail: ${detail.slice(0, 300)}`,
      });
    } else if (code === 'payment_required') {
      notifyOnce(rt, 'payment_required', {
        title: 'NovelAI: abonnement requis',
        level: 'warn',
        message: `La sonde quotidienne recoit un 402 de NovelAI: abonnement absent ou expire. Les outils novelai resteront en echec tant que le compte n'est pas actif. Detail: ${detail.slice(0, 300)}`,
      });
    } else {
      rt.log.warn(
        { event: 'novelai.probe_failed', code },
        'novelai: sonde quotidienne en echec (pas de notification, cause non actionnable)',
      );
    }
  } catch (err) {
    rt.log.warn({ event: 'novelai.probe_error', error: String(err) }, 'novelai: sonde quotidienne interrompue');
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
      dispose: [],
    };
    runtime = rt;

    // Factory, not module state: the client must be rebuilt on every activation
    // (lib/ modules are NOT re-imported after a reload).
    rt.client = createNaiClient({
      apiToken: cfg.apiToken,
      timeoutMs: cfg.requestTimeoutSec * 1000,
      log: api.log,
    });

    // The reason this plugin exists — registered FIRST, before anything that can
    // throw. Their Disposables are already tracked by the host's store
    // (api.ts registerTool -> disposables.add), so they are not pushed here.
    api.mcp.registerTool(buildTextToolDef(rt));
    api.mcp.registerTool(buildVoiceToolDef(rt));
    // Cheap in context (no parameters, three lines of schema) and the only thing
    // that makes the method discoverable — generate_text's description points at
    // it by name.
    api.mcp.registerTool(buildGuideToolDef(rt));

    // Operator diagnostic. Optional: never let it take the tools down.
    try {
      api.http.registerRouter(buildStatusRouter(rt));
    } catch (err) {
      api.log.warn(
        { event: 'novelai.no_http', error: String(err) },
        'novelai: route /status non enregistree (capacite http-routes non accordee)',
      );
    }

    // Daily token probe. Optional for the same reason.
    try {
      rt.dispose.push(api.schedule.cron(PROBE_CRON, () => probeDaily(rt)));
    } catch (err) {
      api.log.warn(
        { event: 'novelai.no_schedule', error: String(err) },
        'novelai: sonde quotidienne desactivee (capacite schedule non accordee)',
      );
    }

    // Cheap local diagnostics — CPU only, no network, no notification.
    if (!cfg.apiToken) {
      api.log.warn(
        { event: 'novelai.not_configured' },
        'novelai: apiToken absent — les outils repondront code:not_configured',
      );
    } else {
      const expMs = jwtExpMs(cfg.apiToken);
      if (expMs !== null && expMs - Date.now() <= EXPIRY_WARN_MS) {
        api.log.warn(
          { event: 'novelai.token_expiring', expiresAt: new Date(expMs).toISOString() },
          'novelai: le token persistant expire dans moins de 3 jours',
        );
      }
    }

    api.log.info(
      { event: 'novelai.activated', textModel: cfg.textModel, outputDir: cfg.outputDir },
      'novelai active',
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
        rt.log.warn({ event: 'novelai.dispose_error', error: String(err) }, 'novelai: dispose en echec');
      }
    }
    rt.client = null;
  },
};

export default plugin;

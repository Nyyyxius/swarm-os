// model-lists.js — the plugin keeps its OWN config form up to date.
//
// The five model fields were free text, for a good reason: Google renames and
// retires models every few months, and a list frozen in `plugin.json` is wrong
// within the quarter. But free text has its own cost — the operator types an id
// from a blog post, gets a 404 at the first agent call, and has to go read
// `/status` to find out why.
//
// This module removes the dilemma: the plugin fetches the live model list and
// REWRITES THE `enum` OF ITS OWN MANIFEST, so the fields render as dropdowns
// (`PluginConfigForm.tsx:179-195`) filled with what this key can actually call
// today. The list is never frozen, because nothing here is frozen.
//
// WHY REWRITING THE MANIFEST WORKS, and is not a hack:
//   `GET /plugins/:name` re-reads `plugin.json` FROM DISK on every request
//   (`http/routes/plugins.ts:294-305`) — the manifest is not cached in the
//   database, only `version` and `api_version` are. So the next time the
//   operator opens the plugin page, the form is generated from the new schema.
//   No scan, no reload, no restart. `PUT /plugins/:name/config` re-reads it the
//   same way (`:403`), so validation and rendering never disagree.
//
// FOUR INVARIANTS, each one a bug that would otherwise be silent:
//
//  1. NEVER WRITE AN EMPTY `enum`. The server's `parseConfigSchema` ignores an
//     empty array (`config-schema.ts:66`), but the WEB form does not
//     (`PluginConfigForm.tsx:44-48`): it renders a `<select>` whose only entry
//     is the disabled placeholder, and the field becomes unsettable. When a slot
//     has no candidates, the `enum` is REMOVED and the field goes back to being
//     free text.
//  2. ALWAYS KEEP THE CURRENT VALUE. `validateConfig` enforces the enum
//     (`config-schema.ts:137-142`), so a stored value missing from the new list
//     would make the whole form unsavable — every PUT sends every field. The
//     configured value is therefore always a candidate, even if Google stopped
//     listing it (`/status` still flags it as retired, which is the right place
//     for that warning).
//  3. THE WRITE IS ATOMIC AND VERIFIED. A truncated `plugin.json` is not a
//     cosmetic failure: `loadManifest` would throw, the config form would vanish,
//     the capabilities would read empty and the next enable would fail. So the
//     new manifest is written to a sibling temp file, re-read, re-parsed, and
//     only then renamed over the original.
//  4. FAILING IS ALWAYS AN OPTION. A read-only plugin directory, a missing key,
//     an unreachable API — every one of them leaves the manifest untouched and
//     the fields as free text. Making the directory read-only is therefore a
//     supported way to opt out of this behaviour entirely.
//
// NO MUTABLE MODULE STATE (see the ESM-cache note in lib/gemini.js).

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Config keys that hold a model id, in the order they appear in the form. */
export const MODEL_SLOTS = ['textModel', 'imageModel', 'ttsModel', 'musicModel', 'videoModel'];

/** At most one refresh per this interval, unless forced. */
export const REFRESH_THROTTLE_MS = 10 * 60 * 1000;

/** KV keys: when the last refresh ran, and what it produced (for /status). */
export const REFRESH_KEY = 'models.refreshed_at';
export const REFRESH_SUMMARY_KEY = 'models.enums';

/**
 * Which config slot a model id belongs to — or null when it belongs to none.
 *
 * Matched on the NAME, not on `supportedGenerationMethods`: that field is a
 * relic of the `:generateContent` era and is absent or meaningless for the
 * models served through the Interactions API. The names, by contrast, are
 * rigorously regular — `veo-*`, `lyria-*`, `*-tts*`, `*-image*` — and a model
 * whose name does not match any rule is simply left out of every dropdown
 * rather than dumped into the wrong one.
 *
 * @param {string} name model id WITHOUT the `models/` prefix
 * @returns {string|null}
 */
export function classifyModel(name) {
  const id = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (id === '') return null;

  // A dropdown must offer what THIS PLUGIN can drive, not everything the account
  // can see. Two families are served by Google but not by the tools here:
  //   - `*-realtime*` / `*-live*` speak a bidirectional WebSocket protocol,
  //     while every tool in this plugin is one request / one response;
  //   - `imagen-*` answers on `:predict`, not on `/v1beta/interactions`.
  // Offering either would let an operator select a model that can only ever
  // fail — the exact mistake the dropdown exists to prevent.
  if (/realtime|(^|-)live(-|$)/.test(id)) return null;
  if (/^imagen-/.test(id)) return null;

  if (/^veo-/.test(id)) return 'videoModel';
  if (/^lyria/.test(id)) return 'musicModel';
  // TTS before image and text: `gemini-3.1-flash-tts-preview` matches the
  // `gemini-` family too, and the most specific rule has to win.
  if (/(^|-)tts(-|$)/.test(id)) return 'ttsModel';
  if (/(^|-)image(-|$)/.test(id)) return 'imageModel';

  // Text/multimodal is what is LEFT of the families that answer a plain prompt.
  // The exclusions are models that would 400 the moment an agent used them for
  // text: embeddings return vectors, live/native-audio speak a bidirectional
  // streaming protocol, computer-use drives a browser, aqa answers only with
  // grounded attribution.
  if (/embed|aqa|-live-|native-audio|computer-use|guard/.test(id)) return null;
  if (/^gemini-/.test(id) || /^gemma-/.test(id) || /^learnlm-/.test(id)) return 'textModel';
  return null;
}

/**
 * Order a dropdown the way an operator reads one: the flagship family first,
 * newest first inside it.
 *
 * Descending lexicographic order does the second half for free — Google's naming
 * puts `gemini-3.7-flash` above `gemini-3.5-flash` above `gemini-2.5-flash`. It
 * does NOT do the first half: `gemma-` sorts above `gemini-` on the letter `m`,
 * which would hand the top of the text dropdown to a Gemma model. Hence an
 * explicit family rank, with everything unrecognised after the Gemini line.
 *
 * @param {string[]} names
 * @returns {string[]}
 */
function sortForDropdown(names) {
  const rank = (n) => (/^gemini-/i.test(n) ? 0 : /^(veo|lyria)-/i.test(n) ? 1 : 2);
  return [...names].sort((a, b) => rank(a) - rank(b) || b.localeCompare(a, 'en'));
}

/**
 * Candidate lists per slot, built from the live model list.
 *
 * @param {string[]} liveNames ids returned by `GET /v1beta/models`
 * @param {Record<string, string>} [current] configured value per slot — always kept
 * @returns {Record<string, string[]>} slot -> candidates (a slot with none is absent)
 */
export function buildEnums(liveNames, current = {}) {
  /** @type {Record<string, Set<string>>} */
  const buckets = {};
  for (const raw of Array.isArray(liveNames) ? liveNames : []) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name === '') continue;
    const slot = classifyModel(name);
    if (!slot) continue;
    (buckets[slot] ??= new Set()).add(name);
  }

  /** @type {Record<string, string[]>} */
  const out = {};
  for (const slot of MODEL_SLOTS) {
    const set = buckets[slot];
    // Invariant 1: no candidates -> NO enum at all (the caller removes it), so
    // the field falls back to free text instead of becoming unsettable.
    if (!set || set.size === 0) continue;
    // Invariant 2: the configured value is always selectable, retired or not.
    const configured = typeof current[slot] === 'string' ? current[slot].trim() : '';
    if (configured !== '') set.add(configured);
    out[slot] = sortForDropdown([...set]);
  }
  return out;
}

/**
 * Apply `enums` to a parsed manifest, in place. Pure bookkeeping — no I/O — so
 * the decision "did anything actually change?" is testable on its own.
 *
 * @param {any} manifest parsed `plugin.json`
 * @param {Record<string, string[]>} enums
 * @returns {{changed: boolean, applied: string[], cleared: string[]}}
 */
export function applyEnums(manifest, enums) {
  const props = manifest?.configSchema?.properties;
  const applied = [];
  const cleared = [];
  if (!props || typeof props !== 'object') return { changed: false, applied, cleared };

  for (const slot of MODEL_SLOTS) {
    const prop = props[slot];
    if (!prop || typeof prop !== 'object') continue;
    const next = enums[slot];

    if (!Array.isArray(next) || next.length === 0) {
      if (Array.isArray(prop.enum)) {
        delete prop.enum;
        cleared.push(slot);
      }
      continue;
    }
    const before = Array.isArray(prop.enum) ? prop.enum : null;
    if (before && before.length === next.length && before.every((v, i) => v === next[i])) continue;
    prop.enum = next;
    applied.push(slot);
  }
  return { changed: applied.length > 0 || cleared.length > 0, applied, cleared };
}

/**
 * Write the manifest back, atomically and only after proving it still parses.
 *
 * `rename` within the same directory is atomic on every filesystem swarm-os
 * runs on, so a reader either sees the whole old file or the whole new one —
 * never a half-written one. Since `GET /plugins/:name` reads this file on every
 * request, "never half-written" is not a theoretical nicety.
 *
 * @param {string} manifestPath
 * @param {any} manifest
 * @returns {Promise<void>}
 */
export async function writeManifestAtomic(manifestPath, manifest) {
  const dir = path.dirname(manifestPath);
  // Unique per CALL, not per process: two forced refreshes (the daily cron and
  // an operator hitting `?refresh=models`) bypass the throttle by design, and a
  // shared temp path would let one read back the other's half-written bytes.
  // They would abort safely — the verify step catches it — but a refresh that
  // skips itself for no reason is a bug report waiting to happen.
  const tmp = path.join(dir, `.plugin.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  try {
    await fs.writeFile(tmp, text, 'utf8');
    // Re-read rather than trust the write: a full disk fails at close, not at
    // write, and a truncated manifest would take the whole plugin down.
    const back = await fs.readFile(tmp, 'utf8');
    const parsed = JSON.parse(back);
    if (!parsed || parsed.name !== manifest.name) throw new Error('relecture incoherente');
    await fs.rename(tmp, manifestPath);
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {
      // Never created, or already gone.
    }
    throw err;
  }
}

/**
 * Fetch the live model list and refresh the manifest's dropdowns.
 *
 * Never throws: it is called from a cron callback, from an HTTP route and from
 * an MCP handler, and none of the three may be taken down by a read-only
 * filesystem.
 *
 * @param {import('../index.js').Runtime} rt
 * @param {{force?: boolean, liveNames?: string[]}} [opts] `force` bypasses the
 *   throttle; `liveNames` reuses a list the caller already fetched (the /status
 *   route holds one) instead of paying for a second round trip.
 * @returns {Promise<{ok: boolean, changed?: boolean, slots?: Record<string, number>, skipped?: string, error?: string}>}
 */
export async function refreshModelEnums(rt, opts = {}) {
  try {
    if (!rt || !rt.manifestPath) return { ok: false, skipped: 'no_manifest_path' };
    if (!rt.cfg.apiKey || !rt.client) return { ok: false, skipped: 'not_configured' };

    if (!opts.force) {
      const last = Number(rt.kv.get(REFRESH_KEY) || '0') || 0;
      if (last && Date.now() - last < REFRESH_THROTTLE_MS) return { ok: true, skipped: 'throttled' };
    }
    // Claim the slot BEFORE the call: three call sites can fire at once (the
    // cron, the /status route, an agent's list_models).
    rt.kv.set(REFRESH_KEY, String(Date.now()));

    /** @type {string[]} */
    let names;
    if (Array.isArray(opts.liveNames)) {
      names = opts.liveNames;
    } else {
      const listed = await rt.client.listModels();
      if (!listed || listed.ok !== true) {
        return { ok: false, skipped: 'unavailable', error: listed && listed.error ? String(listed.error) : 'liste indisponible' };
      }
      names = listed.models.map((m) => m.name);
    }
    if (names.length === 0) {
      // An empty list is NOT a reason to clear every dropdown: it almost always
      // means the call failed in a way that still parsed. Leave the manifest be.
      return { ok: false, skipped: 'empty_list' };
    }

    const current = {};
    for (const slot of MODEL_SLOTS) current[slot] = rt.cfg[slot];
    const enums = buildEnums(names, current);

    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(rt.manifestPath, 'utf8'));
    } catch (err) {
      return { ok: false, skipped: 'unreadable', error: String(err) };
    }

    const { changed, applied, cleared } = applyEnums(manifest, enums);
    /** @type {Record<string, number>} */
    const slots = {};
    for (const slot of MODEL_SLOTS) slots[slot] = enums[slot] ? enums[slot].length : 0;

    if (changed) {
      try {
        await writeManifestAtomic(rt.manifestPath, manifest);
      } catch (err) {
        // The commonest cause is a read-only plugin directory, which is a
        // legitimate operator choice — say so once, at warn level, and leave the
        // fields as free text.
        rt.log.warn(
          { event: 'gemini.manifest_write_failed', error: String(err), path: rt.manifestPath },
          'gemini-api: manifeste non modifiable (repertoire en lecture seule ?) — les modeles restent en champ libre',
        );
        return { ok: false, skipped: 'read_only', error: String(err) };
      }
      rt.log.info(
        { event: 'gemini.model_enums_updated', applied, cleared, slots },
        'gemini-api: listes de modeles mises a jour dans le formulaire de configuration',
      );
    }

    rt.kv.set(REFRESH_SUMMARY_KEY, JSON.stringify({ at: new Date().toISOString(), slots }));
    return { ok: true, changed, slots };
  } catch (err) {
    rt?.log?.warn?.({ event: 'gemini.model_refresh_error', error: String(err) }, 'gemini-api: rafraichissement des modeles interrompu');
    return { ok: false, skipped: 'internal', error: String(err) };
  }
}

/**
 * `pnpm models:sync` — refresh the PINNED model arrays from models.dev and from
 * the host's codex cache, in place, so a release ships a floor that is current.
 *
 * WHY THIS EXISTS ALONGSIDE THE RUNTIME CACHE. `providers/catalogue.ts` keeps a
 * running instance current between releases; this keeps the floor current AT
 * each release. They are not redundant — the floor is what an air-gapped
 * deployment, a `SWARM_OS_MODEL_CATALOGUE_URL=off` instance, and every unit test
 * actually see, and a floor nobody refreshes is exactly how `claude.ts` came to
 * offer `claude-sonnet-4-6` months after `claude-sonnet-5` shipped.
 *
 * IT IMPORTS THE FILTERS, it does not reimplement them. Two copies of
 * "which models does gemini offer" is two answers by the second release, and
 * the one in the script is the one nobody would notice going wrong.
 *
 * Run it, then READ THE DIFF. This rewrites source files: it is a drafting tool
 * for a human, not an automation. Nothing here runs in production.
 *
 *   pnpm models:sync            # rewrite in place
 *   pnpm models:sync --check    # exit 1 if anything WOULD change (CI-friendly)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveCatalogue,
  deriveCodexCatalogue,
  MODEL_CATALOGUE_URL,
  type ProviderCatalogueView,
} from '../packages/server/src/modules/providers/catalogue.js';
import type { BuiltinProviderId } from '../packages/server/src/modules/providers/ids.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROVIDERS_DIR = path.join(REPO_ROOT, 'packages/server/src/modules/providers');

/** Where each provider's pinned array lives, and what the binding is called. */
const PINNED_ARRAYS: Record<BuiltinProviderId, { file: string; symbol: string }> = {
  claude: { file: 'claude.ts', symbol: 'CLAUDE_MODELS' },
  codex: { file: 'codex.ts', symbol: 'CODEX_MODELS' },
  gemini: { file: 'gemini.ts', symbol: 'GEMINI_MODELS' },
  opencode: { file: 'opencode.ts', symbol: 'OPENCODE_PINNED_MODELS' },
};

/**
 * Cap on the opencode floor, per allow-listed vendor.
 *
 * The live list is ~200 OpenRouter slugs; pinning all of them would add 200
 * lines to `opencode.ts` and make every future diff of that file unreadable,
 * to buy offline discovery of models nobody picked. Three per vendor keeps the
 * vendor SPREAD — which is the thing an operator would otherwise lose entirely
 * offline — at a size a human can review. The other three providers are already
 * small enough (5 / 11 / 14) to pin whole.
 */
const OPENCODE_PINS_PER_VENDOR = 3;

/**
 * Pinned labels carry NO price.
 *
 * The live label does (`Opus 5 (claude-opus-5) · $5/$25`) and should: it is read
 * off the payload at the moment it is shown. A price frozen into source is a
 * number that keeps being displayed as fact long after it stopped being true,
 * and vendors re-price far more often than they rename.
 */
function stripPrice(label: string): string {
  const at = label.indexOf(' · $');
  return at === -1 ? label : label.slice(0, at);
}

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function renderArray(models: readonly { value: string; label: string }[]): string {
  return models
    .map((m) => `  { value: '${esc(m.value)}', label: '${esc(stripPrice(m.label))}' },`)
    .join('\n');
}

/** Newest `perVendor` entries of each `<vendor>/<model>` group, order preserved. */
function capPerVendor(
  models: readonly { value: string; label: string }[],
  perVendor: number,
): Array<{ value: string; label: string }> {
  const seen = new Map<string, number>();
  const out: Array<{ value: string; label: string }> = [];
  for (const m of models) {
    const vendor = m.value.split('/')[0] ?? '';
    const n = seen.get(vendor) ?? 0;
    if (n >= perVendor) continue;
    seen.set(vendor, n + 1);
    out.push(m);
  }
  return out;
}

/**
 * Replace the body of `const <symbol>: readonly ProviderModel[] = [ … ];`.
 *
 * Anchored on the declaration and on a `];` at column 0 — the array is
 * top-level, so its closing bracket is the first one that can appear unindented.
 * A miss THROWS rather than writing a mangled file: this edits source, and a
 * silent partial rewrite is far worse than a failed run.
 */
function replaceArray(source: string, symbol: string, body: string): string {
  const head = `const ${symbol}: readonly ProviderModel[] = [\n`;
  const start = source.indexOf(head);
  if (start === -1) throw new Error(`could not find \`${symbol}\` declaration`);
  const bodyStart = start + head.length;
  const end = source.indexOf('\n];', bodyStart);
  if (end === -1) throw new Error(`could not find the end of \`${symbol}\``);
  return source.slice(0, bodyStart) + body + source.slice(end);
}

/** Replace one entry of `BUILTIN_PROVIDER_DEFAULT_MODELS`. */
function replacePin(source: string, provider: BuiltinProviderId, model: string): string {
  const re = new RegExp(`(\\n  ${provider}: )'[^']*'(,)`);
  if (!re.test(source)) throw new Error(`could not find the \`${provider}\` pin in ids.ts`);
  return source.replace(re, `$1'${esc(model)}'$2`);
}

async function fetchPayload(): Promise<unknown> {
  const res = await fetch(MODEL_CATALOGUE_URL, {
    headers: { Accept: 'application/json', 'User-Agent': 'swarm-os' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${MODEL_CATALOGUE_URL} answered HTTP ${res.status}`);
  return await res.json();
}

/**
 * The codex cache on THIS machine.
 *
 * Not a network source and not optional-with-a-fallback: models.dev cannot
 * answer for codex at all (see `deriveCodexCatalogue`), so if the file is not
 * here the honest outcome is to leave codex's pins untouched and say so.
 */
function readCodexCache(): unknown | null {
  const file = path.join(
    process.env.SWARM_OS_HOST_CODEX_DIR ?? path.join(os.homedir(), '.codex'),
    'models_cache.json',
  );
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    console.warn(`! ${file} is not readable — codex pins left untouched`);
    return null;
  }
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check');
  const [payload, codexRaw] = [await fetchPayload(), readCodexCache()];

  const views: Partial<Record<BuiltinProviderId, ProviderCatalogueView>> =
    deriveCatalogue(payload);
  if (codexRaw !== null) {
    const codex = deriveCodexCatalogue(codexRaw);
    if (codex) views.codex = codex;
  }

  const edits = new Map<string, string>();
  const read = (file: string): string =>
    edits.get(file) ?? fs.readFileSync(path.join(PROVIDERS_DIR, file), 'utf8');

  let changed = 0;
  for (const [id, view] of Object.entries(views) as Array<
    [BuiltinProviderId, ProviderCatalogueView]
  >) {
    const target = PINNED_ARRAYS[id];
    const models =
      id === 'opencode' ? capPerVendor(view.models, OPENCODE_PINS_PER_VENDOR) : view.models;

    const before = read(target.file);
    const after = replaceArray(before, target.symbol, renderArray(models));
    if (after !== before) changed += 1;
    edits.set(target.file, after);
    console.log(`${id.padEnd(9)} ${models.length} models  default=${view.familyDefault ?? '(unchanged)'}`);

    if (view.familyDefault) {
      const ids = read('ids.ts');
      const next = replacePin(ids, id, view.familyDefault);
      if (next !== ids) changed += 1;
      edits.set('ids.ts', next);
    }
  }

  if (changed === 0) {
    console.log('\nnothing to do — the pins are already current');
    return;
  }
  if (checkOnly) {
    console.error(`\n${changed} file section(s) are out of date — run \`pnpm models:sync\``);
    process.exitCode = 1;
    return;
  }
  for (const [file, content] of edits) {
    fs.writeFileSync(path.join(PROVIDERS_DIR, file), content);
    console.log(`wrote ${file}`);
  }
  console.log('\nnow READ THE DIFF — this rewrote source files.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

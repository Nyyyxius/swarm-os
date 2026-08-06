/**
 * The single "should I walk into this directory?" predicate for codegraph.
 *
 * WHY this file exists: `IGNORED_DIR_NAMES` was consumed by exact name equality
 * (`set.has(ent.name)`) in the walk and in discovery. Exact equality is a
 * guess-from-the-name heuristic, and it broke in production: the `trader`
 * deployment keeps its Python virtualenv in `.venv-intraday`, which matches no
 * entry of the set. Discovery promoted it to a full-blown codegraph scope,
 * graphify tried to index it (`codegraph.graphify run_failed, sourceDir:
 * /workspace/.venv-intraday`) and 656 third-party dependency dirs were watched
 * and offered for indexing. Same hole for `venv312`, `venv_old`, `.venv2`.
 *
 * The fix has two layers, in order of cost:
 *   1. NAME matching — the exact set, PLUS a few tightly anchored patterns for
 *      the families that are routinely suffixed (hidden virtualenvs) or
 *      versioned (`venv312`). Pure, no I/O, the cheap first pass. It is
 *      deliberately the WEAKER layer: it only has to catch what costs nothing
 *      to catch, because guessing from a name is how we got here.
 *   2. STRUCTURAL detection — a directory holding a `pyvenv.cfg` at its root IS
 *      a virtualenv, by PEP 405, whatever it is called. This is the real
 *      upstream correction, and the load-bearing one: we stop inferring from the
 *      name and read the normative marker the tool itself writes. It costs one
 *      `existsSync` per directory, so it runs only after the name pass has
 *      failed to decide. Verified on the incident directory itself — the
 *      production `.venv-intraday` does contain `pyvenv.cfg` — which is why
 *      layer 1 can afford to be strict.
 *
 * Bias: a FALSE POSITIVE deletes real first-party code from the graph, which is
 * silent and far worse than a false negative (a dependency tree we index and
 * later notice). Every pattern below is therefore anchored so it cannot swallow
 * a plausible package name — `venvutils`, `venv-manager` and `venv_utils` are
 * all perfectly ordinary library names and MUST stay in the graph.
 *
 * Best-effort like the rest of the subsystem: nothing here ever throws.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { IGNORED_DIR_NAMES } from './constants.js';

/**
 * Anchored variants of dependency / virtualenv dir names.
 *
 * The anchor is what makes these safe, and it is DELIBERATELY ASYMMETRIC — a
 * leading dot changes what a suffix can mean:
 *
 *   - DOT-PREFIXED (`.venv-intraday`, `.venv2`, `.venv.bak`) is a tooling
 *     convention. A dot-directory is hidden; no first-party package is ever
 *     published or checked out under a hidden name, so after `.venv` we can
 *     safely accept a separator (`-`, `_`, `.`) followed by anything.
 *
 *   - BARE (`venv312`) is an ordinary, visible directory name — i.e. exactly
 *     what a first-party package looks like. There `venv` + separator + word is
 *     a NORMAL package-naming shape: `venv-manager` and `node_modules-path` are
 *     real npm packages, `venv_utils` a real Python one, and in this deployment
 *     a workspace is a directory of cloned repos, so any of them can legitimately
 *     appear as a top-level dir. So after a bare base word we accept ONLY
 *     digits — a version qualifier, which is not a naming shape any package uses.
 *
 * Net effect of layer 1 (exact set + these patterns):
 *   ignored: `.venv` `.venv-intraday` `.venv_old` `.venv2` `.venv.bak`
 *            `venv` `venv312` `node_modules` `node_modules2`
 *            (`venv` and `node_modules` bare come from the exact set)
 *   KEPT:    `venv_utils` `venv-manager` `venv-tools` `venv.d` `venvutils`
 *            `node_modules-path` `node_modulesfoo` `.github` `envoy`
 *
 * Losing `venv_old` / `node_modules.bak` from layer 1 is not a regression we
 * merely tolerate — for virtualenvs it is covered by layer 2, which is strictly
 * better than the name guess: the directory that motivated this whole fix,
 * `/home/ubuntu/projets/trader/v2/.venv-intraday`, was verified in production to
 * contain a `pyvenv.cfg`, so the STRUCTURAL check catches it (and every
 * `venv_old`, `env-prod`, `myproj-py3.11`) on its own. For a parked
 * `node_modules.bak` there is no normative marker, so it becomes an ordinary
 * directory: a false negative (we index a dependency copy, visibly, once) is the
 * cheap side of the trade, versus silently deleting a checkout of
 * `node_modules-path` from the graph.
 *
 * Deliberately NOT covered here:
 *   - bare `env` / `env-prod` — far too common as a real source dir (config,
 *     environment adapters). Layer 2 (`pyvenv.cfg`) catches those when they
 *     really are virtualenvs, which is precisely why layer 2 exists.
 *   - variants of `dist` / `build` / `out` / `.git` — `build-scripts` and
 *     `.github` are first-party code; the exact-name entries stay exact.
 *
 * Case-insensitive: a `.Venv` on a case-preserving mount is the same thing, and
 * the anchor keeps the rule just as tight in either case.
 */
const IGNORED_DIR_PATTERNS: readonly RegExp[] = [
  // Hidden virtualenvs: qualified (`-intraday`, `_old`, `.bak`) or versioned.
  /^\.venv(?:[-_.].*|[0-9].*)?$/i,
  // Visible virtualenvs / dependency trees: version digits ONLY, never a
  // separator + word (that shape belongs to real package names).
  /^venv[0-9]+$/i,
  /^node_modules[0-9]+$/i,
];

/**
 * Layer 1 — is `name` a directory name we never walk into? Exact set first (the
 * common case, one hash lookup), then the anchored patterns. Pure: no I/O, so
 * callers can use it to filter a `readdir` result without paying a stat.
 */
export function isIgnoredDirName(name: string): boolean {
  if (IGNORED_DIR_NAMES.has(name)) return true;
  for (const re of IGNORED_DIR_PATTERNS) {
    if (re.test(name)) return true;
  }
  return false;
}

/**
 * Layer 2 — is `fullPath` a Python virtualenv, judged STRUCTURALLY? PEP 405
 * mandates a `pyvenv.cfg` at the root of every venv (that file is how the
 * interpreter locates its home), so its presence is an exact signal that is
 * completely independent of the directory's name. This catches the venvs the
 * patterns cannot possibly guess: `env-prod`, `myproject-py3.11`, `.direnv`…
 *
 * One `existsSync` per candidate directory — cheap next to the `readdir` the
 * caller already performed, but the reason `shouldSkipDir` only reaches here
 * once the (free) name check has declined to decide.
 *
 * NEVER throws: an unreadable or vanished path is simply "not a virtualenv", so
 * a permission hiccup on one subtree can't take down a janitor tick.
 */
export function isVirtualenvDir(fullPath: string): boolean {
  try {
    return fs.existsSync(path.join(fullPath, 'pyvenv.cfg'));
  } catch {
    return false;
  }
}

/**
 * THE predicate. Every consumer — the C3 detection walk, the source
 * fingerprint, scope discovery and the lifecycle watcher — must go through this
 * one function, so "a dir the gate walks into" stays a single definition rather
 * than four `Set.has` calls drifting apart.
 */
export function shouldSkipDir(fullPath: string, name: string): boolean {
  return isIgnoredDirName(name) || isVirtualenvDir(fullPath);
}

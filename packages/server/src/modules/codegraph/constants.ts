/**
 * Shared constants for the codegraph subsystem.
 *
 * ONE source of truth for "what is code" (the C3 detection gate), "what to
 * skip" (dependency / build dirs) and the exclusion patterns handed to
 * graphify. Keeping them here means the discovery gate, the source-fingerprint
 * hasher and the graphify runner can never drift apart — a dir the gate walks
 * into is the same set of files graphify will graph, and vice-versa.
 */

/**
 * First-party code extensions that make a scope worth indexing (C3). Deliberately
 * broad (graphify parses 40+ languages via tree-sitter) but excludes pure-docs
 * (`.md`, `.txt`) — a docs-only dir must NOT produce a graph (P0 correction c).
 * Lower-cased; compared against the lower-cased file extension.
 */
export const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyi',
  '.rs', '.go', '.java', '.kt', '.kts', '.scala',
  '.rb', '.php', '.swift',
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh',
  '.cs', '.m', '.mm',
  '.lua', '.tf', '.sh', '.bash', '.zsh',
  '.sql', '.pl', '.pm', '.r', '.jl', '.dart', '.ex', '.exs', '.erl', '.hs',
  '.vue', '.svelte',
]);

/**
 * EXACT directory names skipped by BOTH the code-detection walk and the source
 * fingerprint. These are dependency trees, VCS metadata, build output and our
 * own artifacts — never first-party code (constraint C1 "no packages"). The
 * graphify runner ALSO excludes them via the seeded build config, so a walk we
 * skip is a walk graphify skips.
 *
 * This set is the exact-match layer only. Do NOT consume it directly: go through
 * `shouldSkipDir` in `ignore.ts`, which adds the anchored name variants
 * (`.venv-intraday`, `venv312`…) and the structural `pyvenv.cfg` virtualenv
 * check that exact matching by construction cannot cover.
 */
export const IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '.pnpm',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'coverage',
  '.turbo',
  '.cache',
  'graphify-out',
  '.swarm-os',
]);

/**
 * gitignore-syntax patterns written into `<indexDir>/graphify-out/.graphify_build.json`
 * (graphify's persisted `--exclude` store, read by every `update` rebuild). This
 * is how C1 "no packages" is materialised WITHOUT writing a `.graphifyignore`
 * into the user's source dir — the source stays pristine (see graphify.ts).
 *
 * PARITY IS THE CONTRACT: this list must exclude the same set as
 * `IGNORED_DIR_NAMES` + `IGNORED_DIR_PATTERNS` (ignore.ts). A name the walk skips
 * but graphify indexes puts third-party code in the graph; a name graphify skips
 * but the walk keeps makes the change-detection fingerprint move for files that
 * can never change the graph (a permanent re-index loop). So the character
 * classes below transcribe the regex anchors literally, including their
 * deliberate asymmetry: dot-prefixed names accept a separator suffix
 * (`.venv[-_.]*`), bare names accept digits only (`venv[0-9]*`) so a
 * first-party `venv-manager/` or `node_modules-path/` checkout stays in the
 * graph. A blanket "venv" + star + slash glob would have excluded those, i.e.
 * traded the bug for silent code loss.
 *
 * Two residual, ACCEPTED divergences — both fail in the harmless direction (the
 * walk is stricter than graphify, so the worst case is graph noise inside an
 * already-legitimate scope, never a bogus scope, and graphify's own
 * `gitignore: true` usually covers both):
 *   1. The structural `pyvenv.cfg` check has no gitignore equivalent, so an
 *      oddly-named venv (`env-prod/`, `venv_old/`) is skipped by the walk yet
 *      still visible to graphify.
 *   2. `IGNORED_DIR_PATTERNS` is case-INSENSITIVE, gitignore globs are not
 *      (graphify has no equivalent of git's `core.ignorecase`). So a `.Venv-x/`
 *      on a case-preserving mount is skipped by the walk and indexed by
 *      graphify. Encoding the 16 casings of `venv` as character classes would
 *      make this list unreadable to buy a case nobody has ever produced —
 *      virtualenv, npm and pip all create these directories lower-cased.
 */
export const DEFAULT_GRAPHIFY_EXCLUDES: readonly string[] = [
  'node_modules/',
  'node_modules[0-9]*/',
  '.pnpm/',
  'vendor/',
  '.venv/',
  '.venv[-_.]*/',
  '.venv[0-9]*/',
  'venv/',
  'venv[0-9]*/',
  '__pycache__/',
  '.git/',
  '.hg/',
  '.svn/',
  'dist/',
  'build/',
  'out/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  'coverage/',
  '.turbo/',
  '.cache/',
  '*.lock',
  '.env*',
  'graphify-out/',
  '.swarm-os/',
];

/**
 * Hard cap on files visited by a single code-detection / fingerprint walk. A
 * runaway tree (millions of files) must never pin a janitor tick; hitting the
 * cap simply ends the walk early with whatever was gathered so far.
 */
export const MAX_WALK_FILES = 200_000;

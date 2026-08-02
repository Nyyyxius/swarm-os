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
 * Directory names skipped by BOTH the code-detection walk and the source
 * fingerprint. These are dependency trees, VCS metadata, build output and our
 * own artifacts — never first-party code (constraint C1 "no packages"). The
 * graphify runner ALSO excludes them via the seeded build config, so a walk we
 * skip is a walk graphify skips.
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
 */
export const DEFAULT_GRAPHIFY_EXCLUDES: readonly string[] = [
  'node_modules/',
  '.pnpm/',
  'vendor/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.git/',
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

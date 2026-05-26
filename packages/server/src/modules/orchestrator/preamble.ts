import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Per-session preamble builder (plan §11).
 *
 * The default texts live as Markdown next to this file under `../preambles/`
 * so they can be edited as plain documentation rather than as JS string
 * literals. They are loaded ONCE at module import via `fs.readFileSync` and
 * memoized — they are static for the lifetime of the process.
 *
 * `buildPreamble` substitutes the `{{var}}` placeholders, then concatenates
 * the orchestrator-level override (if provided). The override is appended
 * AFTER the default so per-orchestrator instructions can refine without
 * losing the canonical mailbox-discipline language.
 */

// In ESM, __dirname is not defined; derive from import.meta.url.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve the markdown sources at module load time. `tsx` runs straight
// from src/, `tsc` compiles to dist/ but the relative layout under
// `modules/preambles/` is identical in both — so this single path works
// for dev (`pnpm dev`) and prod (`node dist/index.js`).
const PREAMBLES_DIR = path.resolve(__dirname, '..', 'preambles');

let cachedLeadDefault: string | null = null;
let cachedWorkerDefault: string | null = null;

function loadDefault(file: string): string {
  const full = path.join(PREAMBLES_DIR, file);
  try {
    return fs.readFileSync(full, 'utf8');
  } catch (err) {
    // The file is shipped with the build; if it's missing, that's a packaging
    // bug. Throw loudly at first call rather than silently degrading the
    // worker's discipline.
    throw new Error(
      `failed to load default preamble at ${full}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function getLeadDefault(): string {
  if (cachedLeadDefault === null) cachedLeadDefault = loadDefault('default-lead.md');
  return cachedLeadDefault;
}

function getWorkerDefault(): string {
  if (cachedWorkerDefault === null) cachedWorkerDefault = loadDefault('default-worker.md');
  return cachedWorkerDefault;
}

export interface BuildPreambleInput {
  /** Identity slot — substituted into `{{name}}`/`{{role}}`/`{{sessionId}}`/`{{orchName}}`. */
  identity: {
    name: string;
    role: string;
    sessionId: string;
    orchName: string;
  };
  /** Whether this session is the lead. Selects the lead vs worker default. */
  isLead: boolean;
  /**
   * Optional orchestrator-level override text. Appended AFTER the default —
   * `null`/`undefined`/empty string means "no override". A non-empty value
   * is treated as additional instructions, not a replacement, so the
   * mailbox-discipline language always survives.
   */
  customOverride?: string | null;
  /**
   * Phase 8 — auto-resume only. When the orchestrator is being respawned
   * after a server restart, this block is appended at the very end of the
   * preamble so the agent sees a defensive "## Server restart notice"
   * (with a tail of the previous PTY log) right before its replayed
   * initial prompt. Empty/null/undefined = no notice = normal first-spawn
   * preamble.
   */
  resumeNotice?: string | null;
}

/**
 * Produce the system-prompt-ready preamble for a session.
 *
 * The output is the loaded default (with `{{var}}` placeholders filled),
 * optionally followed by the orchestrator-level override prefixed with a
 * separator so the agent can tell where the project-specific instructions
 * begin.
 */
export function buildPreamble(input: BuildPreambleInput): string {
  const base = input.isLead ? getLeadDefault() : getWorkerDefault();
  const filled = base
    .replace(/\{\{name\}\}/g, input.identity.name)
    .replace(/\{\{role\}\}/g, input.identity.role)
    .replace(/\{\{sessionId\}\}/g, input.identity.sessionId)
    .replace(/\{\{orchName\}\}/g, input.identity.orchName);

  const override = input.customOverride?.trim();
  let out = filled;
  if (override) {
    out = `${out}\n\n---\n\n## Project-specific instructions\n\n${override}\n`;
  }

  // Phase 8 — resume notice goes LAST so it sits just before the initial
  // prompt the CLI receives via argv. Operators / agents see it first
  // every time the team is auto-resumed.
  const notice = input.resumeNotice?.trim();
  if (notice) {
    out = `${out}\n\n${notice}\n`;
  }

  return out;
}

/** Test-only — drop the cached defaults so a test can swap the files on disk. */
export function _resetPreambleCacheForTesting(): void {
  cachedLeadDefault = null;
  cachedWorkerDefault = null;
}

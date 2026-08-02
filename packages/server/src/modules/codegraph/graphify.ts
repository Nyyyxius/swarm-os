/**
 * graphify CLI runner + presence probe.
 *
 * ── Output redirection (STEP 0, proven empirically against graphify 0.9.32) ──
 * `graphify update <src>` writes its `graphify-out/` INTO `<src>` by default —
 * unacceptable, since a workspace project may be the user's own git repo. Two
 * graphify internals let us keep the source dir 100% pristine:
 *   1. `GRAPHIFY_OUT=<abs>` (env, issue #686 "shared-output setups") redirects
 *      the ENTIRE `graphify-out/` tree to an absolute path we own.
 *   2. graphify reads persisted excludes from `<GRAPHIFY_OUT>/.graphify_build.json`
 *      (`{excludes, gitignore}`) on every `update`. Seeding that file gives us
 *      the C1 "no packages" exclusion WITHOUT writing a `.graphifyignore` into
 *      the source tree.
 * Net effect: we write NOTHING into the source dir; all state (graph.json,
 * report, incremental `cache/`) lives under `<dataDir>/codegraph/<id>/graphify-out/`.
 *
 * Execution is modelled on `plugins/installer.ts:run` — `execFile` (never a
 * shell → no injection), explicit env, hard `timeout`, bounded `maxBuffer`. The
 * runner NEVER throws: failures come back as `{ ok:false, error }` so a bad run
 * records `last_error` on the scope instead of crashing the janitor.
 */

import { execFile } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withModule } from '../../logger.js';
import { DEFAULT_GRAPHIFY_EXCLUDES } from './constants.js';

const log = withModule('codegraph.graphify');

/** Cap on captured CLI output (graphify is chatty on a big rebuild). */
const MAX_BUFFER = 32 * 1024 * 1024;
const STDERR_MAX = 2000;

export type CodegraphEngine = 'ast' | 'extract';

export interface GraphifyAvailability {
  available: boolean;
  version?: string;
  reason?: string;
}

/**
 * Presence probe — `spawnSync(bin, ['--version'])` in OUR namespace, mirroring
 * `providers/probe.ts`. Never throws; a miss is `{ available:false, reason }`.
 */
export function probeGraphify(bin: string, timeoutMs = 5000): GraphifyAvailability {
  try {
    const res = spawnSync(bin, ['--version'], {
      timeout: timeoutMs,
      encoding: 'utf8',
      windowsHide: true,
      env: withGraphifyPath(process.env),
    });
    if (res.error) {
      const code = (res.error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { available: false, reason: `\`${bin}\` is not on PATH` };
      }
      return { available: false, reason: `${bin}: ${res.error.message}` };
    }
    if (res.status !== 0) {
      const detail = firstLine(res.stderr) ?? firstLine(res.stdout) ?? `exit ${res.status}`;
      return { available: false, reason: `\`${bin}\` not usable: ${detail}` };
    }
    const version = firstLine(res.stdout) ?? firstLine(res.stderr);
    return version ? { available: true, version } : { available: true };
  } catch (err) {
    return { available: false, reason: `probe failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface RunUpdateInput {
  bin: string;
  /** Absolute source dir to index (stays untouched). */
  sourceDir: string;
  /** Absolute per-scope index dir; output lands in `<indexDir>/graphify-out/`. */
  indexDir: string;
  engine: CodegraphEngine;
  timeoutMs: number;
}

export type RunUpdateResult =
  | { ok: true; nodeCount: number; edgeCount: number }
  | { ok: false; error: string; timedOut?: boolean };

/**
 * Run one incremental graphify build for a scope. Assumes the CALLER has already
 * decided the source changed (we never sweep blindly — a no-change `update`
 * still costs seconds, P0). Ensures the index dir + seeded build config exist,
 * runs the CLI with `GRAPHIFY_OUT` pointed at our dir, and returns parsed
 * node/edge counts. Never throws.
 */
export function runUpdate(input: RunUpdateInput): Promise<RunUpdateResult> {
  const outDir = path.join(input.indexDir, 'graphify-out');
  try {
    fs.mkdirSync(outDir, { recursive: true });
    seedBuildConfig(outDir);
  } catch (err) {
    return Promise.resolve({ ok: false, error: `prepare index dir failed: ${String(err)}` });
  }

  // `extract` (LLM-enriched, needs an API key) is an opt-in stub: we build the
  // argv but it's off by default. Without a key it simply fails and is recorded
  // as `last_error` — never fatal.
  const verb = input.engine === 'extract' ? 'extract' : 'update';
  const args = [verb, input.sourceDir];

  const env: NodeJS.ProcessEnv = withGraphifyPath({
    ...process.env,
    GRAPHIFY_OUT: outDir,
    // Suppress the "set GEMINI_API_KEY" tip line so stdout parsing stays clean.
    GRAPHIFY_NO_TIPS: '1',
  });

  return new Promise<RunUpdateResult>((resolve) => {
    execFile(
      input.bin,
      args,
      { cwd: input.indexDir, env, timeout: input.timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          const timedOut = e.killed === true || e.signal === 'SIGTERM';
          const detail = (String(stderr) || String(stdout) || e.message).trim().slice(-STDERR_MAX);
          log.warn({
            event: 'codegraph.run_failed',
            bin: input.bin,
            sourceDir: input.sourceDir,
            timedOut,
            error: detail,
          });
          resolve({ ok: false, error: detail || 'graphify update failed', timedOut });
          return;
        }
        const counts = parseCounts(String(stdout), outDir);
        resolve({ ok: true, nodeCount: counts.nodeCount, edgeCount: counts.edgeCount });
      },
    );
  });
}

// ---- helpers ---------------------------------------------------------------

/**
 * Merge our canonical excludes into `<outDir>/.graphify_build.json`, preserving
 * any other keys graphify itself wrote there (read-modify-write, best-effort).
 */
function seedBuildConfig(outDir: string): void {
  const file = path.join(outDir, '.graphify_build.json');
  let cfg: Record<string, unknown> = {};
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') cfg = parsed as Record<string, unknown>;
    }
  } catch {
    cfg = {};
  }
  cfg.excludes = [...DEFAULT_GRAPHIFY_EXCLUDES];
  cfg.gitignore = true;
  fs.writeFileSync(file, JSON.stringify(cfg), 'utf8');
}

/**
 * Prepend `$HOME/.local/bin` to PATH so a dev-host graphify (installed by
 * `uv tool install`) resolves. In the image graphify is already on PATH, so
 * this is a harmless no-op there.
 */
function withGraphifyPath(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = base.HOME || process.env.HOME;
  if (!home) return { ...base };
  const localBin = path.join(home, '.local', 'bin');
  const sep = path.delimiter;
  const current = base.PATH ?? '';
  const parts = current.split(sep).filter(Boolean);
  if (!parts.includes(localBin)) {
    return { ...base, PATH: [localBin, ...parts].join(sep) };
  }
  return { ...base };
}

/**
 * Parse node/edge counts. Fast path: graphify prints
 * `Rebuilt: N nodes, M edges, K communities` on stdout. Fallback: count
 * `nodes`/`links` in the emitted NetworkX `graph.json`. Returns zeros if both
 * fail (a valid outcome for an empty graph).
 */
export function parseCounts(stdout: string, outDir: string): { nodeCount: number; edgeCount: number } {
  const m = /Rebuilt:\s*(\d+)\s+nodes?,\s*(\d+)\s+edges?/i.exec(stdout);
  if (m) {
    return { nodeCount: Number(m[1]), edgeCount: Number(m[2]) };
  }
  try {
    const graphPath = path.join(outDir, 'graph.json');
    const g = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
    const nodeCount = Array.isArray(g?.nodes) ? g.nodes.length : 0;
    const edgeCount = Array.isArray(g?.links) ? g.links.length : 0;
    return { nodeCount, edgeCount };
  } catch {
    return { nodeCount: 0, edgeCount: 0 };
  }
}

function firstLine(out: string | null | undefined): string | undefined {
  if (!out) return undefined;
  const line = out
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? line.slice(0, 120) : undefined;
}

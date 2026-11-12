/**
 * The pure parts of the host updater, in TypeScript.
 *
 * WHY these live here and not only in `scripts/host-update.sh`: the updater is
 * the one component whose bugs cannot be fixed by the version it installs (the
 * script that updates version N *is* version N's script). So every decision it
 * makes that can be decided without touching a host — parsing the compose
 * labels, choosing the compose argv, rewriting one line of an env file — is
 * written here, unit-tested here, and then CROSS-CHECKED against the bash
 * implementation by `host-update.script.test.ts`, which sources the real script
 * in library mode and runs the same table of cases through both.
 *
 * That cross-check is the point. Two implementations of the same rule are a
 * liability unless something forces them to agree; here, something does. It
 * follows the same instinct as `buildHostJobLauncher` (`ssh-exec.ts:396`),
 * which is pure precisely so the shell it generates can be asserted on without
 * a host.
 */
import * as path from 'node:path';

/** Label keys compose writes on every container it creates. */
export const COMPOSE_LABELS = {
  project: 'com.docker.compose.project',
  service: 'com.docker.compose.service',
  workingDir: 'com.docker.compose.project.working_dir',
  configFiles: 'com.docker.compose.project.config_files',
} as const;

/**
 * Go templates print the literal string `<no value>` when a map key is absent,
 * which is emphatically not a label value. Treat it, and the empty string, as
 * "this container carries no compose labels".
 */
export function isLabelMissing(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === '' || value.trim() === '<no value>';
}

/**
 * `com.docker.compose.project.config_files` → one absolute path per `-f`.
 *
 * VERIFIED, and the reason this function exists: the label may hold SEVERAL
 * paths separated by commas (`docker compose -f a.yml -f b.yml up` writes
 * `a.yml,b.yml`). Treating it as one path silently drops every override file,
 * which is how an update reverts a deployment's overrides without saying so.
 * Relative entries resolve against the project working dir.
 */
export function parseComposeConfigFiles(raw: string, workingDir: string): string[] {
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => (p.startsWith('/') ? p : `${workingDir}/${p}`));
}

export interface ComposeInvocation {
  /** From the container's OWN label — never from `docker compose ls`. */
  projectName: string;
  /** Always explicit: it also removes any env divergence between apply and rollback. */
  envFile: string;
  configFiles: readonly string[];
}

/**
 * The compose invocation prefix: `docker <these args> <subcommand> …`.
 *
 * `--project-name` comes from the container's label and NEVER from
 * `docker compose ls`, because `swarm-os-test` and `swarm-os-prod` share the
 * project name `swarm-os` on this very host — picking by project name would
 * aim the update at the wrong deployment.
 */
export function buildComposeBaseArgs(inv: ComposeInvocation): string[] {
  const args = ['compose', '--project-name', inv.projectName, '--env-file', inv.envFile];
  for (const f of inv.configFiles) args.push('-f', f);
  return args;
}

/** Characters an image reference may contain. Anything else is refused, not escaped. */
const IMAGE_REF_RE = /^[A-Za-z0-9._:/@-]+$/;

export function isValidImageRef(ref: string): boolean {
  return ref.length > 0 && IMAGE_REF_RE.test(ref);
}

/**
 * A value we are willing to write back into an operator's env file. Wider than
 * an image reference — an operator may legitimately have quoted their value and
 * a rollback must restore THEIR bytes — but still no backslash (the shell
 * implementation passes it through `awk -v`, which interprets escapes) and no
 * control characters.
 */
// eslint-disable-next-line no-control-regex
const ENV_VALUE_FORBIDDEN_RE = /[\\\u0000-\u001f\u007f]/;

export function isValidEnvValue(value: string): boolean {
  return value.length > 0 && !ENV_VALUE_FORBIDDEN_RE.test(value);
}

/** Everything after the first `=` of an env assignment line, verbatim. */
export function envValueOf(line: string): string {
  const i = line.indexOf('=');
  return i === -1 ? '' : line.slice(i + 1);
}

function envAssignmentRe(varName: string): RegExp {
  const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^[ \\t]*(export[ \\t]+)?${escaped}[ \\t]*=`);
}

export type EnvRewriteResult =
  | { ok: true; content: string; before: string; after: string }
  /** `not_found`: the variable is only referenced, never assigned — the
   *  `${VAR:-fallback}` trap. `multiple`: dotenv is last-wins, so rewriting one
   *  of two assignments yields a file that reads right and resolves wrong. */
  | { ok: false; reason: 'not_found' | 'multiple' };

/**
 * Rewrite the single `VAR=` assignment to `VAR=<value>`, changing nothing else.
 *
 * Surgical by construction: every other byte of every other line is copied
 * through, and the rewritten line keeps its own leading whitespace and its
 * `export ` prefix if it had one. Comments and ordering survive because they
 * are never parsed in the first place.
 *
 * Contract shared with `hu_rewrite_env_stream`: the output is newline-terminated
 * (awk terminates every record it prints). Restoring a file that had no trailing
 * newline is the FILE-level caller's job — in bash, a `truncate -s -1`.
 */
export function rewriteEnvStream(content: string, varName: string, value: string): EnvRewriteResult {
  const re = envAssignmentRe(varName);
  const lines = content.split('\n');
  // A trailing newline closes the last record; it does not open an empty one.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const hits = lines.filter((l) => re.test(l));
  if (hits.length === 0) return { ok: false, reason: 'not_found' };
  if (hits.length > 1) return { ok: false, reason: 'multiple' };

  const before = hits[0]!;
  const prefix = re.exec(before)![0];
  const after = prefix + value;
  const out = lines.map((l) => (l === before ? after : l));
  return {
    ok: true,
    content: out.length === 0 ? '' : `${out.join('\n')}\n`,
    before,
    after,
  };
}

/** Verify floor from plan §D.3.7 — see `buildHostUpdateArgv`. */
export const VERIFY_TIMEOUT_FLOOR_S = 300;
export const DEFAULT_VERIFY_TIMEOUT_S = 600;
export const DEFAULT_WAIT_TIMEOUT_S = 300;

export interface HostUpdateArgvInput {
  /** HOST path of the installed script. Invoked as `bash <path>` — no exec bit. */
  scriptPath: string;
  /** HOST path of `<dataDir>/updater/runs/<runId>`. */
  runDir: string;
  runId: string;
  /** HOST path that backs the container's `/data` — the identity check. */
  hostDataDir: string;
  /** Container-side mount point of the data dir (`config.dataDir`). */
  dataMount: string;
  /** `/etc/hostname` of this container: a HINT, validated against the mount. */
  containerHint: string | null;
  targetImage: string;
  envVar: string;
  healthPort: number;
  verifyTimeoutS?: number;
  waitTimeoutS?: number;
}

/**
 * The argv handed to `spawnHostJob`. `bash <path>` and not `<path>` directly:
 * the installed copy carries no exec bit (0600), which also means it still runs
 * if `/data` is mounted `noexec`.
 *
 * The verify timeout is floored at 300 s HERE as well as in the script. Under
 * the ssh transport every team is respawned with a stagger, so a short window
 * would declare a good update failed — and the "failure" handler kills those
 * teams a second time by force-recreating the container.
 */
export function buildHostUpdateArgv(input: HostUpdateArgvInput): string[] {
  const verify = Math.max(VERIFY_TIMEOUT_FLOOR_S, input.verifyTimeoutS ?? DEFAULT_VERIFY_TIMEOUT_S);
  const wait = Math.max(1, input.waitTimeoutS ?? DEFAULT_WAIT_TIMEOUT_S);
  const argv = [
    'bash',
    input.scriptPath,
    'apply',
    '--run-dir',
    input.runDir,
    '--run-id',
    input.runId,
    '--host-data-dir',
    input.hostDataDir,
    '--data-mount',
    input.dataMount,
    '--target',
    input.targetImage,
    '--env-var',
    input.envVar,
    '--health-port',
    String(input.healthPort),
    '--verify-timeout',
    String(verify),
    '--wait-timeout',
    String(wait),
  ];
  if (input.containerHint) argv.push('--container-hint', input.containerHint);
  return argv;
}

/** The argv for the `restore-env` recovery path (see the runner's `abandoned` handler). */
export function buildRestoreEnvArgv(input: {
  scriptPath: string;
  envFile: string;
  envVar: string;
  /** The archived `VAR=value` line, byte-exact, base64-encoded. */
  envLineBefore: string;
}): string[] {
  return [
    'bash',
    input.scriptPath,
    'restore-env',
    '--env-file',
    input.envFile,
    '--env-var',
    input.envVar,
    '--line-b64',
    Buffer.from(input.envLineBefore, 'utf8').toString('base64'),
  ];
}

/** `<dataDir>/updater` — script + lock + run directories. */
export function updaterDir(dataDir: string): string {
  return path.join(dataDir, 'updater');
}

export function runsDir(dataDir: string): string {
  return path.join(updaterDir(dataDir), 'runs');
}

export function runDirFor(dataDir: string, runId: string): string {
  return path.join(runsDir(dataDir), runId);
}

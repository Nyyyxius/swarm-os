/**
 * The bash updater, tested two ways.
 *
 * 1. **Cross-check.** Every pure rule is implemented twice — once in
 *    `compose.ts`, once in `scripts/host-update.sh` — and the two are run
 *    against the SAME table of cases here. Two implementations of one rule are
 *    a liability unless something forces them to agree; this is that something.
 *    The script is sourced with `SWARM_OS_HOST_UPDATE_LIB=1`, which defines its
 *    functions and returns without doing anything.
 *
 * 2. **End-to-end, against a fake `docker`.** `apply` is driven all the way to
 *    `result.json` with a stub `docker` first on `PATH`. Nothing real is pulled,
 *    started or recreated — the plan is explicit that this package is not to be
 *    executed against a live container — but every refusal, the atomic env
 *    rewrite, the resolve-mismatch revert, the rollback and the happy path are
 *    exercised as the shell actually runs them.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseComposeConfigFiles, rewriteEnvStream, isLabelMissing } from './compose.js';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../scripts/host-update.sh',
);

/** Run a snippet with the script sourced in library mode. */
function lib(snippet: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync(
    'bash',
    ['-c', `set -u; SWARM_OS_HOST_UPDATE_LIB=1 . ${JSON.stringify(SCRIPT)}\n${snippet}`],
    { encoding: 'utf8', cwd: opts.cwd, env: { ...process.env, ...opts.env } },
  );
}

/** Same, but returning the exit status instead of throwing. */
function libStatus(snippet: string): number {
  try {
    lib(snippet);
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
}

function sh(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

let tmpRoot: string;
beforeAll(() => {
  expect(fs.existsSync(SCRIPT)).toBe(true);
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-os-hu-'));
});

describe('the script is syntactically valid', () => {
  it('passes `bash -n`', () => {
    expect(() => execFileSync('bash', ['-n', SCRIPT], { encoding: 'utf8' })).not.toThrow();
  });

  it('declares a SCRIPT_VERSION and stamps it into every emitted record', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    expect(/^SCRIPT_VERSION="\d+\.\d+\.\d+"$/m.test(src)).toBe(true);
    // The updater for version N cannot be fixed by N+1, so a support case has
    // to be able to tell which script ran from the logs alone.
    expect(src).toContain('\\"script_version\\":\\"${SCRIPT_VERSION}\\"');
  });

  it('never uses --remove-orphans (it would DELETE swarm-os-stiix) or --pull always', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const code = src
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');
    expect(code).not.toContain('--remove-orphans');
    expect(code).not.toContain('--pull always');
  });

  it('floors the verify window at 300 s unless a test explicitly says otherwise', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    expect(/^VERIFY_TIMEOUT_FLOOR_S=300$/m.test(src)).toBe(true);
    // Under ssh each team is respawned with a stagger; a shorter window would
    // declare a good update failed and force-recreate — killing them twice.
    expect(lib('printf "%s\\n" "$VERIFY_TIMEOUT_FLOOR_S"').trim()).toBe('300');
  });

  it('does NOT let the ambient environment shrink that floor', () => {
    // The floor used to be bent by an environment variable. This script runs
    // under ssh, whose environment we do not control: one stray `export` in a
    // host profile would have disarmed it on a production run. Only the
    // `--test-timing` flag may bend it now.
    for (const name of ['SWARM_OS_HOST_UPDATE_TEST_TIMING', 'VERIFY_TIMEOUT_FLOOR_S']) {
      expect(
        lib('printf "%s\\n" "$VERIFY_TIMEOUT_FLOOR_S"', { env: { [name]: '1:1' } }).trim(),
      ).toBe('300');
    }
    expect(lib('hu_set_test_timing 1:1; printf "%s\\n" "$VERIFY_TIMEOUT_FLOOR_S"').trim()).toBe('1');
  });

  it('never takes a blocking OR a waiting flock', () => {
    // `-w` does not decline a second update, it postpones it — and then runs
    // it, recreating the deployment twice back to back.
    const src = fs.readFileSync(SCRIPT, 'utf8');
    for (const m of src.matchAll(/^[^#\n]*\bflock\b[^\n]*/gm)) {
      expect(m[0]).toMatch(/flock -n/);
    }
  });
});

describe('cross-check: config_files label parsing', () => {
  const cases: Array<[string, string]> = [
    ['/srv/app/docker-compose.yml', '/srv/app'],
    ['/srv/a.yml,/srv/b.yml', '/srv'],
    ['a.yml, /abs/b.yml ,,  c.yml ', '/srv/app'],
    ['', '/srv'],
    ['./rel.yml', '/srv/app'],
  ];
  for (const [raw, wd] of cases) {
    it(`bash and TS agree on ${JSON.stringify(raw)}`, () => {
      const fromBash = lib(`hu_parse_config_files ${sh(raw)} ${sh(wd)}`)
        .split('\n')
        .filter((l) => l.length > 0);
      expect(fromBash).toEqual(parseComposeConfigFiles(raw, wd));
    });
  }
});

describe('cross-check: compose argv', () => {
  it('bash and TS build the same invocation prefix', () => {
    const fromBash = lib(`hu_compose_args 'swarm-os' '/srv/.env' '/srv/a.yml' '/srv/b.yml'`)
      .split('\n')
      .filter((l) => l.length > 0);
    expect(fromBash).toEqual([
      'compose',
      '--project-name',
      'swarm-os',
      '--env-file',
      '/srv/.env',
      '-f',
      '/srv/a.yml',
      '-f',
      '/srv/b.yml',
    ]);
  });
});

describe('cross-check: missing-label detection', () => {
  for (const v of ['', '<no value>', 'swarm-os']) {
    it(`bash and TS agree on ${JSON.stringify(v)}`, () => {
      const bashSaysMissing = libStatus(`hu_label_missing ${sh(v)}`) === 0;
      expect(bashSaysMissing).toBe(isLabelMissing(v));
    });
  }
});

describe('cross-check: env line rewriting', () => {
  const cases: Array<[string, string]> = [
    ['# c\nSWARM_OS_IMAGE=ghcr.io/o/r:0.5.0\nOTHER=x\n', 'ghcr.io/o/r:0.6.0'],
    ['  export SWARM_OS_IMAGE=old\n', 'new'],
    ['A=1\nB=2\n', 'new'],
    ['SWARM_OS_IMAGE=a\nSWARM_OS_IMAGE=b\n', 'new'],
    ['MY_SWARM_OS_IMAGE=a\n', 'new'],
  ];
  for (const [content, value] of cases) {
    it(`bash and TS agree on ${JSON.stringify(content.slice(0, 40))}`, () => {
      const ts = rewriteEnvStream(content, 'SWARM_OS_IMAGE', value);
      const inFile = path.join(tmpRoot, `in-${Math.random().toString(36).slice(2)}`);
      fs.writeFileSync(inFile, content);
      let bashOut = '';
      let bashRc = 0;
      try {
        bashOut = lib(`hu_rewrite_env_stream SWARM_OS_IMAGE ${sh(value)} < ${sh(inFile)}`);
      } catch (err) {
        bashRc = (err as { status?: number }).status ?? -1;
      }
      if (ts.ok) {
        expect(bashRc).toBe(0);
        expect(bashOut).toBe(ts.content);
      } else {
        // 3 is the script's "zero or more than one assignment" status.
        expect(bashRc).toBe(3);
      }
    });
  }
});

describe('the env file write (file level)', () => {
  function envDir(content: string): string {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'env-'));
    fs.writeFileSync(path.join(dir, '.env'), content);
    return dir;
  }

  it('leaves a .bak and preserves a file that does not end with a newline', () => {
    const dir = envDir('# c\nSWARM_OS_IMAGE=ghcr.io/o/r:0.5.0\nOTHER=x');
    lib(`hu_write_env_line ${sh(path.join(dir, '.env'))} SWARM_OS_IMAGE ghcr.io/o/r:0.6.0`);
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe(
      '# c\nSWARM_OS_IMAGE=ghcr.io/o/r:0.6.0\nOTHER=x',
    );
    expect(fs.readFileSync(path.join(dir, '.env.bak'), 'utf8')).toBe(
      '# c\nSWARM_OS_IMAGE=ghcr.io/o/r:0.5.0\nOTHER=x',
    );
  });

  it('round-trips to the byte — the property a rollback depends on', () => {
    const original = '# c\nSWARM_OS_IMAGE=ghcr.io/o/r:0.5.0\n\nOTHER=x\n';
    const dir = envDir(original);
    const f = path.join(dir, '.env');
    lib(`hu_write_env_line ${sh(f)} SWARM_OS_IMAGE ghcr.io/o/r:0.6.0`);
    expect(fs.readFileSync(f, 'utf8')).not.toBe(original);
    const b64 = Buffer.from('SWARM_OS_IMAGE=ghcr.io/o/r:0.5.0', 'utf8').toString('base64');
    lib(`hu_main_restore_env --env-file ${sh(f)} --env-var SWARM_OS_IMAGE --line-b64 ${sh(b64)}`);
    expect(fs.readFileSync(f, 'utf8')).toBe(original);
  });

  it('leaves the file untouched when the value could not be written back safely', () => {
    const dir = envDir('SWARM_OS_IMAGE=a\n');
    const f = path.join(dir, '.env');
    // A backslash would be re-interpreted by `awk -v`; refuse rather than mangle.
    const rc = libStatus(`hu_write_env_line ${sh(f)} SWARM_OS_IMAGE 'a\\b'`);
    expect(rc).not.toBe(0);
    expect(fs.readFileSync(f, 'utf8')).toBe('SWARM_OS_IMAGE=a\n');
  });

  it('locates <working_dir>/.env then <working_dir>/../.env, and nothing else', () => {
    const root = fs.mkdtempSync(path.join(tmpRoot, 'loc-'));
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    expect(libStatus(`hu_locate_env_file ${sh(project)}`)).not.toBe(0);
    fs.writeFileSync(path.join(root, '.env'), 'X=1\n');
    expect(lib(`hu_locate_env_file ${sh(project)}`).trim()).toBe(path.join(root, '.env'));
    fs.writeFileSync(path.join(project, '.env'), 'X=2\n');
    expect(lib(`hu_locate_env_file ${sh(project)}`).trim()).toBe(path.join(project, '.env'));
  });
});

describe('config hashing', () => {
  it('prints NOTHING and fails when `compose config` does not answer', () => {
    // Piping a failed `config` into `sha256sum` yields the hash of the empty
    // string — which compares EQUAL to the next failure. That is what the
    // rollback uses as its "the restore was exact" proof.
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'nodocker-'));
    fs.writeFileSync(path.join(dir, 'docker'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
    const out = lib(`COMPOSE_ARGS=(compose); hu_config_hash; printf 'rc=%s' "$?"`, {
      env: { PATH: `${dir}:${process.env.PATH}` },
    });
    expect(out).toBe('rc=1');
  });
});

describe('container selection', () => {
  it('picks the single container mounting the expected /data source', () => {
    expect(lib(`printf 'aaa\\t/srv/d\\nbbb\\t/other\\n' | hu_pick_container /srv/d`).trim()).toBe('aaa');
  });
  it('refuses (rather than guesses) when none or several match', () => {
    expect(libStatus(`printf 'aaa\\t/x\\n' | hu_pick_container /srv/d`)).toBe(1);
    expect(libStatus(`printf 'a\\t/srv/d\\nb\\t/srv/d\\n' | hu_pick_container /srv/d`)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// End-to-end against a stub `docker`.
// ---------------------------------------------------------------------------

interface Deployment {
  dir: string;
  hostData: string;
  runDir: string;
  envFile: string;
  binDir: string;
}

/**
 * A deployment on a fake host: a project dir with a compose file and a `.env`,
 * a data dir, a run dir, and a `docker` stub that answers from files so each
 * test can bend one answer.
 */
function makeDeployment(opts: {
  envContent?: string;
  /** Keys: `project` | `service` | `working_dir` | `config_files`. */
  labels?: Record<string, string>;
  /** Every label lookup AND the `{{.Id}}` probe answer empty — a wedged dockerd. */
  labelsEmpty?: boolean;
  /** What `compose config --images` reports; `$IMAGE` is substituted from the .env. */
  resolvedImage?: string | null;
  /** Exit status of a plain `compose config` (the hash pass). 0 = answer normally. */
  configPlainExit?: number;
  /** What `docker ps -q` lists. Default: the single `cid-current`. */
  psIds?: string[];
  /** Per-container `/data` bind source; anything unlisted gets the deployment's. */
  mounts?: Record<string, string>;
  /** Exit status of successive `compose up` calls; the last one repeats. */
  upExit?: number[];
  pullExit?: number;
  /** Successive `/health` bodies; the last one repeats. */
  health?: string[];
  /**
   * When the .env resolves to this image, a `compose config` call duplicates the
   * `SWARM_OS_IMAGE` line — the way a concurrent editor would. Every later
   * rewrite then refuses (dotenv is last-wins), which is how the "the revert
   * itself failed" branch is reached without a real filesystem fault.
   */
  sabotageEnvAt?: string;
  /** A `"` in the project directory name — the character that breaks naive JSON. */
  projectDirName?: string;
} = {}): Deployment {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'dep-'));
  const project = path.join(dir, opts.projectDirName ?? 'project');
  const hostData = path.join(dir, 'data');
  const runDir = path.join(dir, 'run');
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(project);
  fs.mkdirSync(hostData);
  fs.mkdirSync(runDir);
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(project, 'docker-compose.yml'), 'services:\n  swarm-os:\n');
  const envFile = path.join(project, '.env');
  fs.writeFileSync(
    envFile,
    opts.envContent ?? `# swarm-os deployment\nSWARM_OS_IMAGE=ghcr.io/o/r:0.5.0\nPORT=8787\n`,
  );

  // The stub answers from plain files, one per question, so a test can bend a
  // single answer without a JSON parser inside a shell script.
  const state = path.join(dir, 'state');
  fs.mkdirSync(state);
  const put = (name: string, value: string): void => fs.writeFileSync(path.join(state, name), value);
  const labels: Record<string, string> = {
    project: 'swarm-os',
    service: 'swarm-os',
    working_dir: project,
    config_files: path.join(project, 'docker-compose.yml'),
    ...opts.labels,
  };
  put('label.project', labels.project!);
  put('label.service', labels.service!);
  put('label.working_dir', labels.working_dir!);
  put('label.config_files', labels.config_files!);
  put('mount', hostData);
  put('ps.ids', (opts.psIds ?? ['cid-current']).join('\n') + '\n');
  for (const [cid, src] of Object.entries(opts.mounts ?? {})) put(`mount.${cid}`, src);
  if (opts.labelsEmpty) put('labels.empty', '1');
  if (opts.configPlainExit !== undefined) put('config_plain.exit', String(opts.configPlainExit));
  if (opts.sabotageEnvAt !== undefined) put('sabotage.duplicate', opts.sabotageEnvAt);
  put('resolved_image', opts.resolvedImage === undefined ? '$IMAGE' : (opts.resolvedImage ?? ''));
  const upExits = opts.upExit ?? [0];
  put('up.count', String(upExits.length));
  upExits.forEach((e, i) => put(`up.exit.${i}`, String(e)));
  put('pull.exit', String(opts.pullExit ?? 0));
  const health = opts.health ?? ['{"status":"ok","boot_complete":true}'];
  put('health.count', String(health.length));
  health.forEach((h, i) => put(`health.${i}`, h));

  fs.writeFileSync(
    path.join(binDir, 'docker'),
    `#!/usr/bin/env bash
S=${JSON.stringify(state)}
ENVF=${JSON.stringify(envFile)}
# EVERY invocation, verbatim, one %q-quoted line per call. A stub that only
# counts calls cannot notice that \`-- <service>\` went missing — and without
# the service name \`--no-deps\` is a no-op, so compose recreates every service
# in the project (swarm-os-test and swarm-os-stiix share a project name).
{ printf '%q ' "$@"; printf '\\n'; } >>"$S/argv.log"
image_now() { grep -m1 -E '^[[:space:]]*(export[[:space:]]+)?SWARM_OS_IMAGE[[:space:]]*=' "$ENVF" | sed 's/^[^=]*=//'; }
case "$1" in
  ps) cat "$S/ps.ids" ;;
  inspect)
    shift
    fmt=""
    ids=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --format) fmt="\${2-}"; shift 2 ;;
        *) ids+=("$1"); shift ;;
      esac
    done
    for id in "\${ids[@]}"; do
      case "$fmt" in
        # The scan format asks for the id AND the mount in one call.
        *Mounts*)
          m="$S/mount.$id"
          [ -f "$m" ] || m="$S/mount"
          case "$fmt" in
            *'{{.Id}}'*) printf '%s\\t%s\\n' "$id" "$(cat "$m")" ;;
            *) printf '%s\\n' "$(cat "$m")" ;;
          esac ;;
        *config_files*) [ -f "$S/labels.empty" ] && { echo; continue; }; printf '%s\\n' "$(cat "$S/label.config_files")" ;;
        *working_dir*) [ -f "$S/labels.empty" ] && { echo; continue; }; printf '%s\\n' "$(cat "$S/label.working_dir")" ;;
        *compose.service*) [ -f "$S/labels.empty" ] && { echo; continue; }; printf '%s\\n' "$(cat "$S/label.service")" ;;
        *compose.project*) [ -f "$S/labels.empty" ] && { echo; continue; }; printf '%s\\n' "$(cat "$S/label.project")" ;;
        # \`--format '{{.Id}}'\` alone: the "is the daemon answering at all?" probe.
        *) [ -f "$S/labels.empty" ] && { echo; continue; }; printf '%s\\n' "$id" ;;
      esac
    done ;;
  pull) exit "$(cat "$S/pull.exit")" ;;
  exec)
    n=0
    [ -f "$S/n" ] && n=$(cat "$S/n")
    echo $((n+1)) > "$S/n"
    count=$(cat "$S/health.count")
    [ "$count" -eq 0 ] && exit 7
    [ "$n" -ge "$count" ] && n=$((count-1))
    cat "$S/health.$n" ;;
  compose)
    sub=""
    for a in "$@"; do case "$a" in config|up|ps|down) sub="$a"; break ;; esac; done
    case "$sub" in
      config)
        # A plain \`config\` (the hash pass) can be made to fail on its own,
        # while \`config --images\` (the resolve pass) still answers.
        if [ -f "$S/config_plain.exit" ] && ! printf '%s\\n' "$@" | grep -qx -- --images; then
          exit "$(cat "$S/config_plain.exit")"
        fi
        ri="$(cat "$S/resolved_image")"
        [ -z "$ri" ] && exit 1
        [ "$ri" = '$IMAGE' ] && ri="$(image_now)"
        if [ -f "$S/sabotage.duplicate" ] && [ "$(image_now)" = "$(cat "$S/sabotage.duplicate")" ]; then
          printf 'SWARM_OS_IMAGE=%s\\n' "$(image_now)" >> "$ENVF"
          rm -f "$S/sabotage.duplicate"
        fi
        echo "$ri" ;;
      up)
        u=0
        [ -f "$S/up.n" ] && u=$(cat "$S/up.n")
        echo $((u+1)) > "$S/up.n"
        ucount=$(cat "$S/up.count")
        [ "$u" -ge "$ucount" ] && u=$((ucount-1))
        exit "$(cat "$S/up.exit.$u")" ;;
      ps) echo cid-new ;;
      *) exit 0 ;;
    esac ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 },
  );
  return { dir, hostData, runDir, envFile, binDir };
}

/**
 * `--test-timing <floor>:<poll>` shrinks the 300 s verify floor for the cases
 * that must actually wait it out (rollback, "healthy but never boot_complete").
 * A FLAG, deliberately: it used to be an environment variable, which meant a
 * stray `export` in a host profile disarmed the floor on a production run.
 * `buildHostUpdateArgv` never emits this flag.
 */
const FAST_TIMING = ['--test-timing', '1:1'];

function runApply(
  dep: Deployment,
  extra: string[] = [],
): { status: number; result: Record<string, unknown> } {
  let status = 0;
  try {
    execFileSync(
      'bash',
      [
        SCRIPT,
        'apply',
        '--run-dir',
        dep.runDir,
        '--run-id',
        'run-1',
        '--host-data-dir',
        dep.hostData,
        '--target',
        'ghcr.io/o/r:0.6.0',
        '--container-hint',
        'cid-current',
        '--verify-timeout',
        '300',
        '--wait-timeout',
        '5',
        ...FAST_TIMING,
        ...extra,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dep.binDir}:${process.env.PATH}` },
      },
    );
  } catch (err) {
    status = (err as { status?: number }).status ?? -1;
  }
  const raw = fs.readFileSync(path.join(dep.runDir, 'result.json'), 'utf8');
  return { status, result: JSON.parse(raw) as Record<string, unknown> };
}

/** Every `docker …` invocation the stub recorded, one token array per call. */
function dockerCalls(dep: Deployment): string[][] {
  const log = path.join(dep.dir, 'state', 'argv.log');
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    // `printf %q` only quotes what needs quoting, and every path here comes
    // from `mkdtemp` — no spaces to un-escape.
    .map((l) => l.trim().split(/\s+/));
}

/** The recorded `compose … up …` calls (apply pass first, rollback pass after). */
function composeUpCalls(dep: Deployment): string[][] {
  return dockerCalls(dep).filter((a) => a[0] === 'compose' && a.includes('up'));
}

function events(dep: Deployment): Array<Record<string, unknown>> {
  return fs
    .readFileSync(path.join(dep.runDir, 'events.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('apply, end to end against a stub docker', () => {
  it('rewrites the env line, deploys and reports success on boot_complete', () => {
    const dep = makeDeployment();
    const { status, result } = runApply(dep);
    expect(status).toBe(0);
    expect(result.state).toBe('success');
    expect(result.verify).toBe('boot_complete');
    expect(fs.readFileSync(dep.envFile, 'utf8')).toBe(
      '# swarm-os deployment\nSWARM_OS_IMAGE=ghcr.io/o/r:0.6.0\nPORT=8787\n',
    );
    expect(fs.readFileSync(`${dep.envFile}.bak`, 'utf8')).toContain('0.5.0');
    // Every progress record is stamped with the script version.
    const evs = events(dep);
    expect(evs.every((e) => typeof e.script_version === 'string')).toBe(true);
    expect(evs.map((e) => e.phase)).toContain('env_written');
    expect(fs.existsSync(path.join(dep.runDir, 'heartbeat'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The compose argv, asserted on what was RECORDED — not on a call count and
  // not on a grep of the source. A flag that arrives through a variable is
  // invisible to a grep, and `-- <service>` going missing is invisible to a
  // counter: without it `--no-deps` has nothing to scope, so compose recreates
  // EVERY service in the project — and swarm-os-test and swarm-os-stiix share
  // the project name `swarm-os`.
  // -------------------------------------------------------------------------
  describe('the recorded `compose up` argv', () => {
    it('names the service, scopes with --no-deps, and pins project + env file', () => {
      const dep = makeDeployment();
      expect(runApply(dep).status).toBe(0);
      const ups = composeUpCalls(dep);
      expect(ups).toHaveLength(1);
      const argv = ups[0]!;
      // The service name is the LAST argument, behind the `--` terminator.
      expect(argv.slice(-2)).toEqual(['--', 'swarm-os']);
      expect(argv).toContain('--no-deps');
      expect(argv).toContain('--project-name');
      expect(argv[argv.indexOf('--project-name') + 1]).toBe('swarm-os');
      expect(argv).toContain('--env-file');
      expect(argv[argv.indexOf('--env-file') + 1]).toBe(dep.envFile);
      expect(argv).toContain('--wait');
    });

    it('never passes --remove-orphans or --pull always, on ANY docker call', () => {
      // --remove-orphans deletes the OTHER deployment on this host; --pull
      // always re-resolves the tag at up time, defeating "the tag we wrote is
      // the tag that runs".
      const dep = makeDeployment({ upExit: [1, 0] });
      expect(runApply(dep).status).toBe(10);
      const calls = dockerCalls(dep);
      expect(calls.length).toBeGreaterThan(0);
      for (const argv of calls) {
        expect(argv).not.toContain('--remove-orphans');
        const pull = argv.indexOf('--pull');
        if (pull !== -1) expect(argv[pull + 1]).not.toBe('always');
      }
    });

    it('gives the rollback `up` the same guarantees, and the operator’s --wait-timeout', () => {
      // The rollback used to hard-code the built-in default: it would wait a
      // different time to bring back the image the host is actually going to run.
      const dep = makeDeployment({ upExit: [1, 0] });
      expect(runApply(dep, ['--wait-timeout', '7']).status).toBe(10);
      const ups = composeUpCalls(dep);
      expect(ups).toHaveLength(2);
      for (const argv of ups) {
        expect(argv.slice(-2)).toEqual(['--', 'swarm-os']);
        expect(argv).toContain('--no-deps');
        expect(argv[argv.indexOf('--wait-timeout') + 1]).toBe('7');
      }
      expect(ups[1]).toContain('--force-recreate');
    });

    it('floors --wait-timeout at 1 rather than passing compose a zero', () => {
      const dep = makeDeployment();
      expect(runApply(dep, ['--wait-timeout', '0']).status).toBe(0);
      const argv = composeUpCalls(dep)[0]!;
      expect(argv[argv.indexOf('--wait-timeout') + 1]).toBe('1');
    });
  });

  it('treats "healthy but never boot_complete" as success + review, NOT a rollback', () => {
    const dep = makeDeployment({ health: ['{"status":"ok","boot_complete":false}'] });
    const { status, result } = runApply(dep, ['--verify-timeout', '1']);
    expect(status).toBe(0);
    expect(result.state).toBe('success');
    expect(result.verify).toBe('healthy_no_boot_complete');
    // Rolling back here would kill the teams a second time to "fix" a
    // container that is answering requests.
    expect(fs.readFileSync(dep.envFile, 'utf8')).toContain('0.6.0');
  });

  it('rolls back — restoring the original line byte-exactly — when health never answers', () => {
    const dep = makeDeployment({ health: [] });
    const before = fs.readFileSync(dep.envFile, 'utf8');
    const { status, result } = runApply(dep, ['--verify-timeout', '1']);
    expect(status).toBe(10);
    expect(result.state).toBe('rolled_back');
    expect(fs.readFileSync(dep.envFile, 'utf8')).toBe(before);
    // …and the `.bak` still holds the operator's ORIGINAL, not the version we
    // just backed out of. Refreshing it on the rollback pass would hand them a
    // "backup" of the broken state at the moment they need the good one.
    expect(fs.readFileSync(`${dep.envFile}.bak`, 'utf8')).toBe(before);
  });

  it('rolls back when `compose up` fails', () => {
    // The first `up` (the new image) fails; the rollback `up` succeeds.
    const dep = makeDeployment({ upExit: [1, 0] });
    const before = fs.readFileSync(dep.envFile, 'utf8');
    const { status, result } = runApply(dep);
    expect(status).toBe(10);
    expect(result.reason).toBe('compose_up_failed');
    expect(fs.readFileSync(dep.envFile, 'utf8')).toBe(before);
  });

  it('reports `failed`, not `rolled_back`, when the rollback itself cannot deploy', () => {
    // The env file IS restored (so a reboot cannot re-apply the bad image) but
    // the operator is told plainly that the deployment needs attention.
    const dep = makeDeployment({ upExit: [1, 1] });
    const before = fs.readFileSync(dep.envFile, 'utf8');
    const { status, result } = runApply(dep);
    expect(status).toBe(20);
    expect(result.reason).toBe('rollback_up_failed');
    expect(fs.readFileSync(dep.envFile, 'utf8')).toBe(before);
  });

  it('refuses — touching nothing — when the container carries no compose labels', () => {
    const dep = makeDeployment({ labels: { project: '<no value>' } });
    const before = fs.readFileSync(dep.envFile, 'utf8');
    const { status, result } = runApply(dep);
    expect(status).toBe(30);
    expect(result.reason).toBe('not_compose_managed');
    expect(fs.readFileSync(dep.envFile, 'utf8')).toBe(before);
  });

  it('refuses when there is no .env to rewrite', () => {
    const dep = makeDeployment();
    fs.unlinkSync(dep.envFile);
    const { status, result } = runApply(dep);
    expect(status).toBe(30);
    expect(result.reason).toBe('env_file_not_found');
  });

  it('refuses when the variable is referenced but never assigned', () => {
    const dep = makeDeployment({ envContent: '# only a fallback in the compose\nPORT=8787\n' });
    const { status, result } = runApply(dep);
    expect(status).toBe(30);
    expect(result.reason).toBe('env_var_absent');
  });

  it('refuses when the variable is assigned twice (dotenv is last-wins)', () => {
    const dep = makeDeployment({
      envContent: 'SWARM_OS_IMAGE=ghcr.io/o/r:0.4.0\nSWARM_OS_IMAGE=ghcr.io/o/r:0.5.0\n',
    });
    const { status, result } = runApply(dep);
    expect(status).toBe(30);
    expect(result.reason).toBe('env_var_duplicated');
  });

  it('refuses when the container mounts a different /data than the one we were given', () => {
    const dep = makeDeployment();
    // A new container pointed at another directory boots on an empty database.
    const { status, result } = runApply(dep, ['--host-data-dir', path.join(dep.dir, 'elsewhere')]);
    expect(status).toBe(30);
    expect(['container_not_found', 'data_dir_mismatch']).toContain(result.reason);
  });

  it('refuses a digest-pinned deployment and a digest-pinned target', () => {
    const pinned = makeDeployment({ resolvedImage: 'ghcr.io/o/r@sha256:' + 'a'.repeat(64) });
    expect(runApply(pinned).result.reason).toBe('image_pinned_by_digest');
    const dep = makeDeployment();
    const r = runApply(dep, ['--target', 'ghcr.io/o/r@sha256:' + 'b'.repeat(64)]);
    expect(r.status).toBe(30);
    expect(r.result.reason).toBe('target_pinned_by_digest');
  });

  it('refuses when the pull fails — nothing has been touched at that point', () => {
    const dep = makeDeployment({ pullExit: 1 });
    const before = fs.readFileSync(dep.envFile, 'utf8');
    const { status, result } = runApply(dep);
    expect(status).toBe(30);
    expect(result.reason).toBe('pull_failed');
    expect(fs.readFileSync(dep.envFile, 'utf8')).toBe(before);
  });

  it('REVERTS and refuses when the resolved image is not the one we wrote', () => {
    // The `${SWARM_OS_IMAGE:-ghcr.io/…:latest}` trap: the compose does not
    // actually interpolate our variable, so deploying now installs the fallback.
    const dep = makeDeployment({ resolvedImage: 'ghcr.io/o/r:pinned-in-yaml' });
    const before = fs.readFileSync(dep.envFile, 'utf8');
    const { status, result } = runApply(dep);
    expect(status).toBe(30);
    expect(result.reason).toBe('resolve_mismatch');
    expect(result.env_written).toBe(false);
    expect(fs.readFileSync(dep.envFile, 'utf8')).toBe(before);
    // `refused` claims nothing was touched, so the revert has to be VISIBLE:
    // the boot-time recovery reads these events, and `env_written` with no
    // `env_restored` after it is what makes it repair the file.
    expect(events(dep).map((e) => e.phase)).toContain('env_restored');
    expect(composeUpCalls(dep)).toHaveLength(0);
  });

  it('reports `failed`, NOT `refused`, when that revert cannot be written back', () => {
    // `refused` means "nothing was touched". If the revert fails, the env file
    // still names an image that is not running and nothing downstream repairs
    // it — the server's recovery only fires on a MISSING result.json.
    const dep = makeDeployment({
      resolvedImage: 'ghcr.io/o/r:pinned-in-yaml',
      sabotageEnvAt: 'ghcr.io/o/r:0.6.0',
    });
    const { status, result } = runApply(dep);
    expect(status).toBe(20);
    expect(result.state).toBe('failed');
    expect(result.reason).toBe('revert_failed');
    // The operator has to know the file is still ours, and where their copy is.
    expect(result.env_written).toBe(true);
    expect(String(result.message)).toContain(`${dep.envFile}.bak`);
    expect(fs.readFileSync(dep.envFile, 'utf8')).toContain('SWARM_OS_IMAGE=ghcr.io/o/r:0.6.0');
    expect(events(dep).map((e) => e.phase)).not.toContain('env_restored');
    // Still nothing deployed: the whole point of the branch.
    expect(composeUpCalls(dep)).toHaveLength(0);
  });

  it('rolls back when the NEW container came up on a different /data', () => {
    // Checking the mount once, on the old container, is not enough: a compose
    // file whose bind source changed produces a container that starts, answers
    // /health and reports boot_complete — on an EMPTY database.
    const dep = makeDeployment({ mounts: { 'cid-new': '/srv/somebody-elses-data' } });
    const before = fs.readFileSync(dep.envFile, 'utf8');
    const { status, result } = runApply(dep);
    expect(status).toBe(10);
    expect(result.state).toBe('rolled_back');
    expect(result.reason).toBe('data_dir_moved_after_up');
    expect(fs.readFileSync(dep.envFile, 'utf8')).toBe(before);
  });

  it('says "two containers match", not "none", when two deployments collide', () => {
    // The one host where this script is dangerous is the host with two
    // swarm-os deployments. Telling the operator the opposite of the truth
    // there is worse than any refusal.
    const dep = makeDeployment({
      psIds: ['cid-a', 'cid-b'],
      mounts: { 'cid-stale': path.join('/srv', 'gone') },
    });
    const { status, result } = runApply(dep, ['--container-hint', 'cid-stale']);
    expect(status).toBe(30);
    expect(result.reason).toBe('container_ambiguous');
    expect(String(result.message)).toContain('More than one');
  });

  it('blames the daemon, not the deployment, when inspect answers nothing', () => {
    // An unreachable dockerd returns "" for every label — byte-identical to a
    // container started with plain `docker run`, and the two need opposite
    // responses.
    const dep = makeDeployment({ labelsEmpty: true });
    const { status, result } = runApply(dep);
    expect(status).toBe(30);
    expect(result.reason).toBe('docker_unreachable');
  });

  it('refuses when `compose config` produces nothing to hash', () => {
    // That hash is the only proof the rollback has that it restored the
    // configuration exactly; without it, "restored" compares one failure to
    // another and always agrees.
    const dep = makeDeployment({ configPlainExit: 1 });
    const before = fs.readFileSync(dep.envFile, 'utf8');
    const { status, result } = runApply(dep);
    expect(status).toBe(30);
    expect(result.reason).toBe('config_hash_failed');
    expect(fs.readFileSync(dep.envFile, 'utf8')).toBe(before);
  });

  it('never records result.json as written when the rename failed', () => {
    // `result.json` is what makes a run terminal for the server. An unchecked
    // `mv` here turns a failed write into a run that looks recorded and is
    // invisible — and the EXIT trap, seeing "already written", never retries.
    const dep = makeDeployment();
    const blocked = path.join(dep.runDir, 'result.json');
    fs.mkdirSync(blocked);
    fs.chmodSync(blocked, 0o000);
    // `spawnSync`, not `execFileSync`: the run SUCCEEDS, and its complaint is
    // on stderr — which the throwing variant only surfaces on failure.
    const proc = spawnSync(
      'bash',
      [
        SCRIPT, 'apply',
        '--run-dir', dep.runDir,
        '--run-id', 'run-1',
        '--host-data-dir', dep.hostData,
        '--target', 'ghcr.io/o/r:0.6.0',
        '--container-hint', 'cid-current',
        '--wait-timeout', '5',
        ...FAST_TIMING,
      ],
      { encoding: 'utf8', env: { ...process.env, PATH: `${dep.binDir}:${process.env.PATH}` } },
    );
    fs.chmodSync(blocked, 0o700);
    const stderr = proc.stderr;
    // The verdict itself is unaffected — the update did happen.
    expect(proc.status).toBe(0);
    expect(stderr).toContain('rename into');
    // …and the EXIT trap retried THAT verdict rather than trusting the flag.
    expect(stderr).toContain('retrying the result.json write that failed earlier');
  });

  it('writes a result.json that parses even when the env path contains a quote', () => {
    // Every field is escaped, not just the message: an unparseable result is a
    // run the server calls abandoned forever.
    const dep = makeDeployment({ projectDirName: 'pro"ject' });
    const { status, result } = runApply(dep);
    expect(status).toBe(0);
    expect(result.env_file).toBe(dep.envFile);
    expect(String(result.env_file)).toContain('"');
  });

  it('refuses the second concurrent updater IMMEDIATELY — it never queues', () => {
    // A waiting flock does not decline the second update, it postpones it: the
    // first updater finishes, the second wakes up and applies a SECOND update,
    // and the production container is recreated twice back to back.
    const dep = makeDeployment();
    const lock = path.join(dep.dir, 'update.lock');
    // Hold the lock from a background process for longer than any tolerable
    // wait, and make sure it really holds it before starting the updater.
    const holderPid = execFileSync(
      'bash',
      [
        '-c',
        // `>/dev/null` on the background job: it must not keep our stdout pipe
        // open, or reading this command's output would block until it exits.
        `( exec 9>${JSON.stringify(lock)}; flock -n 9 || exit 9; sleep 6 ) </dev/null >/dev/null 2>&1 & echo $!; ` +
          `for _ in $(seq 1 200); do flock -n ${JSON.stringify(lock)} true || break; sleep 0.05; done`,
      ],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')[0]!;

    const startedAt = Date.now();
    const { status, result } = runApply(dep, ['--lock', lock, '--lock-wait', '30']);
    const elapsedMs = Date.now() - startedAt;

    try {
      process.kill(Number(holderPid), 'SIGKILL');
    } catch {
      /* already gone */
    }
    expect(status).toBe(30);
    expect(result.reason).toBe('already_running');
    // It must have declined while the lock was still held — not slipped through
    // after it was released, and not waited out the holder either.
    expect(elapsedMs).toBeLessThan(4000);
    // And nothing was applied on the way out.
    expect(composeUpCalls(dep)).toHaveLength(0);
    expect(fs.readFileSync(dep.envFile, 'utf8')).toContain('0.5.0');
  });

  it('refuses when the deployment already resolves to the target', () => {
    const dep = makeDeployment({ envContent: 'SWARM_OS_IMAGE=ghcr.io/o/r:0.6.0\n' });
    const { status, result } = runApply(dep);
    expect(status).toBe(30);
    expect(result.reason).toBe('already_at_target');
  });
});

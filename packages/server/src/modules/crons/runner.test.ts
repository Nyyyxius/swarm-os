/**
 * CronScriptRunner — the real thing, against real child processes.
 *
 * These tests spawn actual `bash` / `python3`, because every property worth
 * asserting here is a property of the OS interface: that a SIGKILL reaches a
 * GRANDCHILD, that an output overflow is not misreported as a timeout, that the
 * argv carries the realpath rather than the symlink it was asked about, and
 * that the child's environment does NOT contain the server's token. A mocked
 * `child_process` would assert none of that.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CronScriptRunner,
  lastNonEmptyLine,
  parseVerdict,
  uvCacheDir,
  type CronScriptPolicy,
} from './runner.js';

let tmpRoot: string;
let workspaceRoot: string;
let dataDir: string;
let outsideRoot: string;

beforeEach(() => {
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crons-runner-')));
  workspaceRoot = path.join(tmpRoot, 'workspace');
  dataDir = path.join(tmpRoot, 'data');
  outsideRoot = path.join(tmpRoot, 'outside');
  for (const d of [workspaceRoot, dataDir, outsideRoot]) fs.mkdirSync(d, { recursive: true });
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function makeRunner(over: Partial<CronScriptPolicy> = {}): CronScriptRunner {
  return new CronScriptRunner({
    workspaceRoot,
    dataDir,
    timezone: 'Europe/Paris',
    transport: 'local',
    ...over,
  });
}

/** Write a script under a root and return its absolute path. */
function writeScript(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function run(
  runner: CronScriptRunner,
  scriptPath: string,
  over: { interpreter?: string; args?: string[]; timeoutMs?: number | null } = {},
) {
  return runner.run({
    cronId: 'cron_abcdef12',
    cronName: 'jira-dev',
    scriptPath,
    interpreter: over.interpreter ?? 'bash',
    args: over.args ?? [],
    timeoutMs: over.timeoutMs ?? 10_000,
    firedAt: new Date('2026-06-18T20:00:00.000Z'),
  });
}

describe('parsing the contract line', () => {
  it('reads the LAST non-empty line, so a chatty script still works', () => {
    expect(lastNonEmptyLine('log line\nanother\n{"wake":true}\n\n')).toBe('{"wake":true}');
    expect(lastNonEmptyLine('   \n\n')).toBeNull();
  });

  it('accepts {wake} and {wake, message}', () => {
    expect(parseVerdict('{"wake":true,"message":"hi"}')).toEqual({
      ok: true,
      value: { wake: true, message: 'hi' },
    });
    expect(parseVerdict('{"wake":false}')).toEqual({ ok: true, value: { wake: false, message: null } });
  });

  it('refuses anything that is not an object with a boolean wake', () => {
    for (const bad of ['not json', '[1,2]', '"str"', '{"wake":"yes"}', '{"message":"x"}']) {
      expect(parseVerdict(bad).ok).toBe(false);
    }
    expect(parseVerdict(null).ok).toBe(false);
  });
});

describe('CronScriptRunner — the happy contract', () => {
  it('wake:true with a message comes back verbatim', async () => {
    const script = writeScript(
      workspaceRoot,
      'wake.sh',
      'echo "scanning…"\necho \'{"wake": true, "message": "JIRA-42 needs review"}\'\n',
    );
    const res = await run(makeRunner(), script);
    expect(res.ok).toBe(true);
    expect(res.wake).toBe(true);
    expect(res.message).toBe('JIRA-42 needs review');
    expect(res.exitCode).toBe(0);
  });

  it('wake:true without a message gets the default one (an empty inbox message would read as a bug)', async () => {
    const script = writeScript(workspaceRoot, 'bare.sh', 'echo \'{"wake": true}\'\n');
    const res = await run(makeRunner(), script);
    expect(res.ok).toBe(true);
    expect(res.message).toBe('[cron:jira-dev] wake requested');
  });

  it('wake:false is a clean run with nothing to deliver', async () => {
    const script = writeScript(workspaceRoot, 'skip.sh', 'echo \'{"wake": false}\'\n');
    const res = await run(makeRunner(), script);
    expect(res.ok).toBe(true);
    expect(res.wake).toBe(false);
  });

  it('runs a python3 script under /data too (the recommended home for sensitive crons)', async () => {
    const script = writeScript(dataDir, 'crons/probe.py', 'print(\'{"wake": false}\')\n');
    const res = await run(makeRunner(), script, { interpreter: 'python3' });
    expect(res.ok).toBe(true);
    expect(res.wake).toBe(false);
  });

  it('passes scriptArgs through as argv, never through a shell', async () => {
    // A metacharacter-laden argument must arrive as one literal string. If any
    // shell were involved, `;` would split it.
    const script = writeScript(
      workspaceRoot,
      'args.sh',
      'printf \'{"wake": false, "message": "%s"}\\n\' "$1"\n',
    );
    const res = await run(makeRunner(), script, { args: ['a; rm -rf /'] });
    expect(res.ok).toBe(true);
    expect(res.message).toBe('a; rm -rf /');
  });
});

describe('CronScriptRunner — failures are results, never throws', () => {
  it('a non-zero exit is an error carrying the code and the stderr tail', async () => {
    const script = writeScript(workspaceRoot, 'boom.sh', 'echo "traceback here" >&2\nexit 3\n');
    const res = await run(makeRunner(), script);
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(3);
    expect(res.excerpt).toContain('exited with code 3');
    expect(res.excerpt).toContain('traceback here');
  });

  it('unparseable output is an error, not a silent "no wake"', async () => {
    const script = writeScript(workspaceRoot, 'garbage.sh', 'echo "all done, nothing to do"\n');
    const res = await run(makeRunner(), script);
    expect(res.ok).toBe(false);
    expect(res.excerpt).toContain('not JSON');
  });

  it('a script that prints nothing is an error', async () => {
    const script = writeScript(workspaceRoot, 'silent.sh', 'exit 0\n');
    const res = await run(makeRunner(), script);
    expect(res.ok).toBe(false);
    expect(res.excerpt).toContain('printed nothing');
  });

  it('maps ENOENT to "interpreter not found"', async () => {
    const script = writeScript(workspaceRoot, 'ok.sh', 'echo \'{"wake": false}\'\n');
    const realPath = process.env.PATH;
    // The child resolves argv[0] against the env WE build, so emptying PATH is
    // the honest way to reproduce a missing interpreter.
    process.env.PATH = path.join(tmpRoot, 'no-such-bin');
    try {
      const res = await run(makeRunner(), script);
      expect(res.ok).toBe(false);
      expect(res.excerpt).toContain('interpreter not found: bash');
    } finally {
      process.env.PATH = realPath;
    }
  });

  it('maps EACCES to "script is not executable"', async () => {
    const script = writeScript(workspaceRoot, 'ok.sh', 'echo \'{"wake": false}\'\n');
    // A `bash` on PATH that exists but carries no +x bit: exactly the errno the
    // message is written for.
    const fakeBin = path.join(tmpRoot, 'fakebin');
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, 'bash'), '#!/bin/sh\n', { mode: 0o644 });
    const realPath = process.env.PATH;
    process.env.PATH = fakeBin;
    try {
      const res = await run(makeRunner(), script);
      expect(res.ok).toBe(false);
      expect(res.excerpt).toContain('script is not executable');
    } finally {
      process.env.PATH = realPath;
    }
  });

  it('refuses an interpreter outside the allowlist', async () => {
    const script = writeScript(workspaceRoot, 'ok.sh', 'echo \'{"wake": false}\'\n');
    const res = await run(makeRunner(), script, { interpreter: 'perl' });
    expect(res.ok).toBe(false);
    expect(res.excerpt).toContain('interpreter must be one of');
  });
});

describe('CronScriptRunner — path containment', () => {
  it('refuses a path outside both roots', async () => {
    const script = writeScript(outsideRoot, 'evil.sh', 'echo \'{"wake": true}\'\n');
    const res = await run(makeRunner(), script);
    expect(res.ok).toBe(false);
    expect(res.excerpt).toContain('is not under');
  });

  it('refuses a symlink inside the workspace whose target escapes it', async () => {
    const target = writeScript(outsideRoot, 'evil.sh', 'echo \'{"wake": true}\'\n');
    const link = path.join(workspaceRoot, 'innocent.sh');
    fs.symlinkSync(target, link);
    const res = await run(makeRunner(), link);
    expect(res.ok).toBe(false);
    expect(res.excerpt).toContain('is not under');
  });

  it('EXECUTES the realpath, not the name it was given (the TOCTOU half)', async () => {
    // `$0` is argv[1] as bash received it, i.e. exactly what we spawned. If the
    // runner re-validated the path and then spawned the ORIGINAL string, this
    // would come back as the symlink and the containment check would be
    // decorative — a link swapped after validation would still run.
    const real = writeScript(
      workspaceRoot,
      'nested/real.sh',
      'printf \'{"wake": false, "message": "%s"}\\n\' "$0"\n',
    );
    const link = path.join(workspaceRoot, 'link.sh');
    fs.symlinkSync(real, link);
    const res = await run(makeRunner(), link);
    expect(res.ok).toBe(true);
    expect(res.message).toBe(fs.realpathSync(real));
  });

  it('reads a non-root path as workspace-relative under the ssh transport only', async () => {
    writeScript(workspaceRoot, 'rel.sh', 'echo \'{"wake": false}\'\n');
    // Under ssh the operator sees HOST paths, so `/rel.sh` is read as a
    // workspace-relative container path.
    const ssh = makeRunner({ transport: 'ssh' });
    expect(await ssh.resolveScriptPath('/rel.sh')).toBe(fs.realpathSync(path.join(workspaceRoot, 'rel.sh')));
    // …and under `local` no guessing happens: the path is taken literally.
    await expect(makeRunner().resolveScriptPath('/rel.sh')).rejects.toThrow();
  });

  it('never rewrites a /data path into the workspace', async () => {
    const script = writeScript(dataDir, 'crons/probe.sh', 'echo \'{"wake": false}\'\n');
    const ssh = makeRunner({ transport: 'ssh' });
    expect(await ssh.resolveScriptPath(script)).toBe(fs.realpathSync(script));
  });
});

describe('CronScriptRunner — the two ways a run is cut short', () => {
  it('SIGKILLs the whole process group at the timeout, grandchild included', async () => {
    // The script ignores SIGTERM and backgrounds a grandchild that will write a
    // marker if it survives. `execFile`'s own `timeout` (a single SIGTERM to the
    // direct child) would leave that grandchild alive — this is the exact shape
    // of `uv run`, and the reason the runner spawns detached and kills `-pid`.
    const marker = path.join(tmpRoot, 'survived.txt');
    const script = writeScript(
      workspaceRoot,
      'stubborn.sh',
      ['trap "" TERM', '( sleep 1.5; echo alive > "$1" ) &', 'wait', ''].join('\n'),
    );
    const res = await run(makeRunner(), script, { args: [marker], timeoutMs: 300 });
    expect(res.ok).toBe(false);
    expect(res.excerpt).toContain('timed out after 300ms');

    await new Promise((r) => setTimeout(r, 2000));
    expect(fs.existsSync(marker)).toBe(false);
  }, 15_000);

  it('an output overflow is reported as an overflow, NOT as a timeout', async () => {
    // The trap this guards (graphify.ts:131): testing "was it killed?" before
    // "did it overflow?" makes every overflow look like a timeout, and the
    // operator raises the wrong limit.
    const script = writeScript(
      workspaceRoot,
      'chatty.sh',
      ['for i in $(seq 1 2000); do', '  echo "0123456789012345678901234567890123456789"', 'done', 'echo \'{"wake": false}\'', ''].join('\n'),
    );
    const res = await run(makeRunner({ maxOutputBytes: 4096 }), script, { timeoutMs: 10_000 });
    expect(res.ok).toBe(false);
    expect(res.excerpt).toContain('exceeded 4096 bytes');
    expect(res.excerpt).not.toContain('timed out');
  }, 15_000);

  it('bounds the excerpt it hands the store, whatever the script printed', async () => {
    const script = writeScript(
      workspaceRoot,
      'noisy.sh',
      ['for i in $(seq 1 500); do', '  echo "stderr noise line $i" >&2', 'done', 'exit 1', ''].join('\n'),
    );
    const res = await run(makeRunner(), script);
    expect(res.ok).toBe(false);
    // Tails only — the store clamps the rest down to CRON_EXCERPT_MAX_BYTES.
    expect(res.excerpt!.length).toBeLessThan(6000);
    expect(res.excerpt).toContain('stderr noise line 500');
  }, 15_000);
});

describe('CronScriptRunner — the child environment', () => {
  it('exports SWARM_OS_* and the locale/TZ, and leaks NO server secret', async () => {
    const script = writeScript(
      workspaceRoot,
      'env.sh',
      [
        'printf \'{"wake": false, "message": "%s|%s|%s|%s|%s|%s|%s"}\\n\' \\',
        '  "$SWARM_OS_CRON_ID" "$SWARM_OS_CRON_NAME" "$SWARM_OS_FIRE" \\',
        '  "$TZ" "$LC_ALL" "$UV_CACHE_DIR" "${SWARM_OS_TOKEN:-ABSENT}"',
        '',
      ].join('\n'),
    );
    const before = process.env.SWARM_OS_TOKEN;
    process.env.SWARM_OS_TOKEN = 'super-secret-token';
    let res;
    try {
      res = await run(makeRunner(), script);
    } finally {
      if (before === undefined) delete process.env.SWARM_OS_TOKEN;
      else process.env.SWARM_OS_TOKEN = before;
    }
    expect(res.ok).toBe(true);
    const [cronId, cronName, fire, tz, lcAll, uvCache, token] = res.message!.split('|');
    expect(cronId).toBe('cron_abcdef12');
    expect(cronName).toBe('jira-dev');
    expect(fire).toBe('2026-06-18T20:00:00.000Z');
    expect(tz).toBe('Europe/Paris');
    expect(lcAll).toBe('C.UTF-8');
    expect(uvCache).toBe(uvCacheDir(dataDir));
    // The break with graphify/fetch, asserted: an operator script runs with no
    // server token and no provider key.
    expect(token).toBe('ABSENT');
  });

  it('creates the uv cache dir on the first run (so `uv run --with` stops re-downloading)', async () => {
    const script = writeScript(workspaceRoot, 'ok.sh', 'echo \'{"wake": false}\'\n');
    expect(fs.existsSync(uvCacheDir(dataDir))).toBe(false);
    await run(makeRunner(), script);
    expect(fs.existsSync(uvCacheDir(dataDir))).toBe(true);
  });

  it('runs with the script"s own directory as cwd', async () => {
    const script = writeScript(
      workspaceRoot,
      'nested/pwd.sh',
      'printf \'{"wake": false, "message": "%s"}\\n\' "$(pwd)"\n',
    );
    const res = await run(makeRunner(), script);
    expect(res.message).toBe(fs.realpathSync(path.join(workspaceRoot, 'nested')));
  });
});

describe('CronScriptRunner — the shutdown registry', () => {
  it('tracks a live child and killAll() terminates its group', async () => {
    const script = writeScript(workspaceRoot, 'slow.sh', 'sleep 30\necho \'{"wake": false}\'\n');
    const runner = makeRunner();
    const pending = run(runner, script, { timeoutMs: 30_000 });
    // Give spawn a beat to register the child.
    await new Promise((r) => setTimeout(r, 200));
    expect(runner.inFlightCount).toBe(1);

    runner.killAll();
    const res = await pending;
    // Killed mid-flight: not a timeout, not an overflow — a plain failed run.
    expect(res.ok).toBe(false);
    expect(runner.inFlightCount).toBe(0);
  }, 15_000);

  it('killAll() on an idle runner is a no-op', () => {
    expect(makeRunner().killAll()).toEqual([]);
  });
});

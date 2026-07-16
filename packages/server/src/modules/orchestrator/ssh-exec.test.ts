import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync, spawnSync, type spawn as nodeSpawn } from 'node:child_process';
import type { Config } from '../../config.js';
import { shellQuote } from './agent-process.js';
import {
  buildSshBaseArgs,
  buildRemoteCommand,
  translateCwdForHost,
  hostExec,
} from './ssh-exec.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function sshConfig(over: Partial<Config> = {}): Config {
  return {
    agentTransport: 'ssh',
    sshTarget: 'ubuntu@host.docker.internal',
    sshKey: '/host-ssh/id_ed25519',
    sshPort: 22,
    workspaceRoot: '/workspace',
    hostWorkspaceRoot: '/home/ubuntu/projects',
    dataDir: '/data',
    hostDataDir: '/home/ubuntu/data',
    ...over,
  } as unknown as Config;
}

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function makeSpawn() {
  const calls: { file: string; args: string[]; opts: unknown }[] = [];
  let child: FakeChild | undefined;
  const spawnImpl = ((file: string, args: string[], opts: unknown) => {
    calls.push({ file, args, opts });
    const c = new EventEmitter() as FakeChild;
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.kill = vi.fn(() => true);
    child = c;
    return c;
  }) as unknown as typeof nodeSpawn;
  return { spawnImpl, calls, getChild: (): FakeChild => child! };
}

// ---------------------------------------------------------------------------
// shellQuote (reused from agent-process — the quoting host-exec depends on)
// ---------------------------------------------------------------------------

describe('shellQuote', () => {
  it('quotes an empty string as ""', () => {
    expect(shellQuote('')).toBe("''");
  });

  it('wraps a plain token in single quotes', () => {
    expect(shellQuote('foo')).toBe("'foo'");
  });

  it('preserves spaces inside a single token', () => {
    expect(shellQuote('a b c')).toBe("'a b c'");
  });

  it('escapes an embedded single quote with the POSIX close/escape/reopen form', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('leaves double quotes intact (single-quoted context)', () => {
    expect(shellQuote('say "hi"')).toBe(`'say "hi"'`);
  });

  it('neutralises shell metacharacters (no expansion possible)', () => {
    expect(shellQuote('$(rm -rf /); `id` && x | y * ;')).toBe(
      "'$(rm -rf /); `id` && x | y * ;'",
    );
  });
});

// ---------------------------------------------------------------------------
// buildSshBaseArgs
// ---------------------------------------------------------------------------

describe('buildSshBaseArgs', () => {
  it('carries the key, port and target, ends with "--", and allocates NO PTY', () => {
    const args = buildSshBaseArgs(sshConfig({ sshKey: '/k', sshPort: 2222 }));
    expect(args).not.toContain('-tt');
    expect(args).toContain('-i');
    expect(args[args.indexOf('-i') + 1]).toBe('/k');
    expect(args).toContain('-p');
    expect(args[args.indexOf('-p') + 1]).toBe('2222');
    expect(args[args.length - 2]).toBe('ubuntu@host.docker.internal');
    expect(args[args.length - 1]).toBe('--');
  });

  it('sanitises the mux ControlPath key from the target', () => {
    const args = buildSshBaseArgs(sshConfig());
    const cp = args.find((a) => a.startsWith('ControlPath='));
    expect(cp).toBe('ControlPath=/tmp/swarm-os-ssh-mux-ubuntu_host_docker_internal.sock');
  });

  it('throws when sshTarget is null', () => {
    expect(() => buildSshBaseArgs(sshConfig({ sshTarget: null }))).toThrow(/sshTarget/);
  });
});

// ---------------------------------------------------------------------------
// translateCwdForHost
// ---------------------------------------------------------------------------

describe('translateCwdForHost', () => {
  it('maps a /workspace path to hostWorkspaceRoot', () => {
    expect(translateCwdForHost(sshConfig(), '/workspace/my-repo')).toBe(
      '/home/ubuntu/projects/my-repo',
    );
  });

  it('maps the workspace root exactly', () => {
    expect(translateCwdForHost(sshConfig(), '/workspace')).toBe('/home/ubuntu/projects');
  });

  it('maps a /data path to hostDataDir', () => {
    expect(translateCwdForHost(sshConfig(), '/data/plugins/x')).toBe(
      '/home/ubuntu/data/plugins/x',
    );
  });

  it('passes a host-native path through untouched', () => {
    expect(translateCwdForHost(sshConfig(), '/etc/nginx')).toBe('/etc/nginx');
  });

  it('does not treat a /workspace-prefixed sibling dir as inside the workspace', () => {
    // `/workspace-other` must NOT be rewritten (only `/workspace` and `/workspace/…`).
    expect(translateCwdForHost(sshConfig(), '/workspace-other/x')).toBe('/workspace-other/x');
  });
});

// ---------------------------------------------------------------------------
// buildRemoteCommand
// ---------------------------------------------------------------------------

describe('buildRemoteCommand', () => {
  it('builds a bash -lc exec string with each argv element quoted (no cwd)', () => {
    const cmd = buildRemoteCommand(sshConfig(), ['echo', 'hi']);
    expect(cmd).toBe(`bash -lc ${shellQuote("exec 'echo' 'hi'")}`);
  });

  it('prepends a cd to the translated host cwd', () => {
    const cmd = buildRemoteCommand(sshConfig(), ['git', 'status'], { cwd: '/workspace/repo' });
    expect(cmd).toBe(
      `bash -lc ${shellQuote("cd '/home/ubuntu/projects/repo' && exec 'git' 'status'")}`,
    );
  });

  it('wraps in host timeout(1) when timeoutMs is given (ceil to seconds + kill grace)', () => {
    const cmd = buildRemoteCommand(sshConfig(), ['sleep', '99'], { timeoutMs: 4500 });
    // 4500ms → ceil = 5s; --kill-after uses the module grace constant.
    expect(cmd).toBe(`timeout --kill-after=5s 5s bash -lc ${shellQuote("exec 'sleep' '99'")}`);
  });

  it('does not wrap in timeout when timeoutMs is omitted (improve-via-ssh path)', () => {
    const cmd = buildRemoteCommand(sshConfig(), ['echo', 'hi']);
    expect(cmd.startsWith('timeout ')).toBe(false);
    expect(cmd).toBe(`bash -lc ${shellQuote("exec 'echo' 'hi'")}`);
  });

  it('double-quotes so an argument with spaces/quotes cannot break out of its token', () => {
    const argv = ['printf', '%s', "a b'c"];
    const cmd = buildRemoteCommand(sshConfig(), argv);
    // Structure: each argv element is shellQuote'd for the inner shell, and the
    // whole inner string is shellQuote'd again for the outer `bash -lc`. (The
    // POSIX-correctness of the quoting itself is covered by the shellQuote suite.)
    const expectedInner = `exec ${argv.map((a) => shellQuote(a)).join(' ')}`;
    expect(cmd).toBe(`bash -lc ${shellQuote(expectedInner)}`);
  });

  it('produces a command a real bash resolves back to the exact argv (end-to-end)', () => {
    // Prove the double-quoting round-trips: feed the remote command to a real
    // `bash -lc` (standing in for the host login shell) and confirm the program
    // receives the argument verbatim, spaces + single quote intact.
    const nasty = "a b'c$(touch pwned) `id` *";
    const cmd = buildRemoteCommand(sshConfig(), ['printf', '%s', nasty]);
    // Strip the leading `bash -lc ` — ssh would pass the rest to the host shell,
    // which is itself a `bash -lc '<inner>'`. Running it here mirrors that hop.
    // `exec printf` is the LAST thing the (login) shell does, so its output is
    // the trailing bytes — `endsWith` tolerates any benign profile noise while
    // still proving `$(…)`/backticks came through LITERALLY (no substitution).
    const out = execFileSync('bash', ['-c', cmd], { encoding: 'utf8' });
    expect(out.endsWith(nasty)).toBe(true);
  });

  it('the host timeout wrapper actually terminates a long-running child (end-to-end)', () => {
    // A 30s sleep wrapped in a 1s host timeout: a real shell (standing in for
    // the host login shell sshd invokes) must reap it in ~1s, proving the remote
    // process does NOT outlive the timeout — the regression the local ssh kill
    // could not prevent through the ControlMaster mux.
    const cmd = buildRemoteCommand(sshConfig(), ['sleep', '30'], { timeoutMs: 1000 });
    const start = Date.now();
    const r = spawnSync('bash', ['-c', cmd]);
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(15_000); // nowhere near the 30s sleep
    expect(r.status).toBe(124); // GNU timeout's "timed out" exit code
  });
});

// ---------------------------------------------------------------------------
// hostExec
// ---------------------------------------------------------------------------

describe('hostExec', () => {
  it('rejects under the local transport with a clear message', async () => {
    const { spawnImpl, calls } = makeSpawn();
    await expect(
      hostExec(sshConfig({ agentTransport: 'local' }), { argv: ['echo', 'x'] }, { spawnImpl }),
    ).rejects.toThrow(/host-exec requires the ssh agent transport/);
    expect(calls).toHaveLength(0);
  });

  it('rejects an empty argv', async () => {
    const { spawnImpl } = makeSpawn();
    await expect(hostExec(sshConfig(), { argv: [] }, { spawnImpl })).rejects.toThrow(/argv/);
  });

  it('spawns ssh with the base args + remote command and closed stdin', async () => {
    const { spawnImpl, calls, getChild } = makeSpawn();
    const p = hostExec(sshConfig(), { argv: ['echo', 'hi'] }, { spawnImpl });
    const child = getChild();
    child.stdout.emit('data', Buffer.from('hi\n'));
    child.emit('close', 0);
    const res = await p;

    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe('ssh');
    // The default timeout (30s) is applied and threaded into the remote timeout(1) wrapper.
    const expectedArgs = [
      ...buildSshBaseArgs(sshConfig()),
      buildRemoteCommand(sshConfig(), ['echo', 'hi'], { timeoutMs: 30_000 }),
    ];
    expect(calls[0]!.args).toEqual(expectedArgs);
    // The remote command carries the host timeout(1) guard (regression fix).
    expect(calls[0]!.args[calls[0]!.args.length - 1]).toMatch(/^timeout --kill-after=5s 30s bash -lc /);
    expect(calls[0]!.opts).toMatchObject({ stdio: ['ignore', 'pipe', 'pipe'] });
    expect(res).toEqual({ code: 0, stdout: 'hi\n', stderr: '', timedOut: false });
  });

  it('resolves (does not reject) on a non-zero exit and captures stderr', async () => {
    const { spawnImpl, getChild } = makeSpawn();
    const p = hostExec(sshConfig(), { argv: ['false'] }, { spawnImpl });
    const child = getChild();
    child.stderr.emit('data', Buffer.from('boom'));
    child.emit('close', 3);
    const res = await p;
    expect(res.code).toBe(3);
    expect(res.stderr).toBe('boom');
    expect(res.timedOut).toBe(false);
  });

  it('truncates a stream at maxOutputBytes with a marker', async () => {
    const { spawnImpl, getChild } = makeSpawn();
    const p = hostExec(sshConfig(), { argv: ['cat'], maxOutputBytes: 5 }, { spawnImpl });
    const child = getChild();
    child.stdout.emit('data', Buffer.from('abcdefgh'));
    child.emit('close', 0);
    const res = await p;
    expect(res.stdout).toBe('abcde\n[output truncated at 5 bytes]');
  });

  it('kills the ssh process on timeout and reports timedOut with a null code', async () => {
    const { spawnImpl, getChild } = makeSpawn();
    const p = hostExec(sshConfig(), { argv: ['sleep', '99'], timeoutMs: 20 }, { spawnImpl });
    const child = getChild();
    // Let the 20ms timer fire.
    await new Promise((r) => setTimeout(r, 45));
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    // A killed ssh then closes with a null code (terminated by signal).
    child.emit('close', null);
    const res = await p;
    expect(res.timedOut).toBe(true);
    expect(res.code).toBeNull();
  });

  it('rejects when the ssh binary fails to spawn', async () => {
    const { spawnImpl, getChild } = makeSpawn();
    const p = hostExec(sshConfig(), { argv: ['echo'] }, { spawnImpl });
    getChild().emit('error', new Error('spawn ssh ENOENT'));
    await expect(p).rejects.toThrow(/ENOENT/);
  });
});

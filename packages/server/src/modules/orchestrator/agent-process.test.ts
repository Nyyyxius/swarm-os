import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FakeAgentProcess, buildRemoteCommand, shellQuote } from './agent-process.js';

/**
 * Phase 7 — FakeAgentProcess scripted behaviours.
 *
 * The fake is the substrate every other server test sits on top of, so its
 * shape needs to be solid: scripted output, deterministic exit, recorded
 * writes.
 */

function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

describe('FakeAgentProcess', () => {
  it('records every write the orchestrator makes', () => {
    const fake = new FakeAgentProcess({ command: 'fake', args: [], cwd: '/tmp' });
    fake.write('hello');
    fake.write('world');
    expect(fake.writes).toEqual(['hello', 'world']);
  });

  it('emits scripted data to subscribers', () => {
    const fake = new FakeAgentProcess({ command: 'fake', args: [], cwd: '/tmp' });
    const seen: string[] = [];
    fake.onData((d) => seen.push(d));
    fake._emitData('one');
    fake._emitData('two');
    expect(seen).toEqual(['one', 'two']);
  });

  it('lets a subscriber unsubscribe via the returned Disposable', () => {
    const fake = new FakeAgentProcess({ command: 'fake', args: [], cwd: '/tmp' });
    const seen: string[] = [];
    const sub = fake.onData((d) => seen.push(d));
    fake._emitData('one');
    sub.dispose();
    fake._emitData('two');
    expect(seen).toEqual(['one']);
  });

  it('_simulateExit fires onExit asynchronously and stops further data', async () => {
    const fake = new FakeAgentProcess({ command: 'fake', args: [], cwd: '/tmp' });
    let exitInfo: { exitCode: number; signal?: number } | null = null;
    fake.onExit((info) => {
      exitInfo = info;
    });
    fake._simulateExit({ exitCode: 99 });
    await tick();
    expect(exitInfo).toEqual({ exitCode: 99 });
    // Subsequent writes are silently dropped.
    fake.write('after-exit');
    expect(fake.writes).not.toContain('after-exit');
  });

  it('kill(SIGTERM) emits exit code 143', async () => {
    const fake = new FakeAgentProcess({ command: 'fake', args: [], cwd: '/tmp' });
    let exitInfo: { exitCode: number } | null = null;
    fake.onExit((info) => {
      exitInfo = info;
    });
    fake.kill('SIGTERM');
    await tick();
    expect(exitInfo?.exitCode).toBe(143);
  });

  it('kill(SIGKILL) emits exit code 137', async () => {
    const fake = new FakeAgentProcess({ command: 'fake', args: [], cwd: '/tmp' });
    let exitInfo: { exitCode: number } | null = null;
    fake.onExit((info) => {
      exitInfo = info;
    });
    fake.kill('SIGKILL');
    await tick();
    expect(exitInfo?.exitCode).toBe(137);
  });

  it('kill is idempotent — second kill is a no-op', async () => {
    const fake = new FakeAgentProcess({ command: 'fake', args: [], cwd: '/tmp' });
    let count = 0;
    fake.onExit(() => count++);
    fake.kill('SIGTERM');
    fake.kill('SIGTERM');
    await tick();
    expect(count).toBe(1);
  });

  it('late onExit subscriber gets a synthetic exit code 0 (best-effort signal)', async () => {
    const fake = new FakeAgentProcess({ command: 'fake', args: [], cwd: '/tmp' });
    fake._simulateExit({ exitCode: 7 });
    await tick();
    let info: { exitCode: number } | null = null;
    fake.onExit((i) => {
      info = i;
    });
    await tick();
    expect(info?.exitCode).toBe(0);
  });

  it('uses the supplied pid', () => {
    const fake = new FakeAgentProcess({ command: 'fake', args: [], cwd: '/tmp', pid: 42 });
    expect(fake.pid).toBe(42);
  });
});

/**
 * The remote command string — parsed by bash ON ANOTHER MACHINE, so a quoting
 * slip is not a type error but an agent that never starts.
 *
 * `remoteEnvFile` (Lot 9a) is the additive option that keeps secrets off that
 * command line, which every user on the host can read through `ps`.
 */
describe('buildRemoteCommand', () => {
  const base = {
    remoteCwd: '/home/ubuntu/projects/repo',
    remoteCommand: 'claude',
    args: ['--model', 'claude-opus-4-8', 'do the thing'],
  };

  it('is BYTE FOR BYTE the historical form when no env file is asked for', () => {
    // The golden tests in `providers/claude.test.ts` freeze the argv and env of
    // claude/codex/gemini; this freezes the string they are assembled into. A
    // provider with no secrets must not pay for opencode's needs.
    const cmd = buildRemoteCommand({
      ...base,
      remoteEnv: { CLAUDE_CONFIG_DIR: '/host/data/.claude-runtime/sessions/s1' },
    });
    expect(cmd).toBe(
      `bash -lc ${shellQuote(
        "cd '/home/ubuntu/projects/repo' && exec env " +
          "CLAUDE_CONFIG_DIR='/host/data/.claude-runtime/sessions/s1' " +
          "'claude' '--model' 'claude-opus-4-8' 'do the thing'",
      )}`,
    );
  });

  it('drops the `env` prefix entirely when there is nothing to export', () => {
    expect(buildRemoteCommand(base)).toBe(
      `bash -lc ${shellQuote(
        "cd '/home/ubuntu/projects/repo' && exec 'claude' '--model' " +
          "'claude-opus-4-8' 'do the thing'",
      )}`,
    );
  });

  it('sources the env file before exec, and never names its contents', () => {
    const cmd = buildRemoteCommand({
      ...base,
      remoteCommand: 'opencode',
      args: ['--auto'],
      remoteEnvFile: '/host/data/.claude-runtime/opencode/s1/.swarm-agent-env',
    });
    expect(cmd).toBe(
      `bash -lc ${shellQuote(
        "cd '/home/ubuntu/projects/repo' && set -a && " +
          ". '/host/data/.claude-runtime/opencode/s1/.swarm-agent-env' && set +a && " +
          "exec 'opencode' '--auto'",
      )}`,
    );
  });

  it('really exports the file’s values to the exec’d program (run through bash)', () => {
    // The point of `set -a`: assignments in a sourced file are NOT exported by
    // default, so without it the agent would see none of them. Executed here
    // because this is shell semantics, not TypeScript.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-remote-env-'));
    try {
      const file = path.join(dir, '.swarm-agent-env');
      // Values as `Session._writeSecretEnvFile` writes them: POSIX single-quoted,
      // including the awkward ones (a quote, a space, a newline, JSON braces).
      fs.writeFileSync(
        file,
        [
          `OPENROUTER_API_KEY=${shellQuote("sk-or-v1 'quoted' $NOT_EXPANDED")}`,
          `OPENCODE_CONFIG_CONTENT=${shellQuote('{"mcp":{"team":{"url":"http://x/y"}}}')}`,
          `MULTILINE=${shellQuote('one\ntwo')}`,
          '',
        ].join('\n'),
        { mode: 0o600 },
      );
      const cmd = buildRemoteCommand({
        remoteCwd: dir,
        remoteEnvFile: file,
        remoteCommand: 'printenv',
        args: ['OPENROUTER_API_KEY'],
      });
      // `buildRemoteCommand` returns `bash -lc '<inner>'`; ssh hands that to the
      // host shell. Strip the wrapper and run the inner string the same way.
      const inner = cmd.replace(/^bash -lc /, '');
      const out = execFileSync('bash', ['-lc', `bash -lc ${inner}`], { encoding: 'utf8' });
      expect(out.trim()).toBe("sk-or-v1 'quoted' $NOT_EXPANDED");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still applies the non-secret env when both are present', () => {
    const cmd = buildRemoteCommand({
      ...base,
      remoteCommand: 'printenv',
      args: ['PUBLIC_ONE'],
      remoteEnv: { PUBLIC_ONE: 'visible' },
      remoteEnvFile: '/tmp/does-not-matter',
    });
    // The whole inner string is single-quoted for `bash -lc`, so compare against
    // the quoted form rather than searching for a raw substring.
    expect(cmd).toBe(
      `bash -lc ${shellQuote(
        "cd '/home/ubuntu/projects/repo' && set -a && . '/tmp/does-not-matter' && " +
          "set +a && exec env PUBLIC_ONE='visible' 'printenv' 'PUBLIC_ONE'",
      )}`,
    );
  });
});

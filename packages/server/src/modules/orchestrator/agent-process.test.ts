import { describe, it, expect } from 'vitest';
import { FakeAgentProcess } from './agent-process.js';

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

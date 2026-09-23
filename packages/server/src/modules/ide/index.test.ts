import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IdeSupervisor } from './index.js';
import type { Config } from '../../config.js';

/**
 * Lot 3 — the IDE becomes enable/disable-able at runtime, so the supervisor
 * must be RE-STARTABLE: `stop()` latches `stopping=true` and grows `restarts`,
 * and a naive `start()` would bail on them, leaving the re-start silently inert.
 * These tests drive a fake CLI (a shell script that records each launch and
 * sleeps) so a full disable→enable→respawn cycle is observable without a real
 * VS Code payload.
 */

let dir: string;
let marker: string;
let cli: string;
let supervisors: IdeSupervisor[] = [];

/** Count the launches the fake CLI recorded (one line per spawn). */
function launchCount(): number {
  if (!fs.existsSync(marker)) return 0;
  return fs
    .readFileSync(marker, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0).length;
}

/** Poll until `pred()` holds or the deadline passes. */
async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

function makeConfig(cliPath: string): Config {
  return {
    ideCliPath: cliPath,
    idePort: 8790,
    ideBasePath: '/ide',
    ideToken: 'test-token',
    ideServerDataDir: path.join(dir, 'server-data'),
    ideCliDataDir: path.join(dir, 'cli'),
    workspaceRoot: path.join(dir, 'workspace'),
    // `ideEnabled` is no longer read by the supervisor (the registry governs it),
    // but keep the field present so the cast is honest.
    ideEnabled: true,
  } as unknown as Config;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-sup-'));
  marker = path.join(dir, 'launches.log');
  cli = path.join(dir, 'fake-code');
  // A stand-in for `code`: record the launch, then block on SIGTERM. `exec` so
  // the signal reaches `sleep` directly (sh is replaced by it).
  fs.writeFileSync(cli, `#!/bin/sh\necho x >> "${marker}"\nexec sleep 30\n`, { mode: 0o755 });
  supervisors = [];
});

afterEach(async () => {
  await Promise.all(supervisors.map((s) => s.stop().catch(() => undefined)));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('IdeSupervisor', () => {
  it('respawns across a stop → start cycle (the disable→enable path)', async () => {
    const sup = new IdeSupervisor(makeConfig(cli));
    supervisors.push(sup);

    sup.start();
    await waitFor(() => launchCount() === 1);
    expect(launchCount()).toBe(1);

    await sup.stop();

    // A re-start after stop() must actually respawn — the crux of Lot 3.
    sup.start();
    await waitFor(() => launchCount() === 2);
    expect(launchCount()).toBe(2);

    await sup.stop();
  });

  it('start() is idempotent — a live child is not double-spawned', async () => {
    const sup = new IdeSupervisor(makeConfig(cli));
    supervisors.push(sup);

    sup.start();
    await waitFor(() => launchCount() === 1);
    sup.start(); // already running → no second serve-web
    // Give a spurious spawn a chance to show up, then assert it did not.
    await new Promise((r) => setTimeout(r, 150));
    expect(launchCount()).toBe(1);

    await sup.stop();
  });

  it('no-ops (and does not throw) when the VS Code CLI is absent', async () => {
    const sup = new IdeSupervisor(makeConfig(path.join(dir, 'does-not-exist')));
    supervisors.push(sup);

    expect(() => sup.start()).not.toThrow();
    await new Promise((r) => setTimeout(r, 100));
    expect(launchCount()).toBe(0);
  });

  it('stop() is idempotent and awaitable when never started', async () => {
    const sup = new IdeSupervisor(makeConfig(cli));
    supervisors.push(sup);
    await expect(sup.stop()).resolves.toBeUndefined();
    await expect(sup.stop()).resolves.toBeUndefined();
  });
});

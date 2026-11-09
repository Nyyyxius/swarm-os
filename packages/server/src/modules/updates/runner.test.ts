/**
 * The apply/schedule state machine, with the host script replaced by a fake
 * that writes the same files the real one does.
 *
 * Nothing here touches docker, ssh or a container — the run directory IS the
 * interface (§D.4), so a test can be the script simply by writing
 * `events.ndjson`, `heartbeat` and `result.json`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../../config.js';
import { SwarmDb } from '../db/index.js';
import { UpdateStore } from './store.js';
import {
  UpdateRunner,
  UpdateBusyError,
  UpdateInvalidInputError,
  resolveGraceSeconds,
  retagImage,
  warningText,
  MIN_GRACE_SECONDS,
  DEFAULT_GRACE_SECONDS,
  type ActiveTeam,
  type GraceEndReason,
  type LeadNoticeOutcome,
  type TeamsPort,
} from './runner.js';

let dir: string;
let db: SwarmDb;
let store: UpdateStore;
let runners: UpdateRunner[];

function config(over: Partial<Config> = {}): Config {
  return {
    dataDir: dir,
    hostDataDir: '/host/data',
    agentTransport: 'ssh',
    sshTarget: 'ubuntu@host',
    port: 8787,
    image: 'ghcr.io/o/r:0.5.0',
    version: '0.5.0',
    ...over,
  } as unknown as Config;
}

interface Harness {
  runner: UpdateRunner;
  spawned: string[][];
  hostRuns: string[][];
  /** Timeout each `hostRun` was given — the boot path must not use the long one. */
  hostRunTimeouts: number[];
}

function makeRunner(over: {
  cfg?: Partial<Config>;
  teams?: TeamsPort;
  spawnFails?: boolean;
  /** The host job detached before the launcher gave up — it touched its run dir. */
  jobStarted?: boolean;
  hostRunCode?: number;
} = {}): Harness {
  const spawned: string[][] = [];
  const hostRuns: string[][] = [];
  const hostRunTimeouts: number[] = [];
  const runner = new UpdateRunner({
    config: config(over.cfg),
    store,
    teams: over.teams,
    pollIntervalMs: 10,
    // The script is not run; the tests write the run directory themselves.
    installScript: () => ({ path: path.join(dir, 'updater', 'host-update.sh'), sha256: 'deadbeef', version: '1.0.0' }),
    verifyScript: () => undefined,
    spawnJob: async (argv) => {
      spawned.push(argv);
      if (over.jobStarted) {
        // `setsid bash -c … &` detaches long before the 15 s ssh launcher gives
        // up, so the script is already writing its run directory.
        const hostRunDir = argv[argv.indexOf('--run-dir') + 1]!;
        beat(path.basename(hostRunDir));
      }
      if (over.spawnFails) throw new Error('ssh: connect to host port 22: Connection refused');
      return { jobId: 'job-1' };
    },
    hostRun: async (argv, timeoutMs) => {
      hostRuns.push(argv);
      hostRunTimeouts.push(timeoutMs);
      return { code: over.hostRunCode ?? 0 };
    },
  });
  runners.push(runner);
  return { runner, spawned, hostRuns, hostRunTimeouts };
}

function runDirOf(runId: string): string {
  return path.join(dir, 'updater', 'runs', runId);
}

/** Play the host script: append a phase record to `events.ndjson`. */
function emit(runId: string, phase: string, extra: Record<string, unknown> = {}): void {
  fs.appendFileSync(
    path.join(runDirOf(runId), 'events.ndjson'),
    JSON.stringify({ ts: new Date().toISOString(), script_version: '1.0.0', run_id: runId, phase, ...extra }) + '\n',
  );
}

function beat(runId: string): void {
  fs.writeFileSync(path.join(runDirOf(runId), 'heartbeat'), '');
}

function writeResult(runId: string, result: Record<string, unknown>): void {
  fs.writeFileSync(path.join(runDirOf(runId), 'result.json'), JSON.stringify(result));
}

async function settle(ms = 40): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-runner-'));
  db = new SwarmDb(dir);
  store = new UpdateStore(db);
  runners = [];
});

afterEach(() => {
  for (const r of runners) r.stop();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('resolveGraceSeconds', () => {
  it('is 0 — and only 0 — when no team is active', () => {
    expect(resolveGraceSeconds(undefined, 0)).toBe(0);
    expect(resolveGraceSeconds(0, 0)).toBe(0);
    expect(resolveGraceSeconds(9999, 0)).toBe(0);
  });

  it('defaults to 300 s and floors everything else at 120 s', () => {
    expect(resolveGraceSeconds(undefined, 1)).toBe(DEFAULT_GRACE_SECONDS);
    // Below two minutes a lead mid-turn has no realistic chance of reaching an
    // idle boundary, reading the notice and wrapping up. That is an
    // announcement, not a warning.
    expect(resolveGraceSeconds(0, 1)).toBe(MIN_GRACE_SECONDS);
    expect(resolveGraceSeconds(30, 2)).toBe(MIN_GRACE_SECONDS);
    expect(resolveGraceSeconds(600, 1)).toBe(600);
  });
});

describe('retagImage', () => {
  it('replaces the tag and leaves registry host + path alone', () => {
    expect(retagImage('ghcr.io/nyyyxius/swarm-os:0.5.0', '0.6.0')).toBe(
      'ghcr.io/nyyyxius/swarm-os:0.6.0',
    );
    expect(retagImage('ghcr.io/o/r', '0.6.0')).toBe('ghcr.io/o/r:0.6.0');
  });

  it('does not mistake a registry PORT for a tag', () => {
    expect(retagImage('registry.local:5000/o/r', '1.0')).toBe('registry.local:5000/o/r:1.0');
  });

  it('refuses a digest-pinned reference', () => {
    expect(() => retagImage(`ghcr.io/o/r@sha256:${'a'.repeat(64)}`, '1.0')).toThrow(
      UpdateInvalidInputError,
    );
  });
});

describe('warningText', () => {
  it('says what happens, when, and that it happens anyway', () => {
    const t = warningText('ghcr.io/o/r:0.6.0', 300);
    expect(t).toContain('ghcr.io/o/r:0.6.0');
    expect(t).toContain('5m');
    // The deadline is not negotiable: a live agent may not veto an operator.
    expect(t).toMatch(/proceeds at the deadline/);
  });
});

// ---------------------------------------------------------------------------

describe('apply', () => {
  it('spawns immediately when no team is active, and records the run', async () => {
    const h = makeRunner();
    const { runId } = await h.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    expect(h.spawned).toHaveLength(1);
    const argv = h.spawned[0]!;
    expect(argv[0]).toBe('bash');
    expect(argv).toContain('apply');
    expect(argv).toContain('ghcr.io/o/r:0.6.0');
    // The run dir is passed as a HOST path — the script runs on the host.
    expect(argv[argv.indexOf('--run-dir') + 1]).toBe(`/host/data/updater/runs/${runId}`);
    expect(argv[argv.indexOf('--host-data-dir') + 1]).toBe('/host/data');
    const row = store.get(runId)!;
    expect(['preflight', 'applying', 'verifying']).toContain(row.state);
    expect(row.target_version).toBe('0.6.0');
    expect(fs.existsSync(runDirOf(runId))).toBe(true);
  });

  it('creates the run directory 0700, not inheriting /data', async () => {
    const h = makeRunner();
    const { runId } = await h.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    expect(fs.statSync(runDirOf(runId)).mode & 0o777).toBe(0o700);
  });

  it('answers 409-shaped when a run is already in flight', async () => {
    const h = makeRunner();
    await h.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    await expect(h.runner.apply({ targetVersion: '0.6.0' })).rejects.toBeInstanceOf(UpdateBusyError);
  });

  it('refuses a version this deployment cannot express as an image', async () => {
    const h = makeRunner({ cfg: { image: null } });
    await expect(h.runner.apply({ targetVersion: '0.6.0' })).rejects.toBeInstanceOf(
      UpdateInvalidInputError,
    );
    expect(store.listRecent()).toHaveLength(0);
  });

  it('REFUSES (not fails) without the ssh transport — nothing can be touched', async () => {
    const h = makeRunner({ cfg: { agentTransport: 'local', hostDataDir: null } });
    const { runId } = await h.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    expect(h.spawned).toHaveLength(0);
    expect(store.get(runId)!.state).toBe('refused');
  });

  it('REFUSES when the launcher itself fails — the script never ran', async () => {
    // `spawnHostJob` rejecting means no detached shell exists, so nothing on
    // the host was touched. That is a refusal, not a failure.
    const h = makeRunner({ spawnFails: true });
    const { runId } = await h.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    expect(store.get(runId)!.state).toBe('refused');
    expect(store.get(runId)!.error).toContain('could not be launched');
  });

  it('does NOT claim refused when the launcher gave up on a job that had started', async () => {
    // `spawnHostJob` rejects on `res.timedOut` (a 15 s ssh launcher), but
    // `setsid bash -c … &` detached long before that: a stalled ssh return and
    // a job that never launched are the same value. Claiming `refused`
    // ("nothing on the host was touched") would stop the watch while the script
    // rewrites `.env` and recreates this container.
    const h = makeRunner({ spawnFails: true, jobStarted: true });
    const { runId } = await h.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    expect(store.get(runId)!.state).not.toBe('refused');
    // …and it concludes from the run directory like any other run.
    writeResult(runId, { state: 'success', verify: 'boot_complete', message: 'ok' });
    await settle();
    expect(store.get(runId)!.state).toBe('success');
  });

  it('writes job.json AFTER the spawn, and nothing depends on it', async () => {
    const h = makeRunner();
    const { runId } = await h.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    // `spawnHostJob` mints its jobId internally and returns it only once the
    // pid file lands, so persisting it "before the spawn" is impossible.
    const ref = JSON.parse(fs.readFileSync(path.join(runDirOf(runId), 'job.json'), 'utf8')) as {
      jobId: string;
    };
    expect(ref.jobId).toBe('job-1');
  });
});

describe('watching a run through the run directory', () => {
  it('follows the script’s phases into the persisted state', async () => {
    const h = makeRunner();
    const { runId } = await h.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    beat(runId);
    emit(runId, 'pulling');
    await settle();
    expect(store.get(runId)!.state).toBe('preflight');
    emit(runId, 'env_written', { env_file: '/srv/.env', env_line_before_b64: Buffer.from('SWARM_OS_IMAGE=ghcr.io/o/r:0.5.0').toString('base64') });
    beat(runId);
    await settle();
    const row = store.get(runId)!;
    expect(row.state).toBe('applying');
    // The rollback token is captured the moment the script reports it — long
    // before the run ends, because the run may never reach us.
    expect(row.env_file).toBe('/srv/.env');
    expect(row.env_line_before).toBe('SWARM_OS_IMAGE=ghcr.io/o/r:0.5.0');
  });

  it('concludes from result.json, which is authoritative', async () => {
    const h = makeRunner();
    const { runId } = await h.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    beat(runId);
    writeResult(runId, {
      state: 'success',
      exit_code: 0,
      reason: 'verified',
      verify: 'boot_complete',
      message: 'Updated to ghcr.io/o/r:0.6.0',
      finished_at: '2026-07-26T00:00:00Z',
      script_version: '1.0.0',
    });
    await settle();
    const row = store.get(runId)!;
    expect(row.state).toBe('success');
    expect(row.finished_at).toBe('2026-07-26T00:00:00Z');
    expect(h.runner.currentRun()).toBeNull();
  });

  it('records "healthy but never boot_complete" as SUCCESS with a review note', async () => {
    const h = makeRunner();
    const { runId } = await h.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    beat(runId);
    writeResult(runId, { state: 'success', verify: 'healthy_no_boot_complete', message: 'Updated.' });
    await settle();
    const row = store.get(runId)!;
    expect(row.state).toBe('success');
    expect(row.error).toContain('manual review');
  });

  it('maps rolled_back / failed / refused straight through', async () => {
    for (const state of ['rolled_back', 'failed', 'refused'] as const) {
      const h = makeRunner();
      const { runId } = await h.runner.apply({ targetVersion: '0.6.0' });
      await settle();
      beat(runId);
      writeResult(runId, { state, message: `it went ${state}` });
      await settle();
      expect(store.get(runId)!.state).toBe(state);
      h.runner.stop();
      store.patch(runId, { state });
    }
  });
});

/**
 * The `abandoned` handler repairs a half-written `.env` only when there is NO
 * `result.json`. A SIGTERM during `compose up` (host reboot, `killJob`, OOM)
 * writes one — `failed`, `env_written`, not `deployed` — and the operator's
 * file is then pointing at an image that is not running.
 */
describe('a failed run that wrote the env line but never deployed', () => {
  const B64 = Buffer.from('SWARM_OS_IMAGE=ghcr.io/o/r:0.5.0').toString('base64');

  it('puts the env line back', async () => {
    const h = makeRunner();
    const { runId } = await h.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    beat(runId);
    writeResult(runId, {
      state: 'failed',
      reason: 'compose_up_failed',
      message: 'docker compose up -d was killed',
      env_file: '/srv/.env',
      env_line_before_b64: B64,
      env_written: true,
      deployed: false,
    });
    await settle();
    expect(store.get(runId)!.state).toBe('failed');
    expect(h.hostRuns).toHaveLength(1);
    const argv = h.hostRuns[0]!;
    expect(argv).toContain('restore-env');
    expect(Buffer.from(argv[argv.indexOf('--line-b64') + 1]!, 'base64').toString()).toBe(
      'SWARM_OS_IMAGE=ghcr.io/o/r:0.5.0',
    );
    // The run's own message says what was done to the operator's file.
    expect(store.get(runId)!.error).toContain('has been restored');
    expect(store.get(runId)!.error).toContain('was killed');
  });

  it('says so loudly when that restore fails too', async () => {
    const h = makeRunner({ hostRunCode: 30 });
    const { runId } = await h.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    beat(runId);
    writeResult(runId, { state: 'failed', env_file: '/srv/.env', env_line_before_b64: B64, env_written: true });
    await settle();
    expect(store.get(runId)!.error).toContain('restoring it FAILED');
  });

  it('leaves it alone once the run got as far as deploying', async () => {
    const h = makeRunner();
    const { runId } = await h.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    beat(runId);
    writeResult(runId, {
      state: 'failed',
      env_file: '/srv/.env',
      env_line_before_b64: B64,
      env_written: true,
      deployed: true,
    });
    await settle();
    // The new image IS what is running; putting the old line back would make
    // the next reboot undo a deployment that succeeded.
    expect(h.hostRuns).toHaveLength(0);
  });

  it('leaves a rolled_back run alone — the script already restored it', async () => {
    const h = makeRunner();
    const { runId } = await h.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    beat(runId);
    writeResult(runId, {
      state: 'rolled_back',
      env_file: '/srv/.env',
      env_line_before_b64: B64,
      env_written: true,
      deployed: false,
    });
    await settle();
    expect(h.hostRuns).toHaveLength(0);
  });
});

describe('abandoned runs', () => {
  it('abandons a run whose heartbeat went stale with no result', async () => {
    const h = makeRunner();
    const { runId } = await h.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    // Backdate the heartbeat past the 30 s staleness window.
    const hb = path.join(runDirOf(runId), 'heartbeat');
    fs.writeFileSync(hb, '');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(hb, old, old);
    await settle(60);
    const row = store.get(runId)!;
    expect(row.state).toBe('abandoned');
    expect(row.error).toContain('without recording a verdict');
  });

  it('restores the env line when it was written but never deployed', async () => {
    const h = makeRunner();
    const { runId } = await h.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    emit(runId, 'env_written', {
      env_file: '/srv/.env',
      env_line_before_b64: Buffer.from('SWARM_OS_IMAGE=ghcr.io/o/r:0.5.0').toString('base64'),
    });
    const hb = path.join(runDirOf(runId), 'heartbeat');
    fs.writeFileSync(hb, '');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(hb, old, old);
    await settle(80);
    expect(store.get(runId)!.state).toBe('abandoned');
    // The operator's file points at an image that is not running: put it back.
    expect(h.hostRuns).toHaveLength(1);
    const argv = h.hostRuns[0]!;
    expect(argv).toContain('restore-env');
    expect(Buffer.from(argv[argv.indexOf('--line-b64') + 1]!, 'base64').toString()).toBe(
      'SWARM_OS_IMAGE=ghcr.io/o/r:0.5.0',
    );
    expect(store.get(runId)!.error).toContain('has been restored');
  });

  it('does NOT restore when the run got as far as deploying', async () => {
    const h = makeRunner();
    const { runId } = await h.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    emit(runId, 'env_written', {
      env_file: '/srv/.env',
      env_line_before_b64: Buffer.from('SWARM_OS_IMAGE=ghcr.io/o/r:0.5.0').toString('base64'),
    });
    emit(runId, 'deployed');
    const hb = path.join(runDirOf(runId), 'heartbeat');
    fs.writeFileSync(hb, '');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(hb, old, old);
    await settle(80);
    expect(store.get(runId)!.state).toBe('abandoned');
    expect(h.hostRuns).toHaveLength(0);
  });

  it('re-arms the watch when the abandon write itself fails', async () => {
    // `store.patch` throwing (full disk, SQLITE_BUSY) used to be logged and
    // dropped with the watch already stopped: the row stayed non-terminal, so
    // `isBusy()` was true forever and every POST /updates/apply answered 409
    // with no way out but a DB edit.
    const h = makeRunner();
    const { runId } = await h.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    const hb = path.join(runDirOf(runId), 'heartbeat');
    fs.writeFileSync(hb, '');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(hb, old, old);
    const real = store.patch.bind(store);
    let refused = 0;
    const spy = vi.spyOn(store, 'patch').mockImplementation((id, fields) => {
      if (fields.state === 'abandoned' && refused === 0) {
        refused++;
        throw new Error('SQLITE_BUSY: database is locked');
      }
      real(id, fields);
    });
    await settle(200);
    spy.mockRestore();
    expect(refused).toBe(1);
    expect(store.get(runId)!.state).toBe('abandoned');
    expect(h.runner.isBusy()).toBe(false);
  });

  it('says so loudly when the restore itself fails', async () => {
    const h = makeRunner({ hostRunCode: 30 });
    const { runId } = await h.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    emit(runId, 'env_written', {
      env_file: '/srv/.env',
      env_line_before_b64: Buffer.from('SWARM_OS_IMAGE=ghcr.io/o/r:0.5.0').toString('base64'),
    });
    const hb = path.join(runDirOf(runId), 'heartbeat');
    fs.writeFileSync(hb, '');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(hb, old, old);
    await settle(80);
    expect(store.get(runId)!.error).toContain('restoring it FAILED');
  });
});

describe('warning the teams', () => {
  function teamsPort(teams: ActiveTeam[], outcome: Partial<LeadNoticeOutcome> = {}): TeamsPort {
    return {
      listActiveTeams: () => teams,
      warnLead: async () => ({ signalled: true, read: true, state: 'read', ...outcome }),
    };
  }

  it('snapshots the live teams BEFORE anything happens', async () => {
    const teams: ActiveTeam[] = [{ orchestratorId: 'o1', name: 'stiix-infra', leadSessionId: 's1' }];
    const h = makeRunner({ teams: teamsPort(teams) });
    const { runId } = await h.runner.apply({ targetVersion: '0.6.0', graceSeconds: 120 });
    await settle();
    // By the time the new container boots, the DB rows are all `interrupted`;
    // this snapshot is the only record of what was alive.
    expect(JSON.parse(store.get(runId)!.teams_snapshot_json!)).toEqual(teams);
    expect(store.get(runId)!.state).toBe('warning_teams');
    expect(h.spawned).toHaveLength(0);
  });

  it('records HOW each lead received the notice, not a count', async () => {
    const teams: ActiveTeam[] = [{ orchestratorId: 'o1', name: 'stiix-infra', leadSessionId: 's1' }];
    const h = makeRunner({
      teams: teamsPort(teams, { signalled: true, read: false, state: 'queued_unread' }),
    });
    const { runId } = await h.runner.apply({ targetVersion: '0.6.0', graceSeconds: 120 });
    await settle();
    const warned = JSON.parse(store.get(runId)!.teams_warned_json!) as Array<Record<string, unknown>>;
    expect(warned).toEqual([
      {
        orch_id: 'o1',
        orch_name: 'stiix-infra',
        lead_id: 's1',
        signalled: true,
        read: false,
        state: 'queued_unread',
      },
    ]);
  });

  /**
   * The one sentence this feature exists to get right — "these three teams are
   * about to be interrupted" — is read off `teams_warned_json`. It used to stay
   * null until the deadline, i.e. for exactly as long as anyone is looking at
   * the countdown, which renders as "no team is active, nothing to interrupt"
   * while three teams are about to die.
   */
  describe('the record during the window', () => {
    const TWO: ActiveTeam[] = [
      { orchestratorId: 'o1', name: 'stiix-infra', leadSessionId: 's1' },
      { orchestratorId: 'o2', name: 'trader', leadSessionId: 's2' },
    ];

    it('lists every snapshot team as soon as the window opens', async () => {
      const h = makeRunner({
        teams: {
          listActiveTeams: () => TWO,
          // Nobody answers — the record must exist anyway, immediately.
          warnLead: () => new Promise<LeadNoticeOutcome>(() => undefined),
        },
      });
      const { runId } = await h.runner.apply({ targetVersion: '0.6.0', graceSeconds: 3600 });
      await settle();
      const row = store.get(runId)!;
      expect(row.state).toBe('warning_teams');
      const warned = JSON.parse(row.teams_warned_json!) as Array<Record<string, unknown>>;
      expect(warned.map((w) => w.orch_id)).toEqual(['o1', 'o2']);
      expect(warned.map((w) => w.orch_name)).toEqual(['stiix-infra', 'trader']);
      // Not "read", and not a verdict either: nothing has been observed yet, so
      // the row says exactly that. It used to say `never_idle` — "this lead
      // never reached an idle boundary" — which is a claim about the one thing
      // that cannot be known the instant the window opens.
      expect(warned.every((w) => w.state === 'pending' && w.read === false)).toBe(true);
      expect(warned.some((w) => w.state === 'never_idle')).toBe(false);
    });

    it('turns a team’s record live as its outcome lands, not at the deadline', async () => {
      const h = makeRunner({
        teams: {
          listActiveTeams: () => TWO,
          warnLead: (team) =>
            team.orchestratorId === 'o1'
              ? Promise.resolve<LeadNoticeOutcome>({ signalled: true, read: true, state: 'read' })
              : new Promise<LeadNoticeOutcome>(() => undefined),
        },
      });
      const { runId } = await h.runner.apply({ targetVersion: '0.6.0', graceSeconds: 3600 });
      await settle();
      // Still mid-window: nothing has been spawned and the deadline is an hour
      // away, yet the screen already knows who acknowledged.
      expect(h.spawned).toHaveLength(0);
      const warned = JSON.parse(store.get(runId)!.teams_warned_json!) as Array<Record<string, unknown>>;
      expect(warned.find((w) => w.orch_id === 'o1')).toMatchObject({ state: 'read', read: true });
      // …and the one that has not answered is still unobserved, not condemned.
      expect(warned.find((w) => w.orch_id === 'o2')).toMatchObject({ state: 'pending' });
    });
  });

  it('keeps the ordinary window when the team list cannot be read at all', async () => {
    vi.useFakeTimers();
    try {
      // A throw is not "no team is active". Failing open to a 0 s window was
      // the one failure in this feature that failed toward the destructive
      // answer: immediate recreate, recorded as `teams_warned: []`.
      const h = makeRunner({
        teams: {
          listActiveTeams: () => {
            throw new Error('spawner is not answering');
          },
          warnLead: async () => ({ signalled: false, read: false, state: 'never_idle' }),
        },
      });
      const p = h.runner.apply({ targetVersion: '0.6.0' });
      await vi.advanceTimersByTimeAsync(1);
      const { runId } = await p;
      expect(h.spawned).toHaveLength(0);
      expect(store.get(runId)!.state).toBe('warning_teams');
      // …and it says out loud that the snapshot is empty because nothing could
      // be enumerated, not because nothing was running.
      expect(store.get(runId)!.error).toContain('could not be read');
      await vi.advanceTimersByTimeAsync(DEFAULT_GRACE_SECONDS * 1000 + 1_000);
      expect(h.spawned).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('proceeds at the deadline even when a lead never went idle', async () => {
    vi.useFakeTimers();
    try {
      const teams: ActiveTeam[] = [{ orchestratorId: 'o1', name: 't', leadSessionId: 's1' }];
      const h = makeRunner({
        teams: {
          listActiveTeams: () => teams,
          warnLead: async () => ({ signalled: false, read: false, state: 'never_idle' }),
        },
      });
      const p = h.runner.apply({ targetVersion: '0.6.0', graceSeconds: 120 });
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(h.spawned).toHaveLength(0);
      // A live agent may not veto an operator action.
      await vi.advanceTimersByTimeAsync(121_000);
      expect(h.spawned).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel during the window stops the run and spawns nothing', async () => {
    const teams: ActiveTeam[] = [{ orchestratorId: 'o1', name: 't', leadSessionId: 's1' }];
    const h = makeRunner({ teams: teamsPort(teams) });
    const { runId } = await h.runner.apply({ targetVersion: '0.6.0', graceSeconds: 120 });
    await settle();
    expect(h.runner.cancel(runId)).toBe(true);
    await settle();
    expect(store.get(runId)!.state).toBe('cancelled');
    expect(h.spawned).toHaveLength(0);
  });

  it('cannot be cancelled once the host job owns the outcome', async () => {
    const h = makeRunner();
    const { runId } = await h.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    expect(h.runner.cancel(runId)).toBe(false);
  });

  it('applyNow skips the rest of the window', async () => {
    const teams: ActiveTeam[] = [{ orchestratorId: 'o1', name: 't', leadSessionId: 's1' }];
    const h = makeRunner({ teams: teamsPort(teams) });
    await h.runner.apply({ targetVersion: '0.6.0', graceSeconds: 3600 });
    await settle();
    expect(h.spawned).toHaveLength(0);
    expect(h.runner.applyNow()).toBe(true);
    await settle();
    expect(h.spawned).toHaveLength(1);
  });

  /**
   * The window's END is a fact the port cannot derive: `applyNow` truncates it
   * and `cancel` abolishes it, while the port only ever heard the original
   * deadline. Every settle reason is signalled, from one place, so a port can
   * settle its own waiters and stop typing at leads that are no longer being
   * interrupted.
   */
  describe('endWindow', () => {
    function spyPort(teams: ActiveTeam[], ended: GraceEndReason[], throws = false): TeamsPort {
      return {
        listActiveTeams: () => teams,
        warnLead: async () => ({ signalled: true, read: false, state: 'queued_unread' }),
        endWindow: (reason) => {
          ended.push(reason);
          if (throws) throw new Error('port exploded');
        },
      };
    }

    const ONE_TEAM: ActiveTeam[] = [{ orchestratorId: 'o1', name: 't', leadSessionId: 's1' }];

    it('says `now` when the operator skips the rest of the window', async () => {
      const ended: GraceEndReason[] = [];
      const h = makeRunner({ teams: spyPort(ONE_TEAM, ended) });
      const { runId } = await h.runner.apply({ targetVersion: '0.6.0', graceSeconds: 3600 });
      await settle();
      // Not before: the window is still open.
      expect(ended).toEqual([]);
      expect(h.runner.applyNow(runId)).toBe(true);
      await settle();
      expect(ended).toEqual(['now']);
      expect(h.spawned).toHaveLength(1);
    });

    it('says `cancelled` when the run is cancelled, and nothing is spawned', async () => {
      const ended: GraceEndReason[] = [];
      const h = makeRunner({ teams: spyPort(ONE_TEAM, ended) });
      const { runId } = await h.runner.apply({ targetVersion: '0.6.0', graceSeconds: 3600 });
      await settle();
      expect(h.runner.cancel(runId)).toBe(true);
      await settle();
      expect(ended).toEqual(['cancelled']);
      expect(h.spawned).toHaveLength(0);
    });

    it('says `deadline` when the window simply runs out', async () => {
      vi.useFakeTimers();
      try {
        const ended: GraceEndReason[] = [];
        const h = makeRunner({ teams: spyPort(ONE_TEAM, ended) });
        const p = h.runner.apply({ targetVersion: '0.6.0', graceSeconds: 120 });
        await vi.advanceTimersByTimeAsync(1);
        await p;
        expect(ended).toEqual([]);
        await vi.advanceTimersByTimeAsync(121_000);
        expect(ended).toEqual(['deadline']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a port that throws from it may not veto the update', async () => {
      const ended: GraceEndReason[] = [];
      const h = makeRunner({ teams: spyPort(ONE_TEAM, ended, true) });
      const { runId } = await h.runner.apply({ targetVersion: '0.6.0', graceSeconds: 3600 });
      await settle();
      expect(h.runner.applyNow(runId)).toBe(true);
      await settle();
      expect(ended).toEqual(['now']);
      expect(h.spawned).toHaveLength(1);
      expect(store.get(runId)!.state).not.toBe('failed');
    });

    it('a port WITHOUT endWindow still applies, and still records', async () => {
      const teams: ActiveTeam[] = ONE_TEAM;
      const h = makeRunner({
        teams: {
          listActiveTeams: () => teams,
          warnLead: async () => ({ signalled: true, read: true, state: 'read' }),
        },
      });
      const { runId } = await h.runner.apply({ targetVersion: '0.6.0', graceSeconds: 3600 });
      await settle();
      expect(h.runner.applyNow(runId)).toBe(true);
      await settle();
      expect(h.spawned).toHaveLength(1);
      const warned = JSON.parse(store.get(runId)!.teams_warned_json!) as Array<{ state: string }>;
      expect(warned[0]!.state).toBe('read');
    });
  });

  it('a warnLead that throws becomes a never_idle record, never a failed update', async () => {
    const teams: ActiveTeam[] = [{ orchestratorId: 'o1', name: 't', leadSessionId: 's1' }];
    const h = makeRunner({
      teams: {
        listActiveTeams: () => teams,
        warnLead: async () => {
          throw new Error('session gone');
        },
      },
    });
    const { runId } = await h.runner.apply({ targetVersion: '0.6.0', graceSeconds: 120 });
    await settle();
    const warned = JSON.parse(store.get(runId)!.teams_warned_json!) as Array<{ state: string }>;
    expect(warned[0]!.state).toBe('never_idle');
  });
});

describe('scheduling (Lot E)', () => {
  it('arms a one-shot and fires it at the datetime', async () => {
    vi.useFakeTimers();
    try {
      const h = makeRunner();
      const at = new Date(Date.now() + 60_000).toISOString();
      const { runId } = h.runner.schedule({ at, targetVersion: '0.6.0' });
      expect(store.get(runId)!.state).toBe('scheduled');
      expect(store.get(runId)!.scheduled_for).toBe(at);
      expect(h.spawned).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(h.spawned).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire a far-future schedule immediately (the 32-bit setTimeout trap)', async () => {
    vi.useFakeTimers();
    try {
      const h = makeRunner();
      // 40 days > 2^31-1 ms: an un-chunked setTimeout would fire NOW, i.e.
      // update today instead of next month.
      const at = new Date(Date.now() + 40 * 24 * 3600_000).toISOString();
      h.runner.schedule({ at, targetVersion: '0.6.0' });
      await vi.advanceTimersByTimeAsync(2_147_483_647);
      expect(h.spawned).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(40 * 24 * 3600_000);
      expect(h.spawned).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a datetime it cannot parse, and a target it cannot resolve', () => {
    const h = makeRunner();
    expect(() => h.runner.schedule({ at: 'next tuesday', targetVersion: '0.6.0' })).toThrow(
      UpdateInvalidInputError,
    );
    expect(() =>
      h.runner.schedule({ at: new Date().toISOString(), targetVersion: '   ' }),
    ).toThrow(UpdateInvalidInputError);
    expect(store.listRecent()).toHaveLength(0);
  });

  it('cancelSchedule removes it and reports whether there was one', () => {
    const h = makeRunner();
    expect(h.runner.cancelSchedule()).toBe(false);
    const { runId } = h.runner.schedule({
      at: new Date(Date.now() + 60_000).toISOString(),
      targetVersion: '0.6.0',
    });
    expect(h.runner.cancelSchedule()).toBe(true);
    expect(store.get(runId)!.state).toBe('cancelled');
    expect(h.runner.cancelSchedule()).toBe(false);
  });

  /**
   * The timer and the row are two facts, and only the row is authoritative:
   * another process on the same DB (or `cancel()` from a second runner) can
   * change it while our one-shot is still armed. Firing off the timer alone
   * would apply an update the operator already called off.
   */
  describe('the guard at fire time', () => {
    it('does not fire a schedule whose row was cancelled behind its back', async () => {
      vi.useFakeTimers();
      try {
        const h = makeRunner();
        const { runId } = h.runner.schedule({
          at: new Date(Date.now() + 60_000).toISOString(),
          targetVersion: '0.6.0',
        });
        store.patch(runId, { state: 'cancelled', finished_at: new Date().toISOString() });
        await vi.advanceTimersByTimeAsync(61_000);
        expect(h.spawned).toHaveLength(0);
        expect(store.get(runId)!.state).toBe('cancelled');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not fire a schedule that has already started', async () => {
      vi.useFakeTimers();
      try {
        const h = makeRunner();
        const { runId } = h.runner.schedule({
          at: new Date(Date.now() + 60_000).toISOString(),
          targetVersion: '0.6.0',
        });
        // Still `scheduled`, but somebody already drove it — a second drive
        // would warn the teams twice and spawn two host jobs.
        store.patch(runId, { started_at: new Date().toISOString() });
        await vi.advanceTimersByTimeAsync(61_000);
        expect(h.spawned).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('refuses to schedule while another run is in flight', async () => {
    const h = makeRunner();
    await h.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    expect(() =>
      h.runner.schedule({ at: new Date(Date.now() + 60_000).toISOString(), targetVersion: '0.6.0' }),
    ).toThrow(UpdateBusyError);
  });
});

describe('start() — resume at boot', () => {
  it('concludes a run that finished while we were down', async () => {
    const first = makeRunner();
    const { runId } = await first.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    first.runner.stop();
    // The container was recreated: our process died mid-run, the script kept
    // going and wrote its verdict.
    writeResult(runId, { state: 'success', verify: 'boot_complete', message: 'ok' });

    const second = makeRunner();
    await second.runner.start();
    expect(store.get(runId)!.state).toBe('success');
  });

  it('abandons a run whose script died with the host', async () => {
    const first = makeRunner();
    const { runId } = await first.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    first.runner.stop();
    const second = makeRunner();
    await second.runner.start();
    expect(store.get(runId)!.state).toBe('abandoned');
  });

  it('keeps watching a run whose script is still alive', async () => {
    const first = makeRunner();
    const { runId } = await first.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    first.runner.stop();
    beat(runId);
    const second = makeRunner();
    await second.runner.start();
    expect(store.get(runId)!.state).not.toBe('abandoned');
    writeResult(runId, { state: 'success', verify: 'boot_complete' });
    await settle();
    expect(store.get(runId)!.state).toBe('success');
  });

  it('abandons — rather than silently resumes — a run interrupted mid-warning', async () => {
    const teams: ActiveTeam[] = [{ orchestratorId: 'o1', name: 't', leadSessionId: 's1' }];
    const first = makeRunner({
      teams: { listActiveTeams: () => teams, warnLead: async () => ({ signalled: true, read: true, state: 'read' }) },
    });
    const { runId } = await first.runner.apply({ targetVersion: '0.6.0', graceSeconds: 3600 });
    await settle();
    expect(store.get(runId)!.state).toBe('warning_teams');
    first.runner.stop();

    const second = makeRunner();
    await second.runner.start();
    // The window is wall-clock and team-local; a restart destroys both. An
    // `up -d` nobody is expecting any more is worse than a retry.
    expect(store.get(runId)!.state).toBe('abandoned');
    expect(second.spawned).toHaveLength(0);
  });

  it('re-arms a pending schedule from the store', async () => {
    vi.useFakeTimers();
    try {
      const first = makeRunner();
      const at = new Date(Date.now() + 60_000).toISOString();
      first.runner.schedule({ at, targetVersion: '0.6.0' });
      first.runner.stop();

      const second = makeRunner();
      await second.runner.start();
      expect(second.spawned).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(second.spawned).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('CANCELS a schedule whose datetime passed while we were down', async () => {
    const first = makeRunner();
    const { runId } = first.runner.schedule({
      at: new Date(Date.now() + 60_000).toISOString(),
      targetVersion: '0.6.0',
    });
    first.runner.stop();
    // Scheduled for 02:00; the host rebooted at 01:50 and swarm-os is back at
    // 09:00. Re-arming would fire `remaining <= 0` synchronously inside
    // `start()` — which boot awaits BEFORE auto-resume, so the orchestrator map
    // is empty, the grace window resolves to 0 s, and the container is
    // recreated at once while the teams are still being respawned.
    store.patch(runId, { scheduled_for: new Date(Date.now() - 7 * 3600_000).toISOString() });

    const second = makeRunner();
    await second.runner.start();
    await settle();
    expect(second.spawned).toHaveLength(0);
    const row = store.get(runId)!;
    expect(row.state).toBe('cancelled');
    expect(row.error).toContain('passed while swarm-os was down');
  });

  it('still arms a schedule that is merely in the future', async () => {
    vi.useFakeTimers();
    try {
      const first = makeRunner();
      first.runner.schedule({ at: new Date(Date.now() + 60_000).toISOString(), targetVersion: '0.6.0' });
      first.runner.stop();
      const second = makeRunner();
      await second.runner.start();
      await vi.advanceTimersByTimeAsync(61_000);
      expect(second.spawned).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps the boot-time env restore so auto-resume is not held on ssh', async () => {
    const first = makeRunner();
    const { runId } = await first.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    emit(runId, 'env_written', {
      env_file: '/srv/.env',
      env_line_before_b64: Buffer.from('SWARM_OS_IMAGE=ghcr.io/o/r:0.5.0').toString('base64'),
    });
    first.runner.stop();

    const second = makeRunner();
    await second.runner.start();
    expect(store.get(runId)!.state).toBe('abandoned');
    // `index.ts` awaits `start()` before `runAutoResume()`: every second here is
    // a second the teams stay down, and this exec is a one-line sed on the host.
    expect(second.hostRunTimeouts).toEqual([10_000]);
  });

  it('installs the script and reports its version + sha', async () => {
    const h = makeRunner();
    await h.runner.start();
    expect(h.runner.scriptDescriptor()).toEqual({ version: '1.0.0', sha256: 'deadbeef' });
  });
});

describe('the janitor', () => {
  it('keeps the newest N run dirs and never deletes an active one', async () => {
    const h = makeRunner();
    const runs = path.join(dir, 'updater', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    for (let i = 0; i < 30; i++) fs.mkdirSync(path.join(runs, `2026010${i % 10}T00000${i}Z-old${i}`));
    const { runId } = await h.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    h.runner.prune(5);
    const left = fs.readdirSync(runs);
    expect(left.length).toBeLessThanOrEqual(6);
    expect(left).toContain(runId);
  });

  it('prunes only the _system namespace of host-jobs', async () => {
    const h = makeRunner();
    const sys = path.join(dir, 'host-jobs', '_system');
    const plugin = path.join(dir, 'host-jobs', 'my-plugin');
    fs.mkdirSync(sys, { recursive: true });
    fs.mkdirSync(plugin, { recursive: true });
    for (let i = 0; i < 10; i++) {
      fs.mkdirSync(path.join(sys, `job-${i}`));
      fs.mkdirSync(path.join(plugin, `job-${i}`));
    }
    h.runner.prune(2);
    expect(fs.readdirSync(sys)).toHaveLength(2);
    // The general host-jobs leak is pre-existing debt owned by ssh-exec.ts.
    expect(fs.readdirSync(plugin)).toHaveLength(10);
  });
});

describe('run views', () => {
  it('exposes the live phase and the grace countdown', async () => {
    const teams: ActiveTeam[] = [{ orchestratorId: 'o1', name: 't', leadSessionId: 's1' }];
    const h = makeRunner({
      teams: { listActiveTeams: () => teams, warnLead: async () => ({ signalled: true, read: true, state: 'read' }) },
    });
    const { runId } = await h.runner.apply({ targetVersion: '0.6.0', graceSeconds: 600 });
    await settle();
    const view = h.runner.currentRun()!;
    expect(view.id).toBe(runId);
    expect(view.state).toBe('warning_teams');
    expect(view.graceRemainingSeconds).toBeGreaterThan(500);
    expect(view.terminal).toBe(false);
  });

  it('getRun returns the tail and the parsed result', async () => {
    const h = makeRunner();
    const { runId } = await h.runner.apply({ targetVersion: '0.6.0' });
    await settle();
    emit(runId, 'pulling');
    writeResult(runId, { state: 'success', verify: 'boot_complete', message: 'ok' });
    await settle();
    const detail = h.runner.getRun(runId)!;
    expect(detail.logTail).toContain('pulling');
    expect(detail.result?.state).toBe('success');
    expect(detail.terminal).toBe(true);
  });

  it('returns null for an unknown id', () => {
    const h = makeRunner();
    expect(h.runner.getRun('nope')).toBeNull();
  });
});

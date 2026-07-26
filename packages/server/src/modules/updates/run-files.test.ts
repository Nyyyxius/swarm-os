/**
 * The run directory IS the interface between the server and a script that
 * outlives it (§D.4). These are the readers that decide, from files alone,
 * whether a run is alive, where it got to, and what it owes the operator.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  HEARTBEAT_GRACE_MS,
  HEARTBEAT_STALE_MS,
  isRunAlive,
  phaseToState,
  readEvents,
  readResult,
  resultToState,
  summarizeProgress,
  type HostUpdateEvent,
} from './run-files.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-files-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function events(...list: HostUpdateEvent[]): void {
  fs.writeFileSync(
    path.join(dir, 'events.ndjson'),
    list.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

describe('readResult', () => {
  it('is null while the file does not exist', () => {
    expect(readResult(dir)).toBeNull();
  });

  it('is null — never a failure — on unparsable bytes', () => {
    // `result.json` is renamed into place, so a bad read means "not there yet".
    // Reporting a failure here would roll back a run that is going fine.
    fs.writeFileSync(path.join(dir, 'result.json'), '{"state":"succ');
    expect(readResult(dir)).toBeNull();
  });

  it('parses the script’s verdict', () => {
    fs.writeFileSync(path.join(dir, 'result.json'), '{"state":"rolled_back","exit_code":10}');
    expect(readResult(dir)?.state).toBe('rolled_back');
  });
});

describe('isRunAlive', () => {
  const now = 1_000_000_000;

  it('is alive on a fresh heartbeat and dead on a stale one', () => {
    const hb = path.join(dir, 'heartbeat');
    fs.writeFileSync(hb, '');
    const fresh = new Date(now - 1_000);
    fs.utimesSync(hb, fresh, fresh);
    expect(isRunAlive(dir, now, null)).toBe(true);
    const stale = new Date(now - HEARTBEAT_STALE_MS - 1_000);
    fs.utimesSync(hb, stale, stale);
    expect(isRunAlive(dir, now, null)).toBe(false);
  });

  it('gives a just-spawned run a grace period before its first heartbeat', () => {
    // `spawnHostJob` returns once the pid file lands; the shell still has to
    // reach the heartbeat loop. Without the grace, every run would be
    // abandoned at birth.
    expect(isRunAlive(dir, now, now - 1_000)).toBe(true);
    expect(isRunAlive(dir, now, now - HEARTBEAT_GRACE_MS - 1)).toBe(false);
    expect(isRunAlive(dir, now, null)).toBe(false);
  });
});

describe('summarizeProgress', () => {
  it('reports the last phase and captures the rollback token', () => {
    const b64 = Buffer.from('SWARM_OS_IMAGE=ghcr.io/o/r:0.5.0').toString('base64');
    events(
      { phase: 'preflight', env_file: '/srv/.env', env_line_before_b64: b64 },
      { phase: 'pulling' },
      { phase: 'env_written', env_file: '/srv/.env', env_line_before_b64: b64 },
    );
    const p = summarizeProgress(readEvents(dir));
    expect(p.lastPhase).toBe('env_written');
    expect(p.envWritten).toBe(true);
    expect(p.deployed).toBe(false);
    expect(p.envFile).toBe('/srv/.env');
    expect(p.envLineBefore).toBe('SWARM_OS_IMAGE=ghcr.io/o/r:0.5.0');
  });

  it('clears envWritten once the script put the line back itself', () => {
    // The only state that needs repair is "written but never deployed"; a run
    // that already restored the line must not be restored a second time.
    events({ phase: 'env_written', env_file: '/e' }, { phase: 'env_restored' });
    const p = summarizeProgress(readEvents(dir));
    expect(p.envWritten).toBe(false);
    expect(p.envRestored).toBe(true);
  });

  it('records the deploy, which is what makes a restore wrong', () => {
    events({ phase: 'env_written', env_file: '/e' }, { phase: 'deployed' });
    const p = summarizeProgress(readEvents(dir));
    expect(p.envWritten).toBe(true);
    expect(p.deployed).toBe(true);
  });

  it('skips a torn line rather than losing the whole file', () => {
    fs.writeFileSync(
      path.join(dir, 'events.ndjson'),
      '{"phase":"pulling"\n{"phase":"applying"}\nnot json\n',
    );
    expect(summarizeProgress(readEvents(dir)).lastPhase).toBe('applying');
  });
});

describe('phaseToState / resultToState', () => {
  it('maps only the non-terminal phases — a verdict comes from result.json', () => {
    expect(phaseToState('pulling')).toBe('preflight');
    expect(phaseToState('env_written')).toBe('applying');
    expect(phaseToState('verifying')).toBe('verifying');
    // Terminal phases deliberately map to nothing: only `result.json` is
    // written atomically, so only it may end a run.
    expect(phaseToState('success')).toBeNull();
    expect(phaseToState('refused')).toBeNull();
    expect(phaseToState(null)).toBeNull();
  });

  it('treats an unreadable verdict as failed, never as success', () => {
    expect(resultToState({ state: 'success' })).toBe('success');
    expect(resultToState({ state: 'refused' })).toBe('refused');
    expect(resultToState({})).toBe('failed');
    expect(resultToState({ state: 'something-new' })).toBe('failed');
  });
});

/**
 * Reading a run's state from the run directory — plain `fs`, zero SSH (§D.4).
 *
 * ⚠️ THE DEFECT THIS EXISTS TO AVOID, verified in the shipped code:
 * `hostJobStatus` decides liveness with `running = !timedOut && code === 0`
 * (`orchestrator/ssh-exec.ts:553-558`), but `hostExec` **resolves** when ssh
 * itself fails to connect — exit 255 (`:227-231`). So "the host is unreachable"
 * and "the job is dead" are the same value, and the first probe after a
 * container recreate hits a ControlMaster mux that is cold BY CONSTRUCTION.
 * Polling it would report every successful update as a dead job.
 *
 * So liveness here is filesystem-only, on the `/data` bind mount both sides
 * share:
 *   - `heartbeat`     touched every 5 s → alive if its mtime is < 30 s old;
 *   - `result.json`   written atomically and last → AUTHORITATIVE when present;
 *   - `events.ndjson` one record per phase → what to show while it runs, and
 *                     how the `abandoned` handler learns whether the env file
 *                     was written but not deployed.
 *
 * None of these can be confused with "ssh had a bad day".
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { UpdateRunState } from './store.js';

/** A run whose heartbeat is older than this, with no result, is not running. */
export const HEARTBEAT_STALE_MS = 30_000;
/**
 * Grace between the spawn and the first heartbeat. `spawnHostJob` only returns
 * once the detached shell recorded its pgid, but the shell still has to reach
 * our `hu_heartbeat_start`; treating that gap as "abandoned" would abandon
 * every run at birth.
 */
export const HEARTBEAT_GRACE_MS = 60_000;
/** Cap on how much of `events.ndjson` we ever read into memory. */
export const EVENTS_TAIL_BYTES = 64 * 1024;

/** `result.json`, as the script writes it. Every field is optional on read. */
export interface HostUpdateResult {
  script_version?: string;
  run_id?: string;
  /** `success` | `rolled_back` | `failed` | `refused`. */
  state?: string;
  exit_code?: number;
  reason?: string;
  message?: string;
  /** `boot_complete` | `healthy_no_boot_complete` | `unreachable` | `skipped`. */
  verify?: string;
  container_id?: string;
  project?: string;
  service?: string;
  env_file?: string;
  env_line_before_b64?: string;
  target_image?: string;
  previous_image?: string;
  env_written?: boolean;
  deployed?: boolean;
  finished_at?: string;
}

export interface HostUpdateEvent {
  ts?: string;
  script_version?: string;
  run_id?: string;
  phase?: string;
  reason?: string;
  message?: string;
  env_file?: string;
  env_line_before_b64?: string;
  [k: string]: unknown;
}

export function resultPath(runDir: string): string {
  return path.join(runDir, 'result.json');
}
export function heartbeatPath(runDir: string): string {
  return path.join(runDir, 'heartbeat');
}
export function eventsPath(runDir: string): string {
  return path.join(runDir, 'events.ndjson');
}
export function jobRefPath(runDir: string): string {
  return path.join(runDir, 'job.json');
}

/**
 * The run's verdict, or `null` while it has none. A parse failure returns
 * `null` too: `result.json` is renamed into place, so a partial read means the
 * file is not there yet — never that the run failed.
 */
export function readResult(runDir: string): HostUpdateResult | null {
  let raw: string;
  try {
    raw = fs.readFileSync(resultPath(runDir), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as HostUpdateResult) : null;
  } catch {
    return null;
  }
}

/** Age of the heartbeat in ms, or `null` when the file does not exist yet. */
export function heartbeatAgeMs(runDir: string, now: number): number | null {
  try {
    return now - fs.statSync(heartbeatPath(runDir)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Is this run still being driven by a live script?
 *
 * `spawnedAtMs` covers the window before the first heartbeat lands. A run whose
 * heartbeat never appeared AND whose grace has expired is dead — the host went
 * away between the launcher returning and the script starting.
 */
export function isRunAlive(runDir: string, now: number, spawnedAtMs: number | null): boolean {
  const age = heartbeatAgeMs(runDir, now);
  if (age === null) {
    return spawnedAtMs !== null && now - spawnedAtMs < HEARTBEAT_GRACE_MS;
  }
  return age < HEARTBEAT_STALE_MS;
}

/** Last `EVENTS_TAIL_BYTES` of `events.ndjson`, parsed. Unparsable lines are skipped. */
export function readEvents(runDir: string, maxBytes = EVENTS_TAIL_BYTES): HostUpdateEvent[] {
  const text = readTail(eventsPath(runDir), maxBytes);
  if (text === '') return [];
  const out: HostUpdateEvent[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith('{')) continue;
    try {
      out.push(JSON.parse(trimmed) as HostUpdateEvent);
    } catch {
      // A truncated first line (we read a tail) or a torn write. Skip it.
    }
  }
  return out;
}

/** Raw tail of `events.ndjson` for `log_tail` / the run-detail route. */
export function readEventsTail(runDir: string, maxBytes = EVENTS_TAIL_BYTES): string {
  return readTail(eventsPath(runDir), maxBytes);
}

function readTail(file: string, maxBytes: number): string {
  let fd: number | undefined;
  try {
    const size = fs.statSync(file).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    if (len <= 0) return '';
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * Where a run got to, from its events — used to drive the persisted state while
 * the script runs, and (crucially) to decide what the `abandoned` handler owes
 * the operator.
 */
export interface RunProgress {
  lastPhase: string | null;
  /** The script wrote the env line. */
  envWritten: boolean;
  /** …and then `compose up` was reached. */
  deployed: boolean;
  /** …and then the original line was put back. */
  envRestored: boolean;
  envFile: string | null;
  /** Byte-exact original `VAR=` line, decoded from the event's base64. */
  envLineBefore: string | null;
}

/**
 * `env_written` without `deployed` is the ONE state that leaves the operator's
 * file changed while the running container is still the old one. That is what
 * the boot-time `abandoned` handler repairs.
 */
export function summarizeProgress(events: readonly HostUpdateEvent[]): RunProgress {
  const progress: RunProgress = {
    lastPhase: null,
    envWritten: false,
    deployed: false,
    envRestored: false,
    envFile: null,
    envLineBefore: null,
  };
  for (const ev of events) {
    if (typeof ev.phase === 'string' && ev.phase.length > 0) progress.lastPhase = ev.phase;
    if (typeof ev.env_file === 'string' && ev.env_file.length > 0) progress.envFile = ev.env_file;
    if (typeof ev.env_line_before_b64 === 'string' && ev.env_line_before_b64.length > 0) {
      const decoded = decodeB64(ev.env_line_before_b64);
      if (decoded !== null) progress.envLineBefore = decoded;
    }
    switch (ev.phase) {
      case 'env_written':
        progress.envWritten = true;
        progress.envRestored = false;
        break;
      case 'env_restored':
        progress.envRestored = true;
        progress.envWritten = false;
        break;
      case 'deployed':
        progress.deployed = true;
        break;
      default:
        break;
    }
  }
  return progress;
}

export function decodeB64(value: string): string | null {
  try {
    const buf = Buffer.from(value, 'base64');
    if (buf.length === 0) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Phase → persisted state. Only the NON-terminal phases matter here: a terminal
 * verdict always comes from `result.json`, never from an event, because only
 * `result.json` is written atomically.
 */
export function phaseToState(phase: string | null): UpdateRunState | null {
  switch (phase) {
    case 'started':
    case 'identifying':
    case 'hint_rejected':
    case 'preflight':
    case 'preflight_ok':
    case 'pulling':
      return 'preflight';
    case 'writing_env':
    case 'env_written':
    case 'applying':
      return 'applying';
    case 'deployed':
    case 'verifying':
    case 'rolling_back':
    case 'env_restored':
    case 'rollback_config_drift':
      return 'verifying';
    default:
      return null;
  }
}

/**
 * `result.json.state` → persisted state. An unrecognised value is `failed`
 * rather than ignored: a verdict we cannot read is not a success.
 */
export function resultToState(result: HostUpdateResult): UpdateRunState {
  switch (result.state) {
    case 'success':
      return 'success';
    case 'rolled_back':
      return 'rolled_back';
    case 'refused':
      return 'refused';
    case 'failed':
      return 'failed';
    default:
      return 'failed';
  }
}

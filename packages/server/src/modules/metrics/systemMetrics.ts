/**
 * Lot 10 — container CPU / memory gauges (`GET /metrics/system`).
 *
 * The server process runs INSIDE the deployment container, so the honest
 * source for "how loaded is this deployment" is the container's own cgroup —
 * not a Docker socket (we deliberately don't mount one) and not `process`
 * counters (those would miss the agent CLIs, which are the actual load).
 * Reading our own cgroup covers every process in the container.
 *
 * Files read (v2 first, v1 fallback):
 *   memory  /sys/fs/cgroup/memory.current            /sys/fs/cgroup/memory/memory.usage_in_bytes
 *           /sys/fs/cgroup/memory.max                /sys/fs/cgroup/memory/memory.limit_in_bytes
 *   cpu     /sys/fs/cgroup/cpu.stat (usage_usec)     /sys/fs/cgroup/cpuacct/cpuacct.usage (ns)
 *   cores   /sys/fs/cgroup/cpu.max ("<quota> <period>" | "max <period>")
 *
 * An unlimited cgroup (`memory.max = max`, or the v1 sentinel limit, or no
 * `cpu.max` quota) is not an error: it means the container can use the whole
 * host, so we fall back to `os.totalmem()` / `os.cpus().length` and tag the
 * field `basis: 'host'` so the UI can say so. Anything unreadable — a dev run
 * outside a container, a hardened runtime, cgroup v1 with a different
 * mountpoint — yields `null`, never a fabricated number.
 *
 * CPU sampling is a **lazy delta with no timer**: a CPU-time counter is
 * meaningless without a second reading, so we remember the previous
 * `{usageUsec, atMs}` and compute the ratio at request time. Consequences,
 * all deliberate:
 *   - first call ever → `pct: null` (one point is not a rate);
 *   - two calls less than 1 s apart → the last computed value (a sub-second
 *     window turns scheduler jitter into 0 % / 300 % noise);
 *   - the reference point only advances when a value is actually computed, so
 *     a burst of fast polls can't starve the metric.
 * A background interval would have been the other option; it would burn a
 * wake-up every second forever for a page that is open a few minutes a day.
 *
 * `pct` is a **0..1 fraction** (both CPU and memory), clamped to that range —
 * the UI multiplies. Clamping matters: `memory.current` can momentarily
 * exceed a shrinking limit, and a CPU delta measured across a paused/stepped
 * clock can exceed the wall window.
 *
 * No logging: this is polled every 3 s while the monitoring page is open, and
 * a warn-per-read on a dev box without cgroups would drown the log. The nulls
 * are the signal.
 *
 * Every read is wrapped: `snapshot()` never throws.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';

/** Public payload shape — served as-is by `GET /metrics/system`. */
export interface SystemMetricsSnapshot {
  cpu: {
    /** Fraction 0..1 of the available cores in use, or null (see header). */
    pct: number | null;
    /** Cores the container may use: cgroup quota, else host core count. */
    cores: number | null;
    /** Where `cores` came from — null when unknown. */
    basis: 'cgroup' | 'host' | null;
  };
  memory: {
    usedBytes: number | null;
    /** cgroup limit, or host total when the cgroup is unlimited. */
    limitBytes: number | null;
    /** Fraction 0..1 of `limitBytes` in use, or null. */
    pct: number | null;
    /** Where `limitBytes` came from — null when unknown. */
    basis: 'cgroup' | 'host' | null;
  };
}

/**
 * Injection seams. Production leaves them all unset; tests pass a fixture map
 * plus a controllable clock (the CPU delta is a function of time, so a real
 * clock would make the suite a stopwatch race).
 */
export interface SystemMetricsCollectorOptions {
  /** Reads a cgroup file. MAY throw — the collector catches. */
  readFileImpl?: (path: string) => string;
  /** `os.cpus()` — only `.length` is used. */
  cpusImpl?: () => unknown[];
  /** `os.totalmem()` in bytes. */
  totalmemImpl?: () => number;
  /** `Date.now()` — the wall clock of the CPU delta window. */
  nowImpl?: () => number;
}

// cgroup v2 (unified hierarchy) — the container's own leaf.
const V2_MEMORY_CURRENT = '/sys/fs/cgroup/memory.current';
const V2_MEMORY_MAX = '/sys/fs/cgroup/memory.max';
const V2_CPU_STAT = '/sys/fs/cgroup/cpu.stat';
const V2_CPU_MAX = '/sys/fs/cgroup/cpu.max';
// cgroup v1 (per-controller hierarchies).
const V1_MEMORY_USAGE = '/sys/fs/cgroup/memory/memory.usage_in_bytes';
const V1_MEMORY_LIMIT = '/sys/fs/cgroup/memory/memory.limit_in_bytes';
const V1_CPUACCT_USAGE = '/sys/fs/cgroup/cpuacct/cpuacct.usage';

/**
 * cgroup v1 spells "no limit" as a huge sentinel rather than a keyword:
 * PAGE_COUNTER_MAX scaled by the page size, e.g. 9223372036854771712 on
 * 4 KiB pages, but other values exist. Anything at or above 2^60 (1 EiB) is
 * not a real memory limit on any machine that will run this.
 */
const V1_UNLIMITED_FLOOR = 2 ** 60;

/** Minimum wall window for a CPU delta — below it, jitter dominates. */
const MIN_SAMPLE_MS = 1_000;

/** Strict non-negative integer parse: cgroup files hold one bare number. */
function parseCount(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export class SystemMetricsCollector {
  private readonly _readFile: (path: string) => string;
  private readonly _cpus: () => unknown[];
  private readonly _totalmem: () => number;
  private readonly _now: () => number;

  /** Previous CPU sample, or null until the first successful read. */
  private _prevCpu: { usageUsec: number; atMs: number } | null = null;
  /** Last computed CPU fraction — served to polls that arrive too fast. */
  private _lastCpuPct: number | null = null;

  constructor(opts: SystemMetricsCollectorOptions = {}) {
    this._readFile = opts.readFileImpl ?? ((p) => fs.readFileSync(p, 'utf8'));
    this._cpus = opts.cpusImpl ?? (() => os.cpus());
    this._totalmem = opts.totalmemImpl ?? (() => os.totalmem());
    this._now = opts.nowImpl ?? (() => Date.now());
  }

  /** Fresh plain object, safe to `JSON.stringify`. Never throws. */
  snapshot(): SystemMetricsSnapshot {
    return { cpu: this._cpuSnapshot(), memory: this._memorySnapshot() };
  }

  // --- memory ------------------------------------------------------------

  private _memorySnapshot(): SystemMetricsSnapshot['memory'] {
    const nulls = { usedBytes: null, limitBytes: null, pct: null, basis: null } as const;

    // v2 first; only fall back when the v2 usage file is absent/garbage, so a
    // mixed system can't mix a v2 usage with a v1 limit.
    let usedBytes = parseCount(this._read(V2_MEMORY_CURRENT));
    let limitRaw = this._read(V2_MEMORY_MAX);
    if (usedBytes === null) {
      usedBytes = parseCount(this._read(V1_MEMORY_USAGE));
      limitRaw = this._read(V1_MEMORY_LIMIT);
    }
    if (usedBytes === null) return { ...nulls };

    // `max` (v2) or the v1 sentinel: the cgroup imposes nothing, so the real
    // ceiling is the host's RAM.
    const cgroupLimit = parseCount(limitRaw);
    const limited = cgroupLimit !== null && cgroupLimit > 0 && cgroupLimit < V1_UNLIMITED_FLOOR;

    let limitBytes: number | null;
    let basis: 'cgroup' | 'host' | null;
    if (limited) {
      limitBytes = cgroupLimit;
      basis = 'cgroup';
    } else {
      const total = this._hostTotalMem();
      limitBytes = total;
      basis = total === null ? null : 'host';
    }

    const pct = limitBytes !== null && limitBytes > 0 ? clampFraction(usedBytes / limitBytes) : null;
    return { usedBytes, limitBytes, pct, basis };
  }

  // --- cpu ---------------------------------------------------------------

  private _cpuSnapshot(): SystemMetricsSnapshot['cpu'] {
    const { cores, basis } = this._cores();
    const usageUsec = this._cpuUsageUsec();

    // Unreadable counter: report null rather than replaying a stale ratio —
    // the previous sample stays, so the next successful read still computes a
    // (wider) window instead of restarting from scratch.
    if (usageUsec === null) return { pct: null, cores, basis };

    const nowMs = this._now();
    const prev = this._prevCpu;
    if (prev === null) {
      // One point is not a rate. Seed and report null.
      this._prevCpu = { usageUsec, atMs: nowMs };
      return { pct: null, cores, basis };
    }

    const elapsedMs = nowMs - prev.atMs;
    if (elapsedMs < MIN_SAMPLE_MS) {
      // Too soon (or a clock that went backwards): serve the cached value and
      // keep the reference point, so the next poll measures from it.
      return { pct: this._lastCpuPct, cores, basis };
    }

    // Counters are monotone, but a cgroup re-creation would reset them; clamp
    // rather than emit a negative rate.
    const deltaUsec = Math.max(0, usageUsec - prev.usageUsec);
    this._prevCpu = { usageUsec, atMs: nowMs };
    if (cores === null || cores <= 0) {
      this._lastCpuPct = null;
      return { pct: null, cores, basis };
    }
    const pct = clampFraction(deltaUsec / (elapsedMs * 1_000) / cores);
    this._lastCpuPct = pct;
    return { pct, cores, basis };
  }

  /** Cumulative CPU time of the whole container, in microseconds. */
  private _cpuUsageUsec(): number | null {
    const stat = this._read(V2_CPU_STAT);
    if (stat !== null) {
      for (const line of stat.split('\n')) {
        const match = /^usage_usec\s+(\d+)\s*$/.exec(line.trim());
        if (match) return Number(match[1]);
      }
    }
    // v1 accounts in nanoseconds.
    const usageNs = parseCount(this._read(V1_CPUACCT_USAGE));
    return usageNs === null ? null : usageNs / 1_000;
  }

  /**
   * Cores the container may burn. A `cpu.max` quota is the truth when set
   * (`"<quota_usec> <period_usec>"`); `"max <period>"` means unthrottled, so
   * the ceiling is the host's core count.
   */
  private _cores(): { cores: number | null; basis: 'cgroup' | 'host' | null } {
    const raw = this._read(V2_CPU_MAX);
    if (raw !== null) {
      const [quota, period] = raw.trim().split(/\s+/);
      const quotaUsec = parseCount(quota ?? null);
      const periodUsec = parseCount(period ?? null);
      if (quotaUsec !== null && periodUsec !== null && periodUsec > 0 && quotaUsec > 0) {
        return { cores: quotaUsec / periodUsec, basis: 'cgroup' };
      }
    }
    const hostCores = this._hostCores();
    return { cores: hostCores, basis: hostCores === null ? null : 'host' };
  }

  // --- host fallbacks / io ------------------------------------------------

  private _hostCores(): number | null {
    try {
      const cpus = this._cpus();
      return Array.isArray(cpus) && cpus.length > 0 ? cpus.length : null;
    } catch {
      return null;
    }
  }

  private _hostTotalMem(): number | null {
    try {
      const total = this._totalmem();
      return Number.isFinite(total) && total > 0 ? total : null;
    } catch {
      return null;
    }
  }

  /** Read a cgroup file, or null when it is missing/unreadable/not a string. */
  private _read(path: string): string | null {
    try {
      const raw = this._readFile(path);
      return typeof raw === 'string' ? raw : null;
    } catch {
      return null;
    }
  }
}

/**
 * Process-wide instance used by the HTTP layer.
 *
 * The collector holds no dependency (no spawner, no config) and no lifecycle
 * (no timer to start or stop) — only the previous CPU sample, which must
 * survive across requests for the delta to exist at all. That makes a lazy
 * module singleton the whole of its wiring; tests build their own instances.
 */
let shared: SystemMetricsCollector | null = null;

export function getSystemMetricsCollector(): SystemMetricsCollector {
  if (!shared) shared = new SystemMetricsCollector();
  return shared;
}

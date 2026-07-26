/**
 * Delivery of the host updater script (plan §D.3).
 *
 * The script is embedded in this process (see `script-source.ts`) and written
 * to `<dataDir>/updater/host-update.sh` at startup. Three properties, each of
 * which has a reason:
 *
 *  - **Atomic install** (temp + chmod + `rename(2)` in the same directory). A
 *    half-written updater is the one file on the system that must never exist:
 *    it would be launched by the very mechanism that is supposed to repair the
 *    deployment.
 *  - **Mode 0700 on the directory, 0600 on the file — set EXPLICITLY.** `/data`
 *    is group-writable, and `mkdirSync(…, {mode})` is masked by the umask, so
 *    inheriting or hoping is not enough. Anyone who can write this file can run
 *    arbitrary commands on the host as the deployment's user.
 *  - **No exec bit; invoked as `bash <path>`.** It costs nothing and it keeps
 *    working if `/data` is ever mounted `noexec`.
 *
 * And the refusal: before every spawn, the on-disk bytes are re-hashed and
 * compared to the embedded sha256. The updater for version N cannot be fixed by
 * version N+1 — if the file on disk is not the file this build shipped, we do
 * not run it, we say so.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { runsDir, updaterDir } from './compose.js';
import { HOST_UPDATE_SCRIPT_GZ_B64 } from './script-source.js';

export const HOST_UPDATE_SCRIPT_NAME = 'host-update.sh';
/** Advisory lock the script takes with `flock -n`; one updater per host data dir. */
export const HOST_UPDATE_LOCK_NAME = 'update.lock';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

let cachedBytes: Buffer | null = null;
let cachedSource: string | null = null;
let cachedSha: string | null = null;

/**
 * The embedded script, as BYTES — the unit everything else is derived from.
 *
 * Bytes and not a string, because these are the bytes that get written to disk
 * and the bytes `assertInstalledScriptMatches` re-reads. Hashing a decoded
 * string on one side and a Buffer on the other happens to agree only while the
 * file stays valid UTF-8; the day it does not, the two hashes diverge and the
 * updater refuses to run the copy it just installed.
 */
function hostUpdateScriptBytes(): Buffer {
  if (cachedBytes === null) {
    cachedBytes = zlib.gunzipSync(Buffer.from(HOST_UPDATE_SCRIPT_GZ_B64, 'base64'));
  }
  return cachedBytes;
}

/** The embedded script, decoded. Cached — it is a constant. */
export function hostUpdateScriptSource(): string {
  if (cachedSource === null) {
    cachedSource = hostUpdateScriptBytes().toString('utf8');
  }
  return cachedSource;
}

/** sha256 of the embedded script — the reference every spawn is checked against. */
export function hostUpdateScriptSha256(): string {
  if (cachedSha === null) {
    cachedSha = crypto.createHash('sha256').update(hostUpdateScriptBytes()).digest('hex');
  }
  return cachedSha;
}

/**
 * `SCRIPT_VERSION` as declared by the script itself. Stamped into every log
 * line and into `result.json`, so a support case can tell which updater ran.
 */
export function hostUpdateScriptVersion(): string {
  const m = /^SCRIPT_VERSION="([^"]+)"/m.exec(hostUpdateScriptSource());
  return m?.[1] ?? 'unknown';
}

export interface InstalledHostScript {
  /** Container-side path. Translate before handing it to the host. */
  path: string;
  sha256: string;
  version: string;
}

export class HostScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostScriptError';
  }
}

/**
 * Write the embedded script into `<dataDir>/updater/`, atomically, and return
 * where it landed. Idempotent: re-running it on an identical file is a no-op
 * apart from re-asserting the modes.
 */
export function installHostUpdateScript(dataDir: string): InstalledHostScript {
  const dir = updaterDir(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  // `mkdirSync`'s mode is masked by the umask AND ignored when the directory
  // already exists — so state it, every time, rather than assume it.
  fs.chmodSync(dir, DIR_MODE);
  fs.mkdirSync(runsDir(dataDir), { recursive: true, mode: DIR_MODE });
  fs.chmodSync(runsDir(dataDir), DIR_MODE);

  const target = path.join(dir, HOST_UPDATE_SCRIPT_NAME);
  // The BYTES, not the decoded string: what lands on disk has to be exactly
  // what `hostUpdateScriptSha256()` hashed, or the pre-spawn check refuses.
  const source = hostUpdateScriptBytes();
  const tmp = path.join(dir, `.${HOST_UPDATE_SCRIPT_NAME}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, source, { mode: FILE_MODE });
    fs.chmodSync(tmp, FILE_MODE);
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    throw new HostScriptError(`could not install the host updater at ${target}: ${String(err)}`);
  }
  return { path: target, sha256: hostUpdateScriptSha256(), version: hostUpdateScriptVersion() };
}

/**
 * Re-hash the installed copy and compare it to the embedded sha256. Throws —
 * loudly, and before anything is spawned — when they differ.
 *
 * This is not paranoia about an attacker (a process that can write here can
 * already do worse); it is about a stale copy left by an older image, which
 * would otherwise run silently and produce a `result.json` this build cannot
 * interpret.
 */
export function assertInstalledScriptMatches(scriptPath: string): void {
  let onDisk: Buffer;
  try {
    onDisk = fs.readFileSync(scriptPath);
  } catch (err) {
    throw new HostScriptError(`host updater missing at ${scriptPath}: ${String(err)}`);
  }
  const sha = crypto.createHash('sha256').update(onDisk).digest('hex');
  if (sha !== hostUpdateScriptSha256()) {
    throw new HostScriptError(
      `host updater at ${scriptPath} does not match the one this build shipped ` +
        `(on disk ${sha.slice(0, 12)}…, expected ${hostUpdateScriptSha256().slice(0, 12)}…). ` +
        'Refusing to run it — an updater is the one script whose bugs the next version cannot fix.',
    );
  }
}

/** Exit codes of the script — see its header. Mirrored, not re-derived. */
export const HOST_UPDATE_EXIT = {
  success: 0,
  rolledBack: 10,
  failed: 20,
  refused: 30,
} as const;

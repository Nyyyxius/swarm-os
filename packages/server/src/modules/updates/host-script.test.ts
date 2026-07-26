import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertInstalledScriptMatches,
  HostScriptError,
  hostUpdateScriptSha256,
  hostUpdateScriptSource,
  hostUpdateScriptVersion,
  installHostUpdateScript,
  HOST_UPDATE_SCRIPT_NAME,
  HOST_UPDATE_EXIT,
} from './host-script.js';

const REAL_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../scripts/host-update.sh',
);

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-os-hs-'));
  // Reproduce the thing that makes explicit modes necessary: /data is group
  // writable, and an inherited mode would leave the updater group-writable too.
  fs.chmodSync(dataDir, 0o775);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('the embedded script', () => {
  it('is byte-identical to scripts/host-update.sh', () => {
    // If this fails, `scripts/host-update.sh` was edited without regenerating
    // `script-source.ts` — the command is in that file's header.
    expect(hostUpdateScriptSource()).toBe(fs.readFileSync(REAL_SCRIPT, 'utf8'));
  });

  it('exposes the script’s own SCRIPT_VERSION', () => {
    expect(hostUpdateScriptVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('hashes to the sha256 of those exact bytes', () => {
    expect(hostUpdateScriptSha256()).toBe(
      crypto.createHash('sha256').update(fs.readFileSync(REAL_SCRIPT)).digest('hex'),
    );
  });

  it('agrees with the script on the exit-code contract', () => {
    const src = hostUpdateScriptSource();
    expect(src).toContain(`readonly EXIT_SUCCESS=${HOST_UPDATE_EXIT.success}`);
    expect(src).toContain(`readonly EXIT_ROLLED_BACK=${HOST_UPDATE_EXIT.rolledBack}`);
    expect(src).toContain(`readonly EXIT_FAILED=${HOST_UPDATE_EXIT.failed}`);
    expect(src).toContain(`readonly EXIT_REFUSED=${HOST_UPDATE_EXIT.refused}`);
  });
});

describe('installHostUpdateScript', () => {
  it('writes the script with 0600, in a 0700 directory, with NO exec bit', () => {
    const info = installHostUpdateScript(dataDir);
    expect(info.path).toBe(path.join(dataDir, 'updater', HOST_UPDATE_SCRIPT_NAME));
    expect(fs.readFileSync(info.path, 'utf8')).toBe(hostUpdateScriptSource());
    expect(fs.statSync(info.path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dataDir, 'updater')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dataDir, 'updater', 'runs')).mode & 0o777).toBe(0o700);
  });

  it('does not inherit the group-writable mode of the data dir', () => {
    installHostUpdateScript(dataDir);
    const mode = fs.statSync(path.join(dataDir, 'updater')).mode & 0o777;
    expect(mode & 0o077).toBe(0); // nothing for group or other
  });

  it('re-asserts the modes on an existing, loosened directory', () => {
    const dir = path.join(dataDir, 'updater');
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o777);
    installHostUpdateScript(dataDir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('is idempotent and leaves no temp file behind', () => {
    installHostUpdateScript(dataDir);
    installHostUpdateScript(dataDir);
    const entries = fs.readdirSync(path.join(dataDir, 'updater'));
    expect(entries.sort()).toEqual([HOST_UPDATE_SCRIPT_NAME, 'runs']);
  });
});

describe('assertInstalledScriptMatches', () => {
  it('accepts the copy it just installed', () => {
    const info = installHostUpdateScript(dataDir);
    expect(() => assertInstalledScriptMatches(info.path)).not.toThrow();
  });

  it('REFUSES a copy that differs by a single byte', () => {
    // A stale copy from an older image would run and produce a result.json this
    // build cannot interpret. The updater for version N cannot be fixed by N+1.
    const info = installHostUpdateScript(dataDir);
    fs.appendFileSync(info.path, '\n# tampered\n');
    expect(() => assertInstalledScriptMatches(info.path)).toThrow(HostScriptError);
  });

  it('refuses when the file is missing entirely', () => {
    expect(() => assertInstalledScriptMatches(path.join(dataDir, 'nope.sh'))).toThrow(
      HostScriptError,
    );
  });
});

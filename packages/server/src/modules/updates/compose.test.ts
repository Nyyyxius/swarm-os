import { describe, it, expect } from 'vitest';
import {
  buildComposeBaseArgs,
  buildHostUpdateArgv,
  buildRestoreEnvArgv,
  envValueOf,
  isLabelMissing,
  isValidEnvValue,
  isValidImageRef,
  parseComposeConfigFiles,
  rewriteEnvStream,
  runDirFor,
  VERIFY_TIMEOUT_FLOOR_S,
} from './compose.js';

describe('parseComposeConfigFiles', () => {
  it('handles the single-path case', () => {
    expect(parseComposeConfigFiles('/srv/app/docker-compose.yml', '/srv/app')).toEqual([
      '/srv/app/docker-compose.yml',
    ]);
  });

  it('splits the COMMA-SEPARATED case into one entry per -f, in order', () => {
    // The case that motivates the function: `docker compose -f a -f b` writes
    // `a,b` into the label, and treating it as one path drops every override.
    expect(
      parseComposeConfigFiles('/srv/docker-compose.yml,/srv/docker-compose.prod.yml', '/srv'),
    ).toEqual(['/srv/docker-compose.yml', '/srv/docker-compose.prod.yml']);
  });

  it('trims whitespace, drops empties and resolves relative entries', () => {
    expect(parseComposeConfigFiles('a.yml, /abs/b.yml ,,  c.yml ', '/srv/app')).toEqual([
      '/srv/app/a.yml',
      '/abs/b.yml',
      '/srv/app/c.yml',
    ]);
  });

  it('returns nothing for an empty label', () => {
    expect(parseComposeConfigFiles('', '/srv')).toEqual([]);
  });
});

describe('isLabelMissing', () => {
  it('treats the Go template placeholder as missing', () => {
    // `docker inspect --format '{{index .Config.Labels "x"}}'` prints this
    // literal when the key is absent — it is not a label value.
    expect(isLabelMissing('<no value>')).toBe(true);
    expect(isLabelMissing('')).toBe(true);
    expect(isLabelMissing('   ')).toBe(true);
    expect(isLabelMissing(null)).toBe(true);
    expect(isLabelMissing(undefined)).toBe(true);
    expect(isLabelMissing('swarm-os')).toBe(false);
  });
});

describe('buildComposeBaseArgs', () => {
  it('always names the project explicitly and always passes --env-file', () => {
    expect(
      buildComposeBaseArgs({
        projectName: 'swarm-os',
        envFile: '/srv/.env',
        configFiles: ['/srv/a.yml', '/srv/b.yml'],
      }),
    ).toEqual([
      'compose',
      '--project-name',
      'swarm-os',
      '--env-file',
      '/srv/.env',
      '-f',
      '/srv/a.yml',
      '-f',
      '/srv/b.yml',
    ]);
  });

  it('never emits --remove-orphans or --pull (they are not its business)', () => {
    const args = buildComposeBaseArgs({ projectName: 'p', envFile: '/e', configFiles: ['/a'] });
    expect(args).not.toContain('--remove-orphans');
    expect(args).not.toContain('--pull');
  });
});

describe('rewriteEnvStream', () => {
  const file = ['# deployment image', 'SWARM_OS_IMAGE=ghcr.io/o/r:0.5.0', '', 'PORT=8787', ''].join('\n');

  it('changes exactly one line and preserves comments, ordering and blank lines', () => {
    const r = rewriteEnvStream(file, 'SWARM_OS_IMAGE', 'ghcr.io/o/r:0.6.0');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toBe(
      ['# deployment image', 'SWARM_OS_IMAGE=ghcr.io/o/r:0.6.0', '', 'PORT=8787', ''].join('\n'),
    );
    expect(r.before).toBe('SWARM_OS_IMAGE=ghcr.io/o/r:0.5.0');
    expect(r.after).toBe('SWARM_OS_IMAGE=ghcr.io/o/r:0.6.0');
  });

  it('preserves the line’s own indentation and `export ` prefix', () => {
    const r = rewriteEnvStream('  export SWARM_OS_IMAGE=old\n', 'SWARM_OS_IMAGE', 'new');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toBe('  export SWARM_OS_IMAGE=new\n');
  });

  it('is byte-exact reversible — the rollback property', () => {
    const forward = rewriteEnvStream(file, 'SWARM_OS_IMAGE', 'ghcr.io/o/r:0.6.0');
    expect(forward.ok).toBe(true);
    if (!forward.ok) return;
    const back = rewriteEnvStream(forward.content, 'SWARM_OS_IMAGE', envValueOf(forward.before));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.content).toBe(file);
  });

  it('refuses when the variable is only referenced, never assigned', () => {
    // The `${SWARM_OS_IMAGE:-ghcr.io/…:latest}` trap: writing nothing and
    // deploying would silently install the fallback.
    expect(rewriteEnvStream('OTHER=1\n', 'SWARM_OS_IMAGE', 'x')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('refuses a duplicated assignment (dotenv is last-wins)', () => {
    expect(rewriteEnvStream('SWARM_OS_IMAGE=a\nSWARM_OS_IMAGE=b\n', 'SWARM_OS_IMAGE', 'x')).toEqual({
      ok: false,
      reason: 'multiple',
    });
  });

  it('does not match a variable that merely ends with the name', () => {
    expect(rewriteEnvStream('MY_SWARM_OS_IMAGE=a\n', 'SWARM_OS_IMAGE', 'x')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('image / env value validation', () => {
  it('accepts real references and refuses anything that could be injected', () => {
    expect(isValidImageRef('ghcr.io/nyyyxius/swarm-os:0.6.0')).toBe(true);
    expect(isValidImageRef('registry:5000/x/y:1')).toBe(true);
    expect(isValidImageRef('a b')).toBe(false);
    expect(isValidImageRef('a$(id)')).toBe(false);
    expect(isValidImageRef('a\\b')).toBe(false);
    expect(isValidImageRef('')).toBe(false);
  });

  it('lets a rollback restore a quoted operator value, but never a backslash', () => {
    expect(isValidEnvValue('"ghcr.io/o/r:1"')).toBe(true);
    expect(isValidEnvValue('a\\b')).toBe(false);
    expect(isValidEnvValue('a\nb')).toBe(false);
  });
});

describe('buildHostUpdateArgv', () => {
  const base = {
    scriptPath: '/host/data/updater/host-update.sh',
    runDir: '/host/data/updater/runs/r1',
    runId: 'r1',
    hostDataDir: '/host/data',
    dataMount: '/data',
    containerHint: 'abc123def456',
    targetImage: 'ghcr.io/o/r:0.6.0',
    envVar: 'SWARM_OS_IMAGE',
    healthPort: 8787,
  };

  it('invokes the script through bash, never directly', () => {
    // The installed copy is 0600 with no exec bit — which also survives a
    // `noexec` mount on /data.
    const argv = buildHostUpdateArgv(base);
    expect(argv[0]).toBe('bash');
    expect(argv[1]).toBe(base.scriptPath);
    expect(argv[2]).toBe('apply');
  });

  it('floors the verify timeout at 300 s even when asked for less', () => {
    const argv = buildHostUpdateArgv({ ...base, verifyTimeoutS: 30 });
    const i = argv.indexOf('--verify-timeout');
    expect(argv[i + 1]).toBe(String(VERIFY_TIMEOUT_FLOOR_S));
  });

  it('omits the container hint when there is none', () => {
    expect(buildHostUpdateArgv({ ...base, containerHint: null })).not.toContain('--container-hint');
  });
});

describe('buildRestoreEnvArgv', () => {
  it('passes the archived line base64-encoded, so quoting cannot corrupt it', () => {
    const argv = buildRestoreEnvArgv({
      scriptPath: '/s.sh',
      envFile: '/srv/.env',
      envVar: 'SWARM_OS_IMAGE',
      envLineBefore: 'SWARM_OS_IMAGE="ghcr.io/o/r:0.5.0"',
    });
    const i = argv.indexOf('--line-b64');
    expect(Buffer.from(argv[i + 1]!, 'base64').toString('utf8')).toBe(
      'SWARM_OS_IMAGE="ghcr.io/o/r:0.5.0"',
    );
  });
});

describe('runDirFor', () => {
  it('puts every run under <dataDir>/updater/runs/<runId>', () => {
    expect(runDirFor('/data', 'r1')).toBe('/data/updater/runs/r1');
  });
});

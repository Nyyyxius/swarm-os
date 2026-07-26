import { describe, it, expect } from 'vitest';
import { parseVersion, compareVersions, isNewer, tagToVersion } from './semver.js';

describe('parseVersion', () => {
  it('parses a plain triple', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
  });

  it('tolerates the `v` tag prefix and surrounding whitespace', () => {
    expect(parseVersion('v0.6.0')).toEqual({ major: 0, minor: 6, patch: 0, prerelease: null });
    expect(parseVersion('  v0.6.0\n')).toEqual({ major: 0, minor: 6, patch: 0, prerelease: null });
  });

  it('captures a pre-release and ignores build metadata', () => {
    expect(parseVersion('0.6.0-phase6')?.prerelease).toBe('phase6');
    expect(parseVersion('0.6.0+build.7')?.prerelease).toBeNull();
    expect(parseVersion('0.6.0-rc.1+build.7')?.prerelease).toBe('rc.1');
  });

  it('returns null on malformed input rather than guessing', () => {
    for (const bad of ['dev', '', '1', '1.2', '1.2.3.4', 'v', 'x.y.z', '1.2.-3', 'latest', null, undefined]) {
      expect(parseVersion(bad as string)).toBeNull();
    }
  });
});

describe('compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(compareVersions('1.2.10', '1.2.9')).toBe(1);
    expect(compareVersions('0.5.0', '0.6.0')).toBe(-1);
  });

  it('is numeric, not lexicographic', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
  });

  it('treats equal triples as equal regardless of the `v` prefix', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });

  it('never ranks a pre-release above its own release', () => {
    expect(compareVersions('1.0.0-rc1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-rc1')).toBe(1);
  });

  it('does not order two pre-releases of the same triple', () => {
    expect(compareVersions('1.0.0-rc1', '1.0.0-rc2')).toBe(0);
  });

  it('still ranks a pre-release of a higher triple above a lower release', () => {
    expect(compareVersions('1.1.0-rc1', '1.0.0')).toBe(1);
  });

  it('returns null when either side is unparsable', () => {
    expect(compareVersions('dev', '1.0.0')).toBeNull();
    expect(compareVersions('1.0.0', 'dev')).toBeNull();
    expect(compareVersions(null, '1.0.0')).toBeNull();
    expect(compareVersions('1.0.0', undefined)).toBeNull();
  });
});

describe('isNewer', () => {
  it('is true only for a strictly greater, parsable candidate', () => {
    expect(isNewer('0.6.0', '0.5.0')).toBe(true);
    expect(isNewer('0.5.0', '0.5.0')).toBe(false);
    expect(isNewer('0.4.0', '0.5.0')).toBe(false);
  });

  it('is false — never true — when the comparison is impossible', () => {
    expect(isNewer('0.6.0', 'dev')).toBe(false);
    expect(isNewer('not-a-version', '0.5.0')).toBe(false);
  });
});

describe('tagToVersion', () => {
  it('strips a leading v only when a digit follows', () => {
    expect(tagToVersion('v0.6.0')).toBe('0.6.0');
    expect(tagToVersion('0.6.0')).toBe('0.6.0');
    expect(tagToVersion('vNext')).toBe('vNext');
  });
});

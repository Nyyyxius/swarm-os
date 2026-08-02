import { describe, it, expect } from 'vitest';
import {
  resolveTrust,
  trustBypassesReview,
  skillHasRisk,
  isReviewRequired,
  trustPolicyFromEnv,
  type TrustPolicy,
} from './trust.js';

const EMPTY: TrustPolicy = { verified: [], firstParty: [] };

describe('resolveTrust', () => {
  it('classifies a dir source as local regardless of allowlists', () => {
    expect(resolveTrust('dir', '/home/op/skill', EMPTY)).toBe('local');
    expect(resolveTrust('dir', '/home/op/skill', { verified: ['/home/op'], firstParty: [] })).toBe('local');
  });

  it('defaults git/npm to community when not allowlisted', () => {
    expect(resolveTrust('git', 'https://github.com/rando/x', EMPTY)).toBe('community');
    expect(resolveTrust('npm', 'some-skill@1.0.0', EMPTY)).toBe('community');
  });

  it('promotes a git source to verified via the allowlist', () => {
    const policy: TrustPolicy = { verified: ['github.com/acme/'], firstParty: [] };
    expect(resolveTrust('git', 'https://github.com/acme/skills', policy)).toBe('verified');
    expect(resolveTrust('git', 'https://github.com/other/skills', policy)).toBe('community');
  });

  it('promotes an npm source to verified via a spec prefix', () => {
    const policy: TrustPolicy = { verified: ['@acme/'], firstParty: [] };
    expect(resolveTrust('npm', '@acme/greeter@2.0.0', policy)).toBe('verified');
    expect(resolveTrust('npm', '@evil/greeter', policy)).toBe('community');
  });

  it('first-party takes precedence over verified', () => {
    const policy: TrustPolicy = { verified: ['github.com/acme/'], firstParty: ['github.com/acme/core'] };
    expect(resolveTrust('git', 'https://github.com/acme/core', policy)).toBe('first-party');
    expect(resolveTrust('git', 'https://github.com/acme/other', policy)).toBe('verified');
  });

  it('classifies upload/market as community', () => {
    expect(resolveTrust('upload', null, EMPTY)).toBe('community');
    expect(resolveTrust('market', 'greeter', EMPTY)).toBe('community');
  });
});

describe('trustBypassesReview', () => {
  it('exempts first-party and verified only', () => {
    expect(trustBypassesReview('first-party')).toBe(true);
    expect(trustBypassesReview('verified')).toBe(true);
    expect(trustBypassesReview('community')).toBe(false);
    expect(trustBypassesReview('local')).toBe(false);
  });
});

describe('skillHasRisk / isReviewRequired', () => {
  it('is risky when it ships assets OR requests capabilities', () => {
    expect(skillHasRisk(true, [])).toBe(true);
    expect(skillHasRisk(false, ['fs'])).toBe(true);
    expect(skillHasRisk(false, [])).toBe(false);
  });

  it('requires review for a risky community/local skill not yet reviewed', () => {
    expect(isReviewRequired({ trust: 'community', assetsPresent: true, capabilities: [], reviewed: false })).toBe(true);
    expect(isReviewRequired({ trust: 'local', assetsPresent: true, capabilities: [], reviewed: false })).toBe(true);
  });

  it('does not require review once reviewed', () => {
    expect(isReviewRequired({ trust: 'community', assetsPresent: true, capabilities: [], reviewed: true })).toBe(false);
  });

  it('exempts a risky skill from review when trust is first-party/verified', () => {
    expect(isReviewRequired({ trust: 'verified', assetsPresent: true, capabilities: [], reviewed: false })).toBe(false);
    expect(isReviewRequired({ trust: 'first-party', assetsPresent: false, capabilities: ['fs'], reviewed: false })).toBe(false);
  });

  it('never requires review for a non-risky skill', () => {
    expect(isReviewRequired({ trust: 'community', assetsPresent: false, capabilities: [], reviewed: false })).toBe(false);
  });
});

describe('trustPolicyFromEnv', () => {
  it('splits comma/space separated allowlists', () => {
    const p = trustPolicyFromEnv({
      SWARM_OS_SKILLS_VERIFIED: 'github.com/acme/, @acme/  npmthing',
      SWARM_OS_SKILLS_FIRST_PARTY: 'github.com/swarm-os/core',
    } as NodeJS.ProcessEnv);
    expect(p.verified).toEqual(['github.com/acme/', '@acme/', 'npmthing']);
    expect(p.firstParty).toEqual(['github.com/swarm-os/core']);
  });

  it('returns empty lists when unset', () => {
    expect(trustPolicyFromEnv({} as NodeJS.ProcessEnv)).toEqual({ verified: [], firstParty: [] });
  });
});

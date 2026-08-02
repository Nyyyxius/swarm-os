/**
 * Skill trust model + review gate (docs/plan-skills-importables.md §9, Lot 3).
 *
 * A skill is DATA (§0) — nothing here runs skill code. Trust classifies the
 * SOURCE a skill came from; the review gate governs whether a skill that can
 * reach a `bypassPermissions` agent (executable `assets/` OR a declared
 * `requires.capabilities`) may be ACTIVATED without an explicit operator review.
 *
 * Trust levels (store.ts `SKILL_TRUST_LEVELS`):
 *   - `first-party` — curated / shipped with swarm-os        → review-exempt
 *   - `verified`    — a known/allowlisted publisher          → review-exempt
 *   - `community`   — arbitrary public git/npm/market (default) → review if risky
 *   - `local`       — the operator's own directory import     → review if risky
 *
 * The allowlists that promote a source to `verified` / `first-party` are read
 * from the environment (no config.ts churn) but are INJECTABLE so tests pin a
 * policy instead of the ambient process env.
 */

import { decodeGitRef } from '../install-core/fetch.js';
import type { SkillTrust } from './store.js';

/** Sources whose trust has been vetted by a human out-of-band → skip the gate. */
const REVIEW_EXEMPT_TRUST: ReadonlySet<string> = new Set(['first-party', 'verified']);

/** Allowlists that promote a git/npm source above the `community` default. */
export interface TrustPolicy {
  /** Match → `verified`. Entries are url prefixes (git) or npm spec prefixes. */
  verified: string[];
  /** Match → `first-party` (takes precedence over `verified`). */
  firstParty: string[];
}

/** Split a comma/space/newline separated env list into trimmed, non-empty entries. */
function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Build a {@link TrustPolicy} from the environment. `env` is injectable so unit
 * tests supply a fixed policy without touching `process.env`.
 *   SWARM_OS_SKILLS_VERIFIED     — allowlist promoting a source to `verified`
 *   SWARM_OS_SKILLS_FIRST_PARTY  — allowlist promoting a source to `first-party`
 */
export function trustPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): TrustPolicy {
  return {
    verified: splitList(env.SWARM_OS_SKILLS_VERIFIED),
    firstParty: splitList(env.SWARM_OS_SKILLS_FIRST_PARTY),
  };
}

/** The address an allowlist entry is matched against, normalised per source kind. */
function matchTarget(sourceKind: string, sourceRef: string | null): string {
  if (!sourceRef) return '';
  if (sourceKind === 'git') {
    // `source_ref` for git encodes `url#ref#subdir`; match against the bare url.
    try {
      return decodeGitRef(sourceRef).url;
    } catch {
      return sourceRef;
    }
  }
  return sourceRef;
}

/** True when `target` starts with, or contains, any allowlist entry. */
function matchesAllowlist(target: string, list: readonly string[]): boolean {
  if (target.length === 0) return false;
  return list.some((entry) => entry.length > 0 && target.includes(entry));
}

/**
 * Classify a skill's trust from its source + the active policy.
 *   - `dir`   → `local` (the operator's own filesystem)
 *   - `git`/`npm` → `first-party` / `verified` if allowlisted, else `community`
 *   - anything else (`upload`, `market`, …) → `community`
 *
 * Recomputed on every install/upgrade so an operator adding a repo to the
 * allowlist upgrades the skill's trust on the next re-import (a re-import never
 * silently downgrades review state — that is handled in the installer).
 */
export function resolveTrust(
  sourceKind: string,
  sourceRef: string | null,
  policy: TrustPolicy,
): SkillTrust {
  if (sourceKind === 'git' || sourceKind === 'npm') {
    const target = matchTarget(sourceKind, sourceRef);
    if (matchesAllowlist(target, policy.firstParty)) return 'first-party';
    if (matchesAllowlist(target, policy.verified)) return 'verified';
    return 'community';
  }
  if (sourceKind === 'dir') return 'local';
  return 'community';
}

/** A source whose trust is high enough to skip the executable-review gate. */
export function trustBypassesReview(trust: string): boolean {
  return REVIEW_EXEMPT_TRUST.has(trust);
}

/**
 * A skill carries risk when it can reach a bypass agent with code: it ships an
 * `assets/` dir (scripts an agent may run) OR declares `requires.capabilities`
 * (it expects elevated plugin powers). Instruction-only skills are not "risky"
 * here — their prompt-injection risk is mitigated by the preamble's
 * "added, never substituted" invariant.
 */
export function skillHasRisk(assetsPresent: boolean, capabilities: readonly string[]): boolean {
  return assetsPresent || capabilities.length > 0;
}

/**
 * Whether ACTIVATING this skill must be gated behind an explicit review. True
 * when the skill is risky, its trust does not exempt it, and it has not already
 * been reviewed.
 */
export function isReviewRequired(opts: {
  trust: string;
  assetsPresent: boolean;
  capabilities: readonly string[];
  reviewed: boolean;
}): boolean {
  if (!skillHasRisk(opts.assetsPresent, opts.capabilities)) return false;
  if (trustBypassesReview(opts.trust)) return false;
  return !opts.reviewed;
}

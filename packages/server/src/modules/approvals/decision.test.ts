import { describe, it, expect } from 'vitest';
import { parseApprovalDecision } from './decision.js';

/**
 * P4 decision parser — maps a free-text Discord reply to approve/deny
 * (+ don't-ask-again). Conservative: only a clear, unambiguous signal returns a
 * decision; anything else is `null` so the bot lets the message flow to the
 * inbox instead of typing a guessed key into a PTY.
 */
describe('parseApprovalDecision', () => {
  it('recognizes English approve words', () => {
    for (const t of ['yes', 'approve', 'ok', 'okay', 'y', 'allow it', 'go']) {
      expect(parseApprovalDecision(t)?.decision, t).toBe('approve');
    }
  });

  it('recognizes French approve words', () => {
    for (const t of ['oui', 'approuve', 'accepté', 'valide']) {
      expect(parseApprovalDecision(t)?.decision, t).toBe('approve');
    }
  });

  it('recognizes English deny words', () => {
    for (const t of ['no', 'deny', 'nope', 'reject', 'block it', 'stop']) {
      expect(parseApprovalDecision(t)?.decision, t).toBe('deny');
    }
  });

  it('recognizes French deny words', () => {
    for (const t of ['non', 'refuse', 'refusé', 'annule']) {
      expect(parseApprovalDecision(t)?.decision, t).toBe('deny');
    }
  });

  it('recognizes approve / deny emoji', () => {
    expect(parseApprovalDecision('✅')?.decision).toBe('approve');
    expect(parseApprovalDecision('👍 go for it')?.decision).toBe('approve');
    expect(parseApprovalDecision('❌')?.decision).toBe('deny');
    expect(parseApprovalDecision('👎')?.decision).toBe('deny');
  });

  it('detects "don\'t ask again" only on approve', () => {
    expect(parseApprovalDecision('oui, ne plus demander')).toEqual({
      decision: 'approve',
      dontAskAgain: true,
    });
    expect(parseApprovalDecision("yes, don't ask again")).toEqual({
      decision: 'approve',
      dontAskAgain: true,
    });
    expect(parseApprovalDecision('approve always')).toEqual({
      decision: 'approve',
      dontAskAgain: true,
    });
    // Plain approve → dontAskAgain false.
    expect(parseApprovalDecision('yes')).toEqual({ decision: 'approve', dontAskAgain: false });
  });

  it('returns null for empty / whitespace', () => {
    expect(parseApprovalDecision('')).toBeNull();
    expect(parseApprovalDecision('   ')).toBeNull();
  });

  it('returns null for ambiguous text (both signals)', () => {
    expect(parseApprovalDecision('yes no')).toBeNull();
    expect(parseApprovalDecision('✅ ❌')).toBeNull();
  });

  it('returns null for unrelated text (no signal) — lets it flow to inbox', () => {
    expect(parseApprovalDecision('what is this about?')).toBeNull();
    expect(parseApprovalDecision('can you explain the change')).toBeNull();
  });

  it('does not match substrings inside larger words', () => {
    // "notably" contains "no", "yesterday" contains "yes" — whole-word only.
    expect(parseApprovalDecision('notably interesting')).toBeNull();
    expect(parseApprovalDecision('yesterday we shipped')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(parseApprovalDecision('YES')?.decision).toBe('approve');
    expect(parseApprovalDecision('NON')?.decision).toBe('deny');
  });
});

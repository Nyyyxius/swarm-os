import { describe, it, expect } from 'vitest';
import { keystrokeFor } from './keystrokes.js';

describe('keystrokeFor (claude permission prompt)', () => {
  it('maps approve → "1" as a raw keystroke (hotkey, no submit dance)', () => {
    const plan = keystrokeFor('claude', 'approve');
    expect(plan).not.toBeNull();
    expect(plan!.data).toBe('1');
    expect(plan!.submit).toBe(false);
    expect(plan!.label).toContain('approve');
  });

  it('maps approve + dontAskAgain → "2"', () => {
    const plan = keystrokeFor('claude', 'approve', true);
    expect(plan!.data).toBe('2');
    expect(plan!.submit).toBe(false);
    expect(plan!.label).toContain('dontAskAgain');
  });

  it('maps deny → "3" (dontAskAgain is irrelevant for a deny)', () => {
    expect(keystrokeFor('claude', 'deny')!.data).toBe('3');
    expect(keystrokeFor('claude', 'deny', true)!.data).toBe('3');
  });
});

describe('keystrokeFor (no mapping)', () => {
  it('returns null for bypass-only providers (no prompt to answer today)', () => {
    for (const p of ['codex', 'gemini', 'opencode']) {
      expect(keystrokeFor(p, 'approve')).toBeNull();
      expect(keystrokeFor(p, 'deny')).toBeNull();
    }
  });

  it('returns null for unknown / empty providers', () => {
    expect(keystrokeFor('mystery', 'approve')).toBeNull();
    expect(keystrokeFor(undefined, 'approve')).toBeNull();
    expect(keystrokeFor('', 'deny')).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { classifyCategory, isPromptingMode, summarizeRequest } from './prompting.js';

describe('isPromptingMode', () => {
  it('arms for claude default / plan / acceptEdits (modes that prompt)', () => {
    expect(isPromptingMode('claude', 'default')).toBe(true);
    expect(isPromptingMode('claude', 'plan')).toBe(true);
    expect(isPromptingMode('claude', 'acceptEdits')).toBe(true);
  });

  it('never arms for claude bypass / dontAsk / auto (modes that do NOT prompt)', () => {
    expect(isPromptingMode('claude', 'bypassPermissions')).toBe(false);
    expect(isPromptingMode('claude', 'dontAsk')).toBe(false);
    expect(isPromptingMode('claude', 'auto')).toBe(false);
  });

  it('never arms for codex / gemini / opencode today (bypassPermissions-only)', () => {
    for (const p of ['codex', 'gemini', 'opencode']) {
      expect(isPromptingMode(p, 'default')).toBe(false);
      expect(isPromptingMode(p, 'plan')).toBe(false);
      expect(isPromptingMode(p, 'bypassPermissions')).toBe(false);
    }
  });

  it('fails closed on unknown / empty inputs', () => {
    expect(isPromptingMode('claude', undefined)).toBe(false);
    expect(isPromptingMode('claude', '')).toBe(false);
    expect(isPromptingMode(undefined, 'default')).toBe(false);
    expect(isPromptingMode('mystery', 'default')).toBe(false);
  });
});

describe('classifyCategory', () => {
  it('classifies explicit permission phrasing as permission', () => {
    expect(classifyCategory('Claude needs your permission to use Bash')).toBe('permission');
    expect(classifyCategory('Allow this command to run?')).toBe('permission');
    expect(classifyCategory('Approve the edit to config.ts')).toBe('permission');
    expect(classifyCategory('The agent wants to run npm install')).toBe('permission');
  });

  it('classifies a named tool as permission even without a keyword', () => {
    expect(classifyCategory('Bash(rm -rf build)')).toBe('permission');
    expect(classifyCategory('Write to /etc/hosts')).toBe('permission');
  });

  it('classifies a plain question (with ?) as question', () => {
    expect(classifyCategory('Which database should I target for the migration?')).toBe('question');
    expect(classifyCategory('Should the button be blue or green?')).toBe('question');
  });

  it('defaults to permission on doubt (empty / opaque message)', () => {
    expect(classifyCategory('')).toBe('permission');
    expect(classifyCategory('   ')).toBe('permission');
    expect(classifyCategory(undefined)).toBe('permission');
    expect(classifyCategory('blocked')).toBe('permission');
  });
});

describe('summarizeRequest', () => {
  it('uses the first non-empty line, whitespace-collapsed', () => {
    expect(summarizeRequest('\n\n  needs   permission  to  use Bash \n more', 'fb')).toBe(
      'needs permission to use Bash',
    );
  });

  it('falls back when the message is empty / blank', () => {
    expect(summarizeRequest('', 'worker-1 needs approval')).toBe('worker-1 needs approval');
    expect(summarizeRequest('   \n  ', 'fb')).toBe('fb');
    expect(summarizeRequest(undefined, 'fb')).toBe('fb');
  });

  it('truncates an overlong line with an ellipsis', () => {
    const long = 'x'.repeat(400);
    const out = summarizeRequest(long, 'fb');
    expect(out.length).toBe(160);
    expect(out.endsWith('…')).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { parseWikilinks } from './wikilinks';

describe('parseWikilinks', () => {
  it('returns [] for empty / linkless bodies', () => {
    expect(parseWikilinks('')).toEqual([]);
    expect(parseWikilinks('just some prose, no links here')).toEqual([]);
  });

  it('extracts a single link', () => {
    expect(parseWikilinks('see [[other-note]] for details')).toEqual(['other-note']);
  });

  it('extracts multiple links in order', () => {
    expect(parseWikilinks('[[alpha]] then [[beta]] then [[gamma]]')).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  it('uses the target before the pipe, not the alias', () => {
    expect(parseWikilinks('read [[real-name|Nice Label]]')).toEqual(['real-name']);
  });

  it('trims whitespace around the target', () => {
    expect(parseWikilinks('[[  spaced-name  ]]')).toEqual(['spaced-name']);
  });

  it('de-duplicates repeated targets, preserving first-seen order', () => {
    expect(parseWikilinks('[[a]] [[b]] [[a]] [[c]] [[b]]')).toEqual(['a', 'b', 'c']);
  });

  it('ignores empty targets', () => {
    expect(parseWikilinks('empty [[]] and [[   ]] blank')).toEqual([]);
  });

  it('does not treat a nested / malformed bracket as a link', () => {
    // `[[a[b]]` — the inner `[` is excluded by the character class.
    expect(parseWikilinks('[[plain]] and [single] and ](url)')).toEqual(['plain']);
  });
});

import { describe, it, expect } from 'vitest';
import {
  parseWikilinks,
  normalizeRelation,
  typedLinkLine,
  appendTypedLink,
} from './wikilinks';

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

describe('normalizeRelation', () => {
  it('lower-cases, replaces spaces/slashes with underscore', () => {
    expect(normalizeRelation('Depends On')).toBe('depends_on');
    expect(normalizeRelation('part/of')).toBe('part_of');
  });

  it('drops illegal chars and a leading non-letter', () => {
    expect(normalizeRelation('  blocks!  ')).toBe('blocks');
    expect(normalizeRelation('2for1')).toBe('for1'); // must start with a letter
  });

  it('returns "" for an unusable label', () => {
    expect(normalizeRelation('   ')).toBe('');
    expect(normalizeRelation('123')).toBe('');
  });
});

describe('typedLinkLine', () => {
  it('builds a Dataview inline field the server parses back', () => {
    expect(typedLinkLine('depends on', 'db-schema')).toBe('depends_on:: [[db-schema]]');
  });

  it('returns null for an invalid relation or empty target', () => {
    expect(typedLinkLine('123', 'x')).toBeNull();
    expect(typedLinkLine('uses', '  ')).toBeNull();
  });
});

describe('appendTypedLink', () => {
  it('appends with a single blank-line separator', () => {
    expect(appendTypedLink('The fact.', 'blocks', 'ship-it')).toBe(
      'The fact.\n\nblocks:: [[ship-it]]\n',
    );
  });

  it('seeds an empty body without leading blank lines', () => {
    expect(appendTypedLink('', 'uses', 'x')).toBe('uses:: [[x]]\n');
  });

  it('is idempotent for an identical existing line', () => {
    const once = appendTypedLink('body', 'uses', 'x');
    expect(appendTypedLink(once, 'uses', 'x')).toBe(once);
  });

  it('returns the body unchanged for an invalid relation', () => {
    expect(appendTypedLink('body', '123', 'x')).toBe('body');
  });
});

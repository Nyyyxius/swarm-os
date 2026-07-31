import { describe, it, expect } from 'vitest';
import { parseMarkdown, parseInline, type Block } from './markdown';

describe('parseInline', () => {
  it('returns a single text node for plain text', () => {
    expect(parseInline('hello world')).toEqual([{ t: 'text', value: 'hello world' }]);
  });

  it('parses inline code', () => {
    expect(parseInline('run `npm test` now')).toEqual([
      { t: 'text', value: 'run ' },
      { t: 'code', value: 'npm test' },
      { t: 'text', value: ' now' },
    ]);
  });

  it('parses strong and em', () => {
    expect(parseInline('**bold** and *italic* and _also_')).toEqual([
      { t: 'strong', value: 'bold' },
      { t: 'text', value: ' and ' },
      { t: 'em', value: 'italic' },
      { t: 'text', value: ' and ' },
      { t: 'em', value: 'also' },
    ]);
  });

  it('parses links', () => {
    expect(parseInline('see [docs](https://x.dev)')).toEqual([
      { t: 'text', value: 'see ' },
      { t: 'link', value: 'docs', href: 'https://x.dev' },
    ]);
  });

  it('parses wikilinks with and without an alias', () => {
    expect(parseInline('[[a-note]] and [[real|Nice]]')).toEqual([
      { t: 'wikilink', target: 'a-note', label: 'a-note' },
      { t: 'text', value: ' and ' },
      { t: 'wikilink', target: 'real', label: 'Nice' },
    ]);
  });
});

describe('parseMarkdown', () => {
  it('parses a heading', () => {
    expect(parseMarkdown('## Title')).toEqual<Block[]>([
      { t: 'heading', level: 2, inline: [{ t: 'text', value: 'Title' }] },
    ]);
  });

  it('parses a paragraph, joining wrapped lines', () => {
    const out = parseMarkdown('one\ntwo');
    expect(out).toEqual<Block[]>([
      { t: 'paragraph', inline: [{ t: 'text', value: 'one two' }] },
    ]);
  });

  it('separates paragraphs on a blank line', () => {
    const out = parseMarkdown('para one\n\npara two');
    expect(out).toHaveLength(2);
    expect(out[0]!.t).toBe('paragraph');
    expect(out[1]!.t).toBe('paragraph');
  });

  it('parses a fenced code block with a language', () => {
    const out = parseMarkdown('```ts\nconst x = 1;\n```');
    expect(out).toEqual<Block[]>([{ t: 'code', value: 'const x = 1;', lang: 'ts' }]);
  });

  it('parses an unordered list', () => {
    const out = parseMarkdown('- first\n- second');
    expect(out).toEqual<Block[]>([
      {
        t: 'list',
        ordered: false,
        items: [
          [{ t: 'text', value: 'first' }],
          [{ t: 'text', value: 'second' }],
        ],
      },
    ]);
  });

  it('parses an ordered list', () => {
    const out = parseMarkdown('1. one\n2. two');
    expect(out[0]).toMatchObject({ t: 'list', ordered: true });
  });

  it('parses a blockquote', () => {
    expect(parseMarkdown('> quoted line')).toEqual<Block[]>([
      { t: 'blockquote', inline: [{ t: 'text', value: 'quoted line' }] },
    ]);
  });

  it('parses a thematic break', () => {
    expect(parseMarkdown('---')).toEqual<Block[]>([{ t: 'hr' }]);
  });

  it('carries wikilinks through a paragraph', () => {
    const out = parseMarkdown('links to [[other]] here');
    expect(out[0]).toEqual<Block>({
      t: 'paragraph',
      inline: [
        { t: 'text', value: 'links to ' },
        { t: 'wikilink', target: 'other', label: 'other' },
        { t: 'text', value: ' here' },
      ],
    });
  });

  it('handles an empty document', () => {
    expect(parseMarkdown('')).toEqual([]);
  });
});

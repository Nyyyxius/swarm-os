// packages/web/src/lib/markdown.ts
//
// A deliberately tiny, dependency-free markdown parser producing a small AST.
// Rendering to React lives in `components/memory/MarkdownView.tsx`; keeping the
// parse pure means it is unit-testable and safe (no `dangerouslySetInnerHTML`,
// no HTML injection — the renderer only ever emits known element types).
//
// Supported (enough for agent-authored notes): ATX headings, fenced code,
// unordered/ordered lists, blockquotes, thematic breaks, and paragraphs; inline
// `code`, **strong**, *em* / _em_, [links](url), and Obsidian `[[wikilinks]]`.

export type Inline =
  | { t: 'text'; value: string }
  | { t: 'strong'; value: string }
  | { t: 'em'; value: string }
  | { t: 'code'; value: string }
  | { t: 'link'; value: string; href: string }
  | { t: 'wikilink'; target: string; label: string };

export type Block =
  | { t: 'heading'; level: number; inline: Inline[] }
  | { t: 'paragraph'; inline: Inline[] }
  | { t: 'code'; value: string; lang?: string }
  | { t: 'list'; ordered: boolean; items: Inline[][] }
  | { t: 'blockquote'; inline: Inline[] }
  | { t: 'hr' };

const RE_FENCE = /^```(\w+)?\s*$/;
const RE_FENCE_CLOSE = /^```\s*$/;
const RE_HR = /^(-{3,}|\*{3,}|_{3,})\s*$/;
const RE_HEADING = /^(#{1,6})\s+(.*)$/;
const RE_QUOTE = /^>\s?/;
const RE_LIST = /^\s*([-*+]|\d+\.)\s+/;
const RE_LIST_ORDERED = /^\s*\d+\.\s+/;

/** Parse a full markdown document into a flat list of blocks. */
export function parseMarkdown(src: string): Block[] {
  const lines = (src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i++;
      continue;
    }

    const fence = RE_FENCE.exec(line);
    if (fence) {
      const lang = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !RE_FENCE_CLOSE.test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      i++; // consume closing fence (or run off the end)
      blocks.push(lang ? { t: 'code', value: body.join('\n'), lang } : { t: 'code', value: body.join('\n') });
      continue;
    }

    if (RE_HR.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }

    const h = RE_HEADING.exec(line);
    if (h) {
      blocks.push({ t: 'heading', level: h[1]!.length, inline: parseInline(h[2]!.trim()) });
      i++;
      continue;
    }

    if (RE_QUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && RE_QUOTE.test(lines[i]!)) {
        buf.push(lines[i]!.replace(RE_QUOTE, ''));
        i++;
      }
      blocks.push({ t: 'blockquote', inline: parseInline(buf.join(' ')) });
      continue;
    }

    if (RE_LIST.test(line)) {
      const ordered = RE_LIST_ORDERED.test(line);
      const items: Inline[][] = [];
      while (i < lines.length && RE_LIST.test(lines[i]!)) {
        items.push(parseInline(lines[i]!.replace(RE_LIST, '')));
        i++;
      }
      blocks.push({ t: 'list', ordered, items });
      continue;
    }

    // Paragraph — gather consecutive lines until a blank line or a new block.
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !RE_FENCE.test(lines[i]!) &&
      !RE_HEADING.test(lines[i]!) &&
      !RE_QUOTE.test(lines[i]!) &&
      !RE_LIST.test(lines[i]!) &&
      !RE_HR.test(lines[i]!)
    ) {
      buf.push(lines[i]!);
      i++;
    }
    blocks.push({ t: 'paragraph', inline: parseInline(buf.join(' ')) });
  }

  return blocks;
}

/** Parse a single line/run of text into inline nodes. */
export function parseInline(text: string): Inline[] {
  const nodes: Inline[] = [];
  let buf = '';
  let i = 0;
  const flush = (): void => {
    if (buf) {
      nodes.push({ t: 'text', value: buf });
      buf = '';
    }
  };

  while (i < text.length) {
    const rest = text.slice(i);

    let m = /^`([^`]+)`/.exec(rest);
    if (m) {
      flush();
      nodes.push({ t: 'code', value: m[1]! });
      i += m[0].length;
      continue;
    }

    m = /^\[\[([^\][]+?)\]\]/.exec(rest);
    if (m) {
      flush();
      const parts = m[1]!.split('|');
      const target = (parts[0] ?? '').trim();
      const label = (parts[1] ?? parts[0] ?? '').trim();
      nodes.push({ t: 'wikilink', target, label: label || target });
      i += m[0].length;
      continue;
    }

    m = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
    if (m) {
      flush();
      nodes.push({ t: 'link', value: m[1]!, href: m[2]! });
      i += m[0].length;
      continue;
    }

    m = /^\*\*([^*]+)\*\*/.exec(rest);
    if (m) {
      flush();
      nodes.push({ t: 'strong', value: m[1]! });
      i += m[0].length;
      continue;
    }

    m = /^\*([^*]+)\*/.exec(rest) ?? /^_([^_]+)_/.exec(rest);
    if (m) {
      flush();
      nodes.push({ t: 'em', value: m[1]! });
      i += m[0].length;
      continue;
    }

    buf += text[i];
    i++;
  }

  flush();
  return nodes;
}

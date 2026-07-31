// packages/web/src/components/memory/MarkdownView.tsx
//
// Renders the pure markdown AST from `lib/markdown.ts` into React elements.
// It never uses `dangerouslySetInnerHTML` — only known element types are
// emitted, so an agent-authored note cannot inject markup. `[[wikilinks]]`
// render as buttons that call `onOpenNote(target)` so the graph and the note
// panel stay navigable from prose.

import { createElement, Fragment, type ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from '../../lib/markdown';

interface Props {
  source: string;
  /** Called when a `[[wikilink]]` is clicked. */
  onOpenNote?: (name: string) => void;
}

function renderInline(node: Inline, key: number, onOpenNote?: (n: string) => void): ReactNode {
  switch (node.t) {
    case 'text':
      return <Fragment key={key}>{node.value}</Fragment>;
    case 'strong':
      return <strong key={key}>{node.value}</strong>;
    case 'em':
      return <em key={key}>{node.value}</em>;
    case 'code':
      return (
        <code key={key} className="md-code">
          {node.value}
        </code>
      );
    case 'link':
      return (
        <a key={key} href={node.href} target="_blank" rel="noreferrer noopener" className="md-link">
          {node.value}
        </a>
      );
    case 'wikilink':
      return (
        <button
          key={key}
          type="button"
          className="md-wikilink"
          onClick={() => onOpenNote?.(node.target)}
          title={`open [[${node.target}]]`}
        >
          {node.label}
        </button>
      );
    default:
      return null;
  }
}

function renderInlines(nodes: Inline[], onOpenNote?: (n: string) => void): ReactNode {
  return nodes.map((n, i) => renderInline(n, i, onOpenNote));
}

function renderBlock(block: Block, key: number, onOpenNote?: (n: string) => void): ReactNode {
  switch (block.t) {
    case 'heading': {
      const tag = `h${Math.min(6, Math.max(1, block.level))}`;
      return createElement(
        tag,
        { key, className: 'md-h' },
        renderInlines(block.inline, onOpenNote),
      );
    }
    case 'paragraph':
      return (
        <p key={key} className="md-p">
          {renderInlines(block.inline, onOpenNote)}
        </p>
      );
    case 'code':
      return (
        <pre key={key} className="md-pre">
          <code>{block.value}</code>
        </pre>
      );
    case 'list':
      return block.ordered ? (
        <ol key={key} className="md-list">
          {block.items.map((it, i) => (
            <li key={i}>{renderInlines(it, onOpenNote)}</li>
          ))}
        </ol>
      ) : (
        <ul key={key} className="md-list">
          {block.items.map((it, i) => (
            <li key={i}>{renderInlines(it, onOpenNote)}</li>
          ))}
        </ul>
      );
    case 'blockquote':
      return (
        <blockquote key={key} className="md-quote">
          {renderInlines(block.inline, onOpenNote)}
        </blockquote>
      );
    case 'hr':
      return <hr key={key} className="md-hr" />;
    default:
      return null;
  }
}

export default function MarkdownView({ source, onOpenNote }: Props) {
  const blocks = parseMarkdown(source);
  if (blocks.length === 0) {
    return <div className="md-empty">— (empty note) —</div>;
  }
  return <div className="md-body">{blocks.map((b, i) => renderBlock(b, i, onOpenNote))}</div>;
}

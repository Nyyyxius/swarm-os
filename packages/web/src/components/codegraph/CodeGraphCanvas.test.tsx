import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import CodeGraphCanvas, { accentForFileType, truncateLabel } from './CodeGraphCanvas';
import type { CodegraphNode, CodegraphLink } from '../../api/client';

const NODES: CodegraphNode[] = [
  { id: 'a', label: 'alpha()', source_file: 'src/a.ts', source_location: 'L1', file_type: 'code' },
  { id: 'b', label: 'beta()', source_file: 'src/b.ts', source_location: 'L2', file_type: 'code' },
  { id: 'c', label: 'gamma()', file_type: 'document', community_name: 'docs' },
];
const LINKS: CodegraphLink[] = [
  { source: 'a', target: 'b', relation: 'calls' },
  { source: 'b', target: 'c', relation: 'links' },
];

describe('accentForFileType', () => {
  it('maps document → dim, code/other → info, using theme tokens only', () => {
    expect(accentForFileType('document')).toBe('var(--text-dim)');
    expect(accentForFileType('code')).toBe('var(--info)');
    expect(accentForFileType(undefined)).toBe('var(--info)');
    expect(accentForFileType(null)).toBe('var(--info)');
  });
});

describe('truncateLabel', () => {
  it('leaves short labels untouched', () => {
    expect(truncateLabel('short', 24)).toBe('short');
  });
  it('truncates long labels with an ellipsis', () => {
    const out = truncateLabel('x'.repeat(40), 24);
    expect(out).toHaveLength(24);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('CodeGraphCanvas', () => {
  it('renders one glyph per node and one path per edge', () => {
    const { container } = render(
      <CodeGraphCanvas nodes={NODES} links={LINKS} selectedId={null} onSelect={() => undefined} />,
    );
    expect(container.querySelectorAll('.cgc-node')).toHaveLength(NODES.length);
    expect(container.querySelectorAll('.cgc-edge')).toHaveLength(LINKS.length);
  });

  it('calls onSelect with the node id when a node is clicked', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <CodeGraphCanvas nodes={NODES} links={LINKS} selectedId={null} onSelect={onSelect} />,
    );
    const first = container.querySelector('.cgc-node');
    expect(first).toBeTruthy();
    fireEvent.click(first!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    // Layout preserves input order → first glyph is the first input node.
    expect(onSelect).toHaveBeenCalledWith(first!.getAttribute('data-id'));
    expect(first!.getAttribute('data-id')).toBe('a');
  });

  it('highlights the selected node ring', () => {
    const { container } = render(
      <CodeGraphCanvas nodes={NODES} links={LINKS} selectedId="b" onSelect={() => undefined} />,
    );
    expect(container.querySelectorAll('.cgc-node-ring.selected')).toHaveLength(1);
  });

  it('renders the HUD note when provided', () => {
    const { getByText } = render(
      <CodeGraphCanvas
        nodes={NODES}
        links={LINKS}
        selectedId="a"
        onSelect={() => undefined}
        hudNote="120/512 voisins"
      />,
    );
    expect(getByText('120/512 voisins')).toBeTruthy();
  });

  it('does not crash on empty input', () => {
    const { container } = render(
      <CodeGraphCanvas nodes={[]} links={[]} selectedId={null} onSelect={() => undefined} />,
    );
    expect(container.querySelectorAll('.cgc-node')).toHaveLength(0);
    expect(container.querySelectorAll('.cgc-edge')).toHaveLength(0);
    // HUD still reports zero nodes.
    expect(container.querySelector('.canvas-hud')).toBeTruthy();
  });
});

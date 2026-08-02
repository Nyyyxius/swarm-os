import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CodeGraphPage } from './CodeGraphPage';
import { computeNeighbors, parseLine, nodeFileLabel } from '../hooks/useCodeGraph';
import type { CodegraphGraph } from '../api/client';

// The page reads `graphRev` from SwarmController — stub it out.
vi.mock('../controller/SwarmController', () => ({
  useSwarmController: () => ({ graphRev: 0 }),
}));

// Stub the api to avoid real fetch calls.
vi.mock('../api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../api/client')>();
  return {
    ...mod,
    api: {
      ...mod.api,
      listCodegraphScopes: vi.fn().mockResolvedValue({ scopes: [] }),
      getCodegraphGraph: vi.fn().mockRejectedValue(new Error('no graph')),
      searchCodegraph: vi.fn().mockResolvedValue({ ok: true, scope: 's', results: [] }),
    },
  };
});

// --- unit helpers ---

describe('parseLine', () => {
  it('parses "L3" → 3', () => expect(parseLine('L3')).toBe(3));
  it('parses "L10-L20" → 10', () => expect(parseLine('L10-L20')).toBe(10));
  it('returns null for null', () => expect(parseLine(null)).toBeNull());
  it('returns null for empty string', () => expect(parseLine('')).toBeNull());
  it('returns null for non-numeric', () => expect(parseLine('line')).toBeNull());
});

describe('nodeFileLabel', () => {
  it('returns "file:line" when both present', () => {
    expect(nodeFileLabel({ id: 'x', source_file: 'src/foo.ts', source_location: 'L5' })).toBe('src/foo.ts:5');
  });
  it('returns just file when no line', () => {
    expect(nodeFileLabel({ id: 'x', source_file: 'src/bar.ts' })).toBe('src/bar.ts');
  });
  it('returns empty string when no file', () => {
    expect(nodeFileLabel({ id: 'x' })).toBe('');
  });
});

describe('computeNeighbors', () => {
  const graph: CodegraphGraph = {
    nodes: [
      { id: 'a', label: 'A()' },
      { id: 'b', label: 'B()' },
      { id: 'c', label: 'C()' },
    ],
    links: [
      { source: 'a', target: 'b', relation: 'calls' },
      { source: 'c', target: 'a', relation: 'imports_from' },
    ],
  };

  it('returns outgoing links for node a', () => {
    const { outgoing, incoming } = computeNeighbors('a', graph);
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]!.node.id).toBe('b');
    expect(outgoing[0]!.relation).toBe('calls');
    expect(incoming).toHaveLength(1);
    expect(incoming[0]!.node.id).toBe('c');
    expect(incoming[0]!.relation).toBe('imports_from');
  });

  it('returns empty arrays for an isolated node', () => {
    const { outgoing, incoming } = computeNeighbors('b', graph);
    expect(outgoing).toHaveLength(0);
    // b is a target of a → but b appears in links as the target of a→b
    // So incoming for b should be a:
    expect(incoming).toHaveLength(1);
    expect(incoming[0]!.node.id).toBe('a');
  });

  it('handles a node that does not appear in any link', () => {
    const graph2: CodegraphGraph = {
      nodes: [{ id: 'x' }],
      links: [],
    };
    const { outgoing, incoming } = computeNeighbors('x', graph2);
    expect(outgoing).toHaveLength(0);
    expect(incoming).toHaveLength(0);
  });
});

// --- component render-gating tests ---

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response('{"scopes":[]}', { status: 200, headers: { 'content-type': 'application/json' } }),
  ) as typeof fetch;
  window.localStorage.setItem('swarm-os.token', 'test-token');
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe('CodeGraphPage render gating', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(
      <CodeGraphPage open={false} onClose={() => undefined} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the overlay when open=true', () => {
    render(<CodeGraphPage open onClose={() => undefined} />);
    expect(screen.getByText('CODE GRAPH')).toBeTruthy();
  });

  it('shows close button when open=true', () => {
    render(<CodeGraphPage open onClose={() => undefined} />);
    expect(screen.getByText('✕ CLOSE')).toBeTruthy();
  });

  it('calls onClose when the close button is clicked', async () => {
    const onClose = vi.fn();
    render(<CodeGraphPage open onClose={onClose} />);
    screen.getByText('✕ CLOSE').click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

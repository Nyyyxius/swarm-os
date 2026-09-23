import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  stripFeatureSections,
  lintStaleFeatureMentions,
  buildPreamble,
} from './preamble.js';
import type { FeatureName } from '../features/registry.js';

const IDENTITY = {
  name: 'merge-team-lead',
  role: 'coordinator',
  sessionId: 'sess-1',
  orchName: 'merge-team',
};

const ALL_ON: Record<FeatureName, boolean> = {
  ide: true,
  codegraph: true,
  board: true,
  memory: true,
  monitoring: true,
  approvals: true,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stripFeatureSections', () => {
  it('is a no-op on text without markers (the Lot 1 state)', () => {
    const text = 'You have memory.search and board.create tools.';
    expect(stripFeatureSections(text, ALL_ON)).toBe(text);
    expect(stripFeatureSections(text, { ...ALL_ON, memory: false })).toBe(text);
  });

  it('removes the whole block (markers + content) for an OFF feature', () => {
    const text = [
      'intro',
      '<!--feature:memory-->',
      'memory section body',
      '<!--/feature:memory-->',
      'outro',
    ].join('\n');
    const out = stripFeatureSections(text, { ...ALL_ON, memory: false });
    expect(out).not.toContain('memory section body');
    expect(out).not.toContain('<!--feature:memory-->');
    expect(out).toContain('intro');
    expect(out).toContain('outro');
  });

  it('removes only the markers for an ON feature, keeping the content', () => {
    const text = 'a<!--feature:board-->KEEP<!--/feature:board-->b';
    const out = stripFeatureSections(text, ALL_ON);
    expect(out).toBe('aKEEPb');
  });

  it('strips one feature while keeping another', () => {
    const text =
      '<!--feature:memory-->M<!--/feature:memory--><!--feature:board-->B<!--/feature:board-->';
    const out = stripFeatureSections(text, { ...ALL_ON, memory: false });
    expect(out).not.toContain('M');
    expect(out).toContain('B');
  });
});

describe('buildPreamble — codegraph section markers (Lot 4)', () => {
  for (const isLead of [true, false]) {
    const kind = isLead ? 'lead' : 'worker';

    it(`keeps the Code graph section when codegraph is ON (${kind})`, () => {
      const out = buildPreamble({ identity: IDENTITY, isLead, features: ALL_ON });
      expect(out).toContain('Code graph (Graphify)');
      expect(out).toContain('codegraph.search');
      // Markers themselves are always consumed, never leaked to the agent.
      expect(out).not.toContain('<!--feature:codegraph-->');
      expect(out).not.toContain('<!--/feature:codegraph-->');
    });

    it(`strips the Code graph section when codegraph is OFF (${kind})`, () => {
      const out = buildPreamble({
        identity: IDENTITY,
        isLead,
        features: { ...ALL_ON, codegraph: false },
      });
      expect(out).not.toContain('Code graph (Graphify)');
      expect(out).not.toContain('codegraph.search');
      expect(out).not.toContain('<!--feature:codegraph-->');
      // A sibling section (mailbox) survives — only codegraph was removed.
      expect(out.toLowerCase()).toContain('mailbox');
    });
  }

  it('leaves the section in place when no snapshot is wired (fail open)', () => {
    const out = buildPreamble({ identity: IDENTITY, isLead: true });
    expect(out).toContain('Code graph (Graphify)');
    // Without a snapshot the markers are not even stripped (pure Lot 1 no-op).
    expect(out).toContain('<!--feature:codegraph-->');
  });
});

describe('buildPreamble — board section markers (Lot 5)', () => {
  for (const isLead of [true, false]) {
    const kind = isLead ? 'lead' : 'worker';

    it(`keeps the Task board section when board is ON (${kind})`, () => {
      const out = buildPreamble({ identity: IDENTITY, isLead, features: ALL_ON });
      expect(out).toContain('Task board (Kanban)');
      expect(out).toContain('board.create');
      // Markers themselves are always consumed, never leaked to the agent.
      expect(out).not.toContain('<!--feature:board-->');
      expect(out).not.toContain('<!--/feature:board-->');
    });

    it(`strips the Task board section when board is OFF (${kind})`, () => {
      const out = buildPreamble({
        identity: IDENTITY,
        isLead,
        features: { ...ALL_ON, board: false },
      });
      expect(out).not.toContain('Task board (Kanban)');
      expect(out).not.toContain('board.create');
      expect(out).not.toContain('<!--feature:board-->');
      // Sibling sections survive — only board was removed.
      expect(out).toContain('Code graph (Graphify)');
      expect(out.toLowerCase()).toContain('mailbox');
    });
  }
});

describe('buildPreamble — memory section markers (Lot 6)', () => {
  for (const isLead of [true, false]) {
    const kind = isLead ? 'lead' : 'worker';

    it(`keeps the Shared memory section when memory is ON (${kind})`, () => {
      const out = buildPreamble({ identity: IDENTITY, isLead, features: ALL_ON });
      expect(out).toContain('Shared memory (knowledge graph)');
      expect(out).toContain('memory.search');
      // Markers themselves are always consumed, never leaked to the agent.
      expect(out).not.toContain('<!--feature:memory-->');
      expect(out).not.toContain('<!--/feature:memory-->');
    });

    it(`strips the Shared memory section when memory is OFF (${kind})`, () => {
      const out = buildPreamble({
        identity: IDENTITY,
        isLead,
        features: { ...ALL_ON, memory: false },
      });
      expect(out).not.toContain('Shared memory (knowledge graph)');
      expect(out).not.toContain('memory.search');
      expect(out).not.toContain('<!--feature:memory-->');
      // Sibling sections survive — only memory was removed.
      expect(out).toContain('Task board (Kanban)');
      expect(out).toContain('Code graph (Graphify)');
    });
  }
});

describe('lintStaleFeatureMentions', () => {
  it('logs preamble.stale_feature_mention for a disabled feature still cited', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    lintStaleFeatureMentions('please call memory.search first', {
      ...ALL_ON,
      memory: false,
    });
    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(logged).toContain('preamble.stale_feature_mention');
    expect(logged).toContain('memory');
  });

  it('logs nothing when everything is enabled (the Lot 1 state)', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    lintStaleFeatureMentions('memory.search board.create codegraph.list', ALL_ON);
    const logged = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(logged).not.toContain('preamble.stale_feature_mention');
  });
});

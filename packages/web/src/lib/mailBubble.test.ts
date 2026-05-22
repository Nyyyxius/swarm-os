// S12 — Unit tests for `classifyBubble`.
//
// Table-driven coverage of the four `BubbleKind` buckets plus the priority
// edge cases listed in `docs/update_system/12_mapping_from.md` §5.

import { describe, it, expect } from 'vitest';
import type { MailMessageView } from '../api/client';
import { classifyBubble, SYSTEM_FROM_VALUES, type BubbleClassification } from './mailBubble';

function mail(partial: Partial<MailMessageView> & { from: string }): MailMessageView {
  return {
    id: 'mail_test',
    content: 'hello',
    ts: '2026-05-22T12:00:00.000Z',
    ...partial,
  };
}

interface Row {
  name: string;
  msg: MailMessageView;
  currentSessionId: string;
  expected: BubbleClassification;
}

const CASES: Row[] = [
  {
    name: "from='human' → me / YOU",
    msg: mail({ from: 'human' }),
    currentSessionId: 'sess_self',
    expected: { kind: 'me', authorLabel: 'YOU' },
  },
  {
    name: "from='system' → system / SYSTEM",
    msg: mail({ from: 'system' }),
    currentSessionId: 'sess_self',
    expected: { kind: 'system', authorLabel: 'SYSTEM' },
  },
  {
    name: "from='sess_peer' (no fromOrchestratorId) → them / short-id",
    msg: mail({ from: 'sess_abc12345' }),
    currentSessionId: 'sess_self',
    expected: { kind: 'them', authorLabel: 'abc1' },
  },
  {
    name: 'cross-team with full enrichment → other-team / "Atlas / lead-1"',
    msg: mail({
      from: 'sess_lead_atlas',
      fromOrchestratorId: 'orch_atlas',
      fromOrchestratorName: 'Atlas',
      fromSessionName: 'lead-1',
    }),
    currentSessionId: 'sess_self',
    expected: {
      kind: 'other-team',
      authorLabel: 'Atlas / lead-1',
      fromTeam: { id: 'orch_atlas', name: 'Atlas', sessionName: 'lead-1' },
    },
  },
  {
    name: 'cross-team but fromSessionName missing → fallback on from',
    msg: mail({
      from: 'sess_lead_xyz',
      fromOrchestratorId: 'orch_xyz',
      fromOrchestratorName: 'Xyz',
    }),
    currentSessionId: 'sess_self',
    expected: {
      kind: 'other-team',
      authorLabel: 'Xyz / sess_lead_xyz',
      fromTeam: { id: 'orch_xyz', name: 'Xyz', sessionName: 'sess_lead_xyz' },
    },
  },
  {
    name: "priority: from='human' wins even if fromOrchestratorId is set (defensive)",
    msg: mail({
      from: 'human',
      fromOrchestratorId: 'orch_should_be_ignored',
      fromOrchestratorName: 'Ignored',
      fromSessionName: 'noop',
    }),
    currentSessionId: 'sess_self',
    expected: { kind: 'me', authorLabel: 'YOU' },
  },
  {
    name: 'degenerate self-loop (from === currentSessionId) → them by default',
    msg: mail({ from: 'sess_self_5678' }),
    currentSessionId: 'sess_self_5678',
    expected: { kind: 'them', authorLabel: 'self' },
  },
];

describe('classifyBubble', () => {
  for (const row of CASES) {
    it(row.name, () => {
      const got = classifyBubble(row.msg, row.currentSessionId);
      expect(got).toEqual(row.expected);
    });
  }

  it('SYSTEM_FROM_VALUES contains at least "system"', () => {
    expect(SYSTEM_FROM_VALUES.has('system')).toBe(true);
  });

  it('purity: classifyBubble does not mutate its input', () => {
    const msg = mail({
      from: 'sess_lead_atlas',
      fromOrchestratorId: 'orch_atlas',
      fromOrchestratorName: 'Atlas',
      fromSessionName: 'lead-1',
    });
    const snapshot = JSON.parse(JSON.stringify(msg));
    classifyBubble(msg, 'sess_self');
    expect(msg).toEqual(snapshot);
  });
});

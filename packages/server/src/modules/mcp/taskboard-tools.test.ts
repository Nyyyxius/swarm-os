import { describe, it, expect } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext } from './tools.js';
import { requireLead } from './tools.js';
import { isLeadSession, requireLeadOrAssignee } from './taskboard-tools.js';

/**
 * Unit coverage for the board.* permission model (docs/tableau-de-taches.md §5):
 *   - update/move/close/reopen: lead OR assignee (`requireLeadOrAssignee`)
 *   - assign/delete/cross-team: lead only (`requireLead`)
 * The tool handlers are thin wrappers around these gates + the store (covered in
 * taskboard/store.test.ts), so exercising the gates directly is the honest unit.
 */

const ORCH = 'orch-a';
const LEAD = 'sess-lead';
const WORKER = 'sess-worker';
const OTHER = 'sess-other';

/** Minimal ToolContext carrying only what the permission gates read. */
function makeCtx(sessionId: string): ToolContext {
  return {
    orchestrator: { id: ORCH, leadSessionId: LEAD },
    session: { id: sessionId },
  } as unknown as ToolContext;
}

const cardAssignedToWorker = { orchestratorId: ORCH, assigneeSessionId: WORKER };
const cardUnassigned = { orchestratorId: ORCH, assigneeSessionId: null };
const cardOtherTeam = { orchestratorId: 'orch-b', assigneeSessionId: WORKER };

describe('isLeadSession', () => {
  it('is true only for the orchestrator lead', () => {
    expect(isLeadSession(makeCtx(LEAD))).toBe(true);
    expect(isLeadSession(makeCtx(WORKER))).toBe(false);
  });
});

describe('requireLeadOrAssignee (update/move/close/reopen)', () => {
  it('allows the lead', () => {
    expect(() => requireLeadOrAssignee(makeCtx(LEAD), cardAssignedToWorker, 'board.update')).not.toThrow();
  });

  it('allows the assignee', () => {
    expect(() =>
      requireLeadOrAssignee(makeCtx(WORKER), cardAssignedToWorker, 'board.move'),
    ).not.toThrow();
  });

  it('refuses a non-assignee worker', () => {
    let thrown: unknown;
    try {
      requireLeadOrAssignee(makeCtx(OTHER), cardAssignedToWorker, 'board.update');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).message).toMatch(/PERMISSION_DENIED/);
  });

  it('refuses any non-lead on an unassigned card', () => {
    expect(() => requireLeadOrAssignee(makeCtx(WORKER), cardUnassigned, 'board.move')).toThrow(
      /PERMISSION_DENIED/,
    );
    // ...but the lead may still act on it.
    expect(() => requireLeadOrAssignee(makeCtx(LEAD), cardUnassigned, 'board.move')).not.toThrow();
  });

  it('refuses acting on another team\'s card even for the assignee', () => {
    expect(() =>
      requireLeadOrAssignee(makeCtx(WORKER), cardOtherTeam, 'board.update'),
    ).toThrow(/PERMISSION_DENIED/);
  });
});

describe('requireLead (assign/delete/cross-team)', () => {
  it('allows the lead and refuses a worker', () => {
    expect(() => requireLead(makeCtx(LEAD), 'board.delete')).not.toThrow();
    let thrown: unknown;
    try {
      requireLead(makeCtx(WORKER), 'board.delete');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).message).toMatch(/PERMISSION_DENIED/);
  });
});

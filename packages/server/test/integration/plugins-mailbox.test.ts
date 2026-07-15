/**
 * J2 fix B-1 — a pending mailbox message from a plugin (`from='plugin:<name>'`)
 * must SURVIVE a reboot's mailbox rehydrate, not be silently destroyed as a
 * "sender-terminal" message (a plugin has no session row).
 *
 * A control message from an unknown session id proves the exemption is specific
 * to the `plugin:` prefix: the ghost is dropped, the plugin message survives.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootTestStack, type TestStack } from './helpers.js';
import { rehydrateMailbox } from '../../src/modules/orchestrator/mailbox-persistence.js';
import type { MailboxMessageRow } from '../../src/modules/db/index.js';

let stack: TestStack;

beforeEach(async () => {
  stack = await bootTestStack({ skipMcp: true, skipMainHttp: true });
});

afterEach(async () => {
  await stack.teardown();
});

function createOrch(name: string) {
  const { orchestrator, lead } = stack.spawner.create(
    {
      name,
      role: 'coordinator',
      defaultModel: stack.config.defaultModel,
      defaultEffort: stack.config.defaultEffort,
      defaultPermissionMode: stack.config.defaultPermissionMode,
      leadPreamble: null,
      workerPreamble: null,
      lead: { cwd: stack.workspaceRoot, prompt: 'noop', preamble: null },
    },
    { skipSpawn: true },
  );
  return { orchId: orchestrator.id, leadId: lead.id };
}

function msgRow(over: Partial<MailboxMessageRow>): MailboxMessageRow {
  return {
    id: 'm-x',
    orchestrator_id: 'o',
    to_session_id: 's',
    from_id: 'plugin:demo',
    content: 'hello from plugin',
    ts: new Date().toISOString(),
    from_orchestrator_id: null,
    from_orchestrator_name: null,
    from_session_name: null,
    delivered_at: null,
    source_kind: null,
    source_message_id: null,
    thread_id: null,
    thread_name: null,
    ...over,
  };
}

describe('J2 mailbox rehydrate — plugin: sender exemption', () => {
  it('keeps a pending plugin message and drops an unknown-sender control', () => {
    const { orchId, leadId } = createOrch('team-p');

    // Pending message FROM a plugin, TO the (live) lead.
    stack.db.insertMailboxMessage(
      msgRow({ id: 'plug-1', orchestrator_id: orchId, to_session_id: leadId, from_id: 'plugin:demo' }),
    );
    // Control: pending message from a ghost session id (unknown → terminal).
    stack.db.insertMailboxMessage(
      msgRow({
        id: 'ghost-1',
        orchestrator_id: orchId,
        to_session_id: leadId,
        from_id: 'ghost-session-id',
        content: 'from a ghost',
      }),
    );

    const result = rehydrateMailbox(stack.spawner, stack.db);

    expect(result.rehydrated).toBe(1);
    expect(result.droppedSenderTerminal).toBe(1);

    const orch = stack.spawner.get(orchId);
    const inbox = orch?.mailbox.peek(leadId) ?? [];
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.from).toBe('plugin:demo');
    expect(inbox[0]?.content).toBe('hello from plugin');
  });
});

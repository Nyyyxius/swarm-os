// Unit tests for the tool-list fields of a role (`lib/toolList.ts`).
//
// The risk is the same as with the other nullable role fields: two states
// (`null` = all tools, non-empty array = the override) must never collapse,
// and the server's 400 on `[]` must be unreachable from the form.

import { describe, it, expect } from 'vitest';
import {
  hasToolRestrictions,
  parseToolList,
  toolListFieldValue,
  toolListSummary,
} from './toolList';

describe('parseToolList', () => {
  it('reads an empty or blank field as null (all tools), never []', () => {
    expect(parseToolList('')).toBeNull();
    expect(parseToolList('   ')).toBeNull();
    expect(parseToolList('\n , \n,,')).toBeNull();
  });

  it('splits on new lines', () => {
    expect(parseToolList('Bash\nRead\nEdit')).toEqual(['Bash', 'Read', 'Edit']);
  });

  it('splits on commas', () => {
    expect(parseToolList('Bash,Read, Edit')).toEqual(['Bash', 'Read', 'Edit']);
  });

  it('mixes both separators, trims, drops blanks (CRLF included)', () => {
    expect(parseToolList('  Bash , Read\r\n\n  Edit,\n, Write  ')).toEqual([
      'Bash',
      'Read',
      'Edit',
      'Write',
    ]);
  });

  it('removes duplicates, keeping the first occurrence and the order', () => {
    expect(parseToolList('Read\nBash, Read\nBash\nEdit')).toEqual(['Read', 'Bash', 'Edit']);
  });

  it('is case-sensitive: tool names are', () => {
    expect(parseToolList('Bash\nbash')).toEqual(['Bash', 'bash']);
  });

  it('keeps dotted team-comms names intact', () => {
    expect(parseToolList('team.send_message, memory.search\ndiscord-agent.reply')).toEqual([
      'team.send_message',
      'memory.search',
      'discord-agent.reply',
    ]);
  });

  it('does not split on inner spaces', () => {
    expect(parseToolList('Bash(git log:*)')).toEqual(['Bash(git log:*)']);
  });
});

describe('toolListFieldValue', () => {
  it('renders one name per line', () => {
    expect(toolListFieldValue(['Bash', 'Read'])).toBe('Bash\nRead');
  });

  it('renders null, absent and [] as an empty field (all tools)', () => {
    expect(toolListFieldValue(null)).toBe('');
    expect(toolListFieldValue(undefined)).toBe('');
    expect(toolListFieldValue([])).toBe('');
  });

  it('round-trips through parseToolList', () => {
    const list = ['team.send_message', 'memory.search', 'board.list'];
    expect(parseToolList(toolListFieldValue(list))).toEqual(list);
    expect(parseToolList(toolListFieldValue(null))).toBeNull();
  });
});

describe('toolListSummary', () => {
  it('says "Tous" when there is no override', () => {
    expect(toolListSummary(null)).toBe('Tous');
    expect(toolListSummary(undefined)).toBe('Tous');
  });

  it('lists the names otherwise', () => {
    expect(toolListSummary(['Bash', 'Read'])).toBe('Bash, Read');
  });
});

describe('hasToolRestrictions', () => {
  it('is false when every list is null or absent (server predating the feature)', () => {
    expect(hasToolRestrictions({})).toBe(false);
    expect(
      hasToolRestrictions({
        leadTools: null,
        workerTools: null,
        leadMcpTools: null,
        workerMcpTools: null,
      }),
    ).toBe(false);
  });

  it('is true as soon as one list is an override', () => {
    expect(hasToolRestrictions({ leadTools: ['Bash'] })).toBe(true);
    expect(hasToolRestrictions({ workerTools: ['Read'] })).toBe(true);
    expect(hasToolRestrictions({ leadMcpTools: ['team.send_message'] })).toBe(true);
    expect(hasToolRestrictions({ workerMcpTools: ['memory.search'] })).toBe(true);
  });
});

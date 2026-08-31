/**
 * `buildHookCommand` — the hook URL contract.
 *
 * The quoting of the command itself is pinned byte-for-byte in
 * `claude.test.ts` / `gemini.test.ts` / `codex.test.ts`; here we pin the URL
 * selection logic added for the ssh transport (docs/monitoring-agents.md):
 * the hook curl runs on the AGENT'S host, so `config.hookUrl` must be able to
 * redirect it away from the container-internal loopback port.
 */
import { describe, expect, it } from 'vitest';

import { buildHookCommand, buildNotificationHookCommand } from './session-config.js';

const BASE = {
  orchestratorId: 'orch-1',
  sessionId: 'sess-1',
  hookToken: 'tok-1',
  mainHttpPort: 8787,
};

describe('buildHookCommand — hook URL selection', () => {
  it('defaults to the container-internal loopback port (historical behaviour)', () => {
    const cmd = buildHookCommand({ ...BASE, kind: 'session.transcript' });
    expect(cmd).toContain("'http://127.0.0.1:8787/hooks/notification'");
  });

  it('uses hookUrl verbatim when set (ssh transport: host-mapped port)', () => {
    const cmd = buildHookCommand({
      ...BASE,
      kind: 'session.transcript',
      hookUrl: 'http://127.0.0.1:8789',
    });
    expect(cmd).toContain("'http://127.0.0.1:8789/hooks/notification'");
    expect(cmd).not.toContain('127.0.0.1:8787');
  });

  it('strips trailing slashes off hookUrl instead of doubling them', () => {
    const cmd = buildHookCommand({
      ...BASE,
      kind: 'session.waiting',
      hookUrl: 'http://127.0.0.1:8789//',
    });
    expect(cmd).toContain("'http://127.0.0.1:8789/hooks/notification'");
  });

  it('buildNotificationHookCommand honours hookUrl too (waiting hooks share the URL)', () => {
    const cmd = buildNotificationHookCommand({ ...BASE, hookUrl: 'http://127.0.0.1:8093' });
    expect(cmd).toContain("'http://127.0.0.1:8093/hooks/notification'");
  });
});

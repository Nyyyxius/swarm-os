import { describe, it, expect } from 'vitest';
import { buildPreamble } from './preamble.js';

/**
 * Phase 7 — preamble templating.
 *
 * The default Markdown lives next to the module — we don't reload it here,
 * we just verify the substitution + override concatenation behaviour.
 */

const ID = {
  name: 'merge-team-lead',
  role: 'coordinator',
  sessionId: 'sess-00001',
  orchName: 'merge-team',
};

describe('buildPreamble', () => {
  it('substitutes every placeholder for a lead', () => {
    const out = buildPreamble({ identity: ID, isLead: true });
    expect(out).toContain('merge-team-lead');
    expect(out).toContain('coordinator');
    expect(out).toContain('sess-00001');
    expect(out).toContain('merge-team');
    expect(out).not.toContain('{{');
  });

  it('lead and worker preambles are distinct', () => {
    const lead = buildPreamble({ identity: ID, isLead: true });
    const worker = buildPreamble({ identity: ID, isLead: false });
    expect(lead).not.toBe(worker);
    expect(lead.toLowerCase()).toContain('lead');
    // Worker preamble must NOT advertise spawn_worker as available — that's
    // lead-only per plan §10. We don't pin the exact phrasing, just look
    // for an explicit gate.
    expect(worker.toLowerCase()).toMatch(/lead-only|lead only|spawn_worker/);
  });

  it('appends the override after the default with a separator', () => {
    const out = buildPreamble({
      identity: ID,
      isLead: false,
      customOverride: 'Project specific: only touch the /workspace/example dir.',
    });
    expect(out).toContain('Project specific: only touch the /workspace/example dir.');
    expect(out).toContain('Project-specific instructions');
    // The default must still be present in front of the override.
    expect(out.indexOf('Project specific:')).toBeGreaterThan(100);
  });

  it('treats null/undefined/empty/whitespace override as no override', () => {
    const baseline = buildPreamble({ identity: ID, isLead: true });
    expect(buildPreamble({ identity: ID, isLead: true, customOverride: null })).toBe(baseline);
    expect(buildPreamble({ identity: ID, isLead: true, customOverride: '' })).toBe(baseline);
    expect(buildPreamble({ identity: ID, isLead: true, customOverride: '   ' })).toBe(baseline);
  });

  // NOTE: the resume notice is no longer folded into the preamble. It now
  // rides the positional prompt (durable preamble → `--append-system-prompt`,
  // one-shot notice → positional argv) so a `/clear` discards it instead of
  // re-surfacing a stale restart notice. See `buildClaudeArgs` tests.
});

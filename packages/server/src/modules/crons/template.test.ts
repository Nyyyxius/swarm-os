import { describe, it, expect } from 'vitest';
import { renderTemplate } from './template.js';

// A fire time with non-zero seconds/ms so we can prove {{fire}} truncates.
const FIRE = new Date('2026-06-18T20:37:45.123Z');

describe('renderTemplate', () => {
  it('{{fire}} truncates to the minute (compact ISO)', () => {
    expect(renderTemplate('{{fire}}', FIRE)).toBe('2026-06-18T20:37Z');
  });

  it('{{fire}} of an exact cron hour yields HH:00Z', () => {
    expect(renderTemplate('cycle_window_id={{fire}}', new Date('2026-06-18T20:00:00.000Z'))).toBe(
      'cycle_window_id=2026-06-18T20:00Z',
    );
  });

  it('{{now}} is the full ISO of the fire time', () => {
    expect(renderTemplate('{{now}}', FIRE)).toBe('2026-06-18T20:37:45.123Z');
  });

  it('{{window:6h}} floors to the 6-hour UTC grid', () => {
    // 20:37 → window [18:00, 24:00) → 18:00
    expect(renderTemplate('{{window:6h}}', FIRE)).toBe('2026-06-18T18:00Z');
  });

  it('{{window:30m}} floors to the 30-minute grid', () => {
    expect(renderTemplate('{{window:30m}}', FIRE)).toBe('2026-06-18T20:30Z');
  });

  it('is case-insensitive and tolerates inner whitespace', () => {
    expect(renderTemplate('{{ FIRE }}', FIRE)).toBe('2026-06-18T20:37Z');
  });

  it('leaves unknown / malformed tokens verbatim', () => {
    expect(renderTemplate('a {{bogus}} b {{window:0h}} c', FIRE)).toBe(
      'a {{bogus}} b {{window:0h}} c',
    );
  });

  it('renders a realistic run-cycle message', () => {
    const out = renderTemplate('run cycle cycle_window_id={{fire}}', new Date('2026-06-18T12:00:00Z'));
    expect(out).toBe('run cycle cycle_window_id=2026-06-18T12:00Z');
  });
});

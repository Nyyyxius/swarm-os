/**
 * Monitoring Lot 10 — the `SystemGauge` cell.
 *
 * The component is thin on purpose (geometry and formatting live in
 * `lib/systemGauge.ts` and are tested there), so what is left to assert is
 * the part a refactor could quietly break: which elements EXIST for a given
 * reading, and which one is allowed to carry colour.
 */
import { describe, it, expect } from 'vitest';
import type { ComponentProps } from 'react';
import { render } from '@testing-library/react';
import SystemGauge from './SystemGauge';

const renderGauge = (over: Partial<ComponentProps<typeof SystemGauge>> = {}) =>
  render(
    <SystemGauge
      label="CPU"
      pct={0.35}
      sub="1.4 / 4.0 CORES"
      basis="cgroup"
      {...over}
    />,
  );

describe('SystemGauge', () => {
  it('draws the track, the value arc and the percentage for a live reading', () => {
    const { container } = renderGauge();
    expect(container.querySelector('.mon-gauge-track')).toBeTruthy();
    const value = container.querySelector('.mon-gauge-value');
    expect(value).toBeTruthy();
    expect(container.querySelector('.mon-gauge-pct')?.textContent).toBe('35%');
    expect(container.querySelector('.mon-gauge-sub')?.textContent).toBe('1.4 / 4.0 CORES');
  });

  it('renders the track ALONE under an em-dash when there is no reading', () => {
    // The one property that matters most here: an unreadable gauge and an
    // idle container must never look the same.
    const { container } = renderGauge({ pct: null });
    expect(container.querySelector('.mon-gauge-track')).toBeTruthy();
    expect(container.querySelector('.mon-gauge-value')).toBeNull();
    expect(container.querySelector('.mon-gauge-pct')?.textContent).toBe('—');
  });

  it('says NO CGROUP DATA rather than leaving the sub-line blank', () => {
    const { container } = renderGauge({ pct: null, sub: null, basis: null });
    expect(container.querySelector('.mon-gauge-sub')?.textContent).toBe('NO CGROUP DATA');
  });

  it('tags HOST BASIS only when the denominator is the whole box', () => {
    const host = renderGauge({ basis: 'host' });
    expect(host.container.querySelector('.mon-gauge-basis')?.textContent).toBe('HOST BASIS');

    const cgroup = renderGauge({ basis: 'cgroup' });
    expect(cgroup.container.querySelector('.mon-gauge-basis')).toBeNull();

    const unknown = renderGauge({ basis: null });
    expect(unknown.container.querySelector('.mon-gauge-basis')).toBeNull();
  });

  it('lets the ARC carry status colour and leaves the sub-line in tokens', () => {
    const { container } = renderGauge({ pct: 0.95, label: 'MEMORY', sub: '7.6G / 8.0G' });
    const value = container.querySelector('.mon-gauge-value') as SVGPathElement;
    expect(value.getAttribute('stroke')).toBe('var(--bad)');
    // The percentage joins it past `warn`…
    expect(container.querySelector('.mon-gauge-pct')?.getAttribute('fill')).toBe('var(--bad)');
    // …but the absolute reading never does.
    const sub = container.querySelector('.mon-gauge-sub') as HTMLElement;
    expect(sub.getAttribute('style')).toBeNull();
  });

  it('keeps the percentage in the plain text token while ok', () => {
    const { container } = renderGauge({ pct: 0.2 });
    expect(container.querySelector('.mon-gauge-value')?.getAttribute('stroke'))
      .toBe('var(--ok)');
    expect(container.querySelector('.mon-gauge-pct')?.getAttribute('fill'))
      .toBe('var(--text)');
  });

  it('fills the arc proportionally — 50 % points straight up', () => {
    const { container } = renderGauge({ pct: 0.5 });
    const dash = container.querySelector('.mon-gauge-value')
      ?.getAttribute('stroke-dasharray') ?? '';
    // `= NaN` is what a missing half would yield anyway (`Number(undefined)`):
    // a malformed dasharray fails the ratio below instead of the destructuring.
    const [drawn = NaN, gap = NaN] = dash.split(' ').map(Number);
    expect(drawn / gap).toBeCloseTo(0.5, 4);
  });

  it('announces the whole cell as one reading to a screen reader', () => {
    const { container } = renderGauge();
    const cell = container.querySelector('.mon-gauge') as HTMLElement;
    expect(cell.getAttribute('role')).toBe('img');
    expect(cell.getAttribute('aria-label')).toBe('CPU 35%, 1.4 / 4.0 CORES');
  });

  it('says "unavailable" rather than reading a dash aloud', () => {
    const { container } = renderGauge({ pct: null, sub: null });
    const cell = container.querySelector('.mon-gauge') as HTMLElement;
    expect(cell.getAttribute('aria-label')).toBe('CPU unavailable');
  });
});

// packages/web/src/hooks/useElementBox.ts
//
// Shared by the monitoring charts (CONTEXT HISTORY band, API CALLS strip,
// CALL USAGE panel) — moved out of `ContextHistoryBand.tsx` unchanged.

import { useLayoutEffect, useState, type RefObject } from 'react';

/** Fallback plot box, used until (and where) the DOM can be measured. */
const FALLBACK_W = 880;
const FALLBACK_H = 220;

/**
 * Measured pixel box of the plot container, so the SVG user space is 1:1
 * with CSS pixels.
 *
 * The alternative — a fixed `viewBox` with `preserveAspectRatio="none"`, as
 * `Sparkline` uses — stretches text and dashes by whatever the container
 * width happens to be, which is fine for a 100×16 glyph and unacceptable for
 * a plot carrying eight labels. 1:1 also means the HTML tooltip can be
 * positioned with the same X the SVG crosshair uses.
 *
 * Falls back to a sane box when the element cannot be measured (jsdom, and
 * the first paint before layout), so the chart is never geometry-less.
 */
export function useElementBox(
  ref: RefObject<HTMLElement | null>,
  fallback: { w: number; h: number } = { w: FALLBACK_W, h: FALLBACK_H },
) {
  const [box, setBox] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setBox((prev) => (
          Math.abs(prev.w - r.width) < 0.5 && Math.abs(prev.h - r.height) < 0.5
            ? prev
            : { w: r.width, h: r.height }
        ));
      }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      // jsdom and very old browsers: a window listener still catches the
      // panel/viewport resizes that matter.
      globalThis.addEventListener('resize', measure);
      return () => globalThis.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return box;
}

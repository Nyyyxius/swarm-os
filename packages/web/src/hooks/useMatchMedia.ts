import { useEffect, useState } from 'react';

/**
 * Subscribe to a CSS media query. The initial value is read synchronously
 * at first render (lazy `useState` initializer) so there is NO flash of the
 * wrong layout on boot — the first paint already reflects `matches`.
 *
 * Guarded for non-DOM environments (tests / SSR) where `matchMedia` is
 * absent: returns `false` and never subscribes.
 */
export function useMatchMedia(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

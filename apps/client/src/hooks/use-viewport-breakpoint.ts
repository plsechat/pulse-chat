import { useEffect, useState } from 'react';

/**
 * Returns true when the viewport is at least `minWidth` pixels wide.
 * Used to detect when responsive layouts that fix-position sidebars
 * (e.g. the members panel below the `lg:` breakpoint) have collapsed
 * out of normal flow, so toggle buttons can reflect the unavailable
 * state instead of pretending nothing changed.
 *
 * Tailwind v4 default `lg` is 1024px; pass that explicitly so the
 * hook stays decoupled from the tailwind config.
 */
export const useViewportAtLeast = (minWidth: number) => {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.innerWidth >= minWidth
  );

  useEffect(() => {
    const mql = window.matchMedia(`(min-width: ${minWidth}px)`);
    const handleChange = (e: MediaQueryListEvent) => {
      setMatches(e.matches);
    };
    setMatches(mql.matches);
    mql.addEventListener('change', handleChange);
    return () => mql.removeEventListener('change', handleChange);
  }, [minWidth]);

  return matches;
};

import { useEffect, useState } from 'react';

/** Tailwind `md`. Below it the app runs the phone shell: drawers, the
 *  mobile header and bottom nav, full-screen thread panel. */
const MOBILE_BREAKPOINT = 768;

const matches = (query: string): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia(query).matches;

const useMediaQuery = (query: string): boolean => {
  const [value, setValue] = useState(() => matches(query));

  useEffect(() => {
    const mql = window.matchMedia(query);
    const handleChange = (e: MediaQueryListEvent) => setValue(e.matches);
    setValue(mql.matches);
    mql.addEventListener('change', handleChange);
    return () => mql.removeEventListener('change', handleChange);
  }, [query]);

  return value;
};

const useIsMobile = () =>
  useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);

/**
 * The primary input is a finger (phones, tablets): no hover, imprecise
 * taps, a soft keyboard. Capability, not width — a touch laptop in a
 * wide window still has a mouse as its primary pointer.
 */
const isCoarsePointer = () => matches('(pointer: coarse)');

export { isCoarsePointer, useIsMobile };

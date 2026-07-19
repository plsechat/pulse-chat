import { useTheme } from '@/components/theme-provider';
import { ensureReadableColor } from '@/helpers/readable-color';
import { useMemo } from 'react';

/**
 * Role color adjusted (only when necessary) to stay readable against the
 * ACTIVE theme's surface. Subscribes to the theme so a switch re-resolves
 * the surface; reads the live --background token so new themes are covered
 * without a hardcoded light/dark list.
 *
 * Returns undefined for no color — callers fall back to default text tone.
 */
export function useReadableRoleColor(color?: string | null): string | undefined {
  const { theme } = useTheme();

  return useMemo(() => {
    if (!color) return undefined;
    const surface = getComputedStyle(document.documentElement)
      .getPropertyValue('--background')
      .trim();
    return ensureReadableColor(color, surface);
    // theme is the re-resolution trigger, not a direct input
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [color, theme]);
}

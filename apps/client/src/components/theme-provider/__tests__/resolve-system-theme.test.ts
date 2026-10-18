/**
 * Run via: bun test apps/client/src/components/theme-provider/__tests__/resolve-system-theme.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { resolveSystemTheme } from '..';

describe('resolveSystemTheme', () => {
  test('follows the OS preference', () => {
    expect(resolveSystemTheme(true)).toBe('dark');
    expect(resolveSystemTheme(false)).toBe('light');
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import {
  getLocalStorageItemAsJSON,
  LocalStorageKey,
  setLocalStorageItemAsJSON
} from '@/helpers/storage';

afterEach(() => localStorage.removeItem(LocalStorageKey.APPEARANCE_SETTINGS));

describe('getLocalStorageItemAsJSON', () => {
  test('returns the default and clears the key when the value is corrupt', () => {
    localStorage.setItem(LocalStorageKey.APPEARANCE_SETTINGS, '{');
    expect(
      getLocalStorageItemAsJSON(LocalStorageKey.APPEARANCE_SETTINGS, { a: 1 })
    ).toEqual({ a: 1 });
    expect(localStorage.getItem(LocalStorageKey.APPEARANCE_SETTINGS)).toBeNull();
  });

  test('round-trips a valid value and defaults when absent', () => {
    expect(
      getLocalStorageItemAsJSON(LocalStorageKey.APPEARANCE_SETTINGS, 'dflt')
    ).toBe('dflt');
    setLocalStorageItemAsJSON(LocalStorageKey.APPEARANCE_SETTINGS, { b: [1, 2] });
    expect(getLocalStorageItemAsJSON(LocalStorageKey.APPEARANCE_SETTINGS)).toEqual(
      { b: [1, 2] }
    );
  });
});

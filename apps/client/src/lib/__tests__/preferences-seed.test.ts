/**
 * seedPreferencesFromLocalStorage — first-login push of the five
 * localStorage-held preferences to the server, defaults filling any
 * key that was never set locally.
 *
 * Run via: bun test apps/client/src/lib/__tests__/preferences-seed.test.ts
 */

import '../e2ee/__tests__/instance-dom-stubs';
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { DEFAULT_USER_PREFERENCES } from '@pulse/shared';
import { LocalStorageKey } from '@/helpers/storage';
import * as preferencesSync from '@/lib/preferences-sync';
import { seedPreferencesFromLocalStorage } from '../preferences-seed';

const KEYS = [
  LocalStorageKey.APPEARANCE_SETTINGS,
  LocalStorageKey.SOUND_NOTIFICATION_SETTINGS,
  LocalStorageKey.VITE_UI_THEME,
  LocalStorageKey.SERVER_CHANNEL_MAP,
  LocalStorageKey.RIGHT_SIDEBAR_STATE
];

const sync = spyOn(preferencesSync, 'syncPreference');
// Namespace spies are process-wide: a later test file that asserts on the
// REAL syncPreference (preference-store.test.ts) would see this stub.
afterAll(() => sync.mockRestore());

beforeEach(() => {
  sync.mockReset();
  sync.mockImplementation(() => undefined);
  for (const key of KEYS) localStorage.removeItem(key);
});

afterEach(() => {
  for (const key of KEYS) localStorage.removeItem(key);
});

describe('seedPreferencesFromLocalStorage', () => {
  test('with nothing stored, the server receives the defaults in one call', () => {
    seedPreferencesFromLocalStorage();

    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0][0]).toEqual(DEFAULT_USER_PREFERENCES);
  });

  test('stored values override the defaults key by key', () => {
    localStorage.setItem(
      LocalStorageKey.APPEARANCE_SETTINGS,
      JSON.stringify({ ...DEFAULT_USER_PREFERENCES.appearance, compactMode: true, fontScale: 120 })
    );
    localStorage.setItem(
      LocalStorageKey.SOUND_NOTIFICATION_SETTINGS,
      JSON.stringify({ ...DEFAULT_USER_PREFERENCES.soundNotification, masterVolume: 30 })
    );
    localStorage.setItem(LocalStorageKey.VITE_UI_THEME, 'nord');
    localStorage.setItem(LocalStorageKey.SERVER_CHANNEL_MAP, JSON.stringify({ 'srv-a': 12 }));
    localStorage.setItem(LocalStorageKey.RIGHT_SIDEBAR_STATE, 'true');

    seedPreferencesFromLocalStorage();

    expect(sync.mock.calls[0][0]).toEqual({
      appearance: { ...DEFAULT_USER_PREFERENCES.appearance, compactMode: true, fontScale: 120 },
      soundNotification: { ...DEFAULT_USER_PREFERENCES.soundNotification, masterVolume: 30 },
      theme: 'nord',
      serverChannelMap: { 'srv-a': 12 },
      rightSidebarOpen: true
    });
  });

  test('the sidebar flag is only true for the literal "true"', () => {
    localStorage.setItem(LocalStorageKey.RIGHT_SIDEBAR_STATE, 'false');
    seedPreferencesFromLocalStorage();
    expect(sync.mock.calls[0][0]).toMatchObject({ rightSidebarOpen: false });

    sync.mockClear();
    localStorage.setItem(LocalStorageKey.RIGHT_SIDEBAR_STATE, '1');
    seedPreferencesFromLocalStorage();
    expect(sync.mock.calls[0][0]).toMatchObject({ rightSidebarOpen: false });
  });

  test('a stored null for the channel map falls back to the default', () => {
    localStorage.setItem(LocalStorageKey.SERVER_CHANNEL_MAP, 'null');
    seedPreferencesFromLocalStorage();
    expect(sync.mock.calls[0][0]).toMatchObject({ serverChannelMap: {} });
  });
});

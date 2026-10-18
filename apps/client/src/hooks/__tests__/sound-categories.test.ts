/**
 * The incoming-call ring has its own category switch; it follows that
 * flag alone, and a settings object persisted before the flag existed
 * keeps ringing (absent = default on). The sent-message sound is the
 * opposite: opt-in, so absent = off, and the Messages category still
 * silences it when off.
 *
 * Run via:
 *   bun test apps/client/src/hooks/__tests__/sound-categories.test.ts
 */
import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { afterEach, describe, expect, test } from 'bun:test';
import { SoundType } from '@/features/server/types';
import { LocalStorageKey, setLocalStorageItemAsJSON } from '@/helpers/storage';
import {
  isCategoryEnabledForSound,
  isSoundEnabled,
  SOUND_CATEGORIES,
  SOUND_CATEGORY_SETTING_KEY,
  updateSoundNotificationSettings
} from '@/hooks/use-sound-notification-settings';
import { emitAppEvent } from '@/lib/events';

afterEach(() => {
  updateSoundNotificationSettings({
    callSoundsEnabled: true,
    voiceSoundsEnabled: true,
    actionSoundsEnabled: true,
    messageSoundsEnabled: true,
    messageSentSoundEnabled: false
  });
});

describe('calls category', () => {
  test('owns INCOMING_CALL and maps to callSoundsEnabled', () => {
    expect(SOUND_CATEGORIES.calls.types).toEqual([SoundType.INCOMING_CALL]);
    expect(SOUND_CATEGORY_SETTING_KEY.calls).toBe('callSoundsEnabled');
    // Every category has a flag — a new category without one would fall
    // back to "always on" silently.
    for (const category of Object.keys(SOUND_CATEGORIES)) {
      expect(
        SOUND_CATEGORY_SETTING_KEY[
          category as keyof typeof SOUND_CATEGORY_SETTING_KEY
        ]
      ).toBeDefined();
    }
  });

  test('the ring follows its own switch, not the voice one', () => {
    expect(isCategoryEnabledForSound(SoundType.INCOMING_CALL)).toBe(true);

    updateSoundNotificationSettings({ voiceSoundsEnabled: false });
    expect(isCategoryEnabledForSound(SoundType.INCOMING_CALL)).toBe(true);
    expect(
      isCategoryEnabledForSound(SoundType.REMOTE_USER_JOINED_VOICE_CHANNEL)
    ).toBe(false);

    updateSoundNotificationSettings({ callSoundsEnabled: false });
    expect(isCategoryEnabledForSound(SoundType.INCOMING_CALL)).toBe(false);
  });

  test('settings saved before the flag existed keep the ring on', () => {
    setLocalStorageItemAsJSON(LocalStorageKey.SOUND_NOTIFICATION_SETTINGS, {
      masterVolume: 100,
      messageSoundsEnabled: true,
      voiceSoundsEnabled: true,
      actionSoundsEnabled: false,
      desktopNotificationsEnabled: false,
      soundVariants: {}
    });
    // Drops the in-memory cache so the stored (older) shape is re-read.
    emitAppEvent('preferences-loaded');

    expect(isCategoryEnabledForSound(SoundType.INCOMING_CALL)).toBe(true);
    expect(isCategoryEnabledForSound(SoundType.OWN_USER_MUTED_MIC)).toBe(false);
  });
});

describe('sent-message sound', () => {
  test('off by default, on only when its switch is literally true', () => {
    expect(isSoundEnabled(SoundType.MESSAGE_SENT)).toBe(false);
    // The received sound in the same category plays as before.
    expect(isSoundEnabled(SoundType.MESSAGE_RECEIVED)).toBe(true);

    updateSoundNotificationSettings({ messageSentSoundEnabled: true });
    expect(isSoundEnabled(SoundType.MESSAGE_SENT)).toBe(true);
  });

  test('the Messages category switch overrides it', () => {
    updateSoundNotificationSettings({ messageSentSoundEnabled: true, messageSoundsEnabled: false });
    expect(isSoundEnabled(SoundType.MESSAGE_SENT)).toBe(false);
    expect(isSoundEnabled(SoundType.MESSAGE_RECEIVED)).toBe(false);
    // Other categories are untouched by either flag.
    expect(isSoundEnabled(SoundType.OWN_USER_MUTED_MIC)).toBe(true);
  });

  test('settings saved before the flag existed keep the sent sound off', () => {
    setLocalStorageItemAsJSON(LocalStorageKey.SOUND_NOTIFICATION_SETTINGS, {
      masterVolume: 100,
      messageSoundsEnabled: true,
      voiceSoundsEnabled: true,
      actionSoundsEnabled: true,
      desktopNotificationsEnabled: false,
      soundVariants: {}
    });
    emitAppEvent('preferences-loaded');

    expect(isSoundEnabled(SoundType.MESSAGE_SENT)).toBe(false);
    expect(isSoundEnabled(SoundType.MESSAGE_RECEIVED)).toBe(true);
  });
});

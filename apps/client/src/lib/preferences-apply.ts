import {
  LocalStorageKey,
  setLocalStorageItem,
  setLocalStorageItemAsJSON
} from '@/helpers/storage';
import { DEFAULT_USER_PREFERENCES, type TUserPreferences } from '@pulse/shared';
import {
  __testing as preferencesSync,
  flushPreferencesNow,
  getPendingPreferences,
  type TPendingPreferences
} from './preferences-sync';

/**
 * Overlay queued-but-unsent local changes on the server copy. A change
 * made while disconnected (or whose request failed) is still queued;
 * applying the server's older value on top of it would silently revert
 * what the user just chose, and the queued write would then put it back
 * a moment later — a visible flicker at best.
 */
export const mergePendingPreferences = (
  server: TUserPreferences,
  pending: TPendingPreferences
): TUserPreferences =>
  preferencesSync.deepMerge(
    server as unknown as Record<string, unknown>,
    pending as Record<string, unknown>
  ) as unknown as TUserPreferences;

/**
 * Write server preferences into localStorage so all existing
 * stores/hooks pick up the server's data immediately, then push any
 * queued local changes so the server catches up with what was applied.
 */
export const applyServerPreferences = (serverPrefs: TUserPreferences) => {
  const prefs = mergePendingPreferences(serverPrefs, getPendingPreferences());
  setLocalStorageItemAsJSON(
    LocalStorageKey.APPEARANCE_SETTINGS,
    prefs.appearance
  );
  setLocalStorageItemAsJSON(
    LocalStorageKey.SOUND_NOTIFICATION_SETTINGS,
    prefs.soundNotification
  );
  setLocalStorageItem(LocalStorageKey.VITE_UI_THEME, prefs.theme);
  setLocalStorageItemAsJSON(
    LocalStorageKey.SERVER_CHANNEL_MAP,
    prefs.serverChannelMap
  );
  setLocalStorageItem(
    LocalStorageKey.RIGHT_SIDEBAR_STATE,
    prefs.rightSidebarOpen ? 'true' : 'false'
  );
  // A server copy written before the preference existed has no
  // `presence`; the default (sharing off) fills it.
  setLocalStorageItemAsJSON(LocalStorageKey.PRESENCE_SETTINGS, {
    ...DEFAULT_USER_PREFERENCES.presence,
    ...prefs.presence
  });
  void flushPreferencesNow();
};

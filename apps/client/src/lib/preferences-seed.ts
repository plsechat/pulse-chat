import {
  getLocalStorageItem,
  getLocalStorageItemAsJSON,
  LocalStorageKey
} from '@/helpers/storage';
import {
  DEFAULT_USER_PREFERENCES,
  type TUserPreferences
} from '@pulse/shared';
import { syncPreference } from './preferences-sync';

/**
 * Read all 5 localStorage keys and push them to the server as the initial
 * preferences. Called only on first login (when server has no preferences).
 */
export const seedPreferencesFromLocalStorage = () => {
  const appearance = getLocalStorageItemAsJSON<
    TUserPreferences['appearance']
  >(LocalStorageKey.APPEARANCE_SETTINGS, DEFAULT_USER_PREFERENCES.appearance);

  const soundNotification = getLocalStorageItemAsJSON<
    TUserPreferences['soundNotification']
  >(
    LocalStorageKey.SOUND_NOTIFICATION_SETTINGS,
    DEFAULT_USER_PREFERENCES.soundNotification
  );

  const theme = (getLocalStorageItem(LocalStorageKey.VITE_UI_THEME) ??
    DEFAULT_USER_PREFERENCES.theme) as TUserPreferences['theme'];

  const serverChannelMap =
    getLocalStorageItemAsJSON<TUserPreferences['serverChannelMap']>(
      LocalStorageKey.SERVER_CHANNEL_MAP,
      DEFAULT_USER_PREFERENCES.serverChannelMap
    ) ?? DEFAULT_USER_PREFERENCES.serverChannelMap;

  const rightSidebarOpen =
    getLocalStorageItem(LocalStorageKey.RIGHT_SIDEBAR_STATE) === 'true';

  const full: TUserPreferences = {
    appearance: appearance ?? DEFAULT_USER_PREFERENCES.appearance,
    soundNotification:
      soundNotification ?? DEFAULT_USER_PREFERENCES.soundNotification,
    theme,
    serverChannelMap,
    rightSidebarOpen
  };

  syncPreference(full);
};

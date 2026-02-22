import {
  LocalStorageKey,
  setLocalStorageItem,
  setLocalStorageItemAsJSON
} from '@/helpers/storage';
import type { TUserPreferences } from '@pulse/shared';

/**
 * Write server preferences into localStorage so all existing
 * stores/hooks pick up the server's data immediately.
 */
export const applyServerPreferences = (prefs: TUserPreferences) => {
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
};

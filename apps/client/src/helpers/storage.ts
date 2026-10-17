export enum LocalStorageKey {
  EMAIL = 'pulse-email',
  REMEMBER_CREDENTIALS = 'pulse-remember-identity',
  VITE_UI_THEME = 'vite-ui-theme',
  DEVICES_SETTINGS = 'pulse-devices-settings',
  FLOATING_CARD_POSITION = 'pulse-floating-card-position',
  RIGHT_SIDEBAR_STATE = 'pulse-right-sidebar-state',
  VOLUME_SETTINGS = 'pulse-volume-settings',
  RECENT_EMOJIS = 'pulse-recent-emojis',
  AUDIO_DRIVER_PROMPT_DISMISSED = 'pulse-audio-driver-prompt-dismissed',
  ACTIVE_SERVER_ID = 'pulse-active-server-id',
  /** `{ instanceDomain, serverId }` of the federated server in focus —
   *  kept apart from ACTIVE_SERVER_ID, which is a HOME server id only. */
  ACTIVE_FEDERATED_SERVER = 'pulse-active-federated-server',
  FEDERATED_SERVERS = 'pulse-federated-servers',
  APPEARANCE_SETTINGS = 'pulse-appearance-settings',
  SERVER_CHANNEL_MAP = 'pulse-server-channel-map',
  SOUND_NOTIFICATION_SETTINGS = 'pulse-sound-notification-settings',
  ACTIVE_VIEW = 'pulse-active-view',
  SCROLL_POSITIONS = 'pulse-scroll-positions',
  DM_SCROLL_POSITIONS = 'pulse-dm-scroll-positions',
  ACTIVE_DM_CHANNEL_ID = 'pulse-active-dm-channel-id',
  HOME_TAB = 'pulse-home-tab',
  DECK_TABS = 'pulse-deck-tabs',
  DECK_PANEL_WIDTH = 'pulse-deck-panel-width'
}

const getLocalStorageItem = (key: LocalStorageKey): string | null => {
  return localStorage.getItem(key);
};

const getLocalStorageItemAsJSON = <T>(
  key: LocalStorageKey,
  defaultValue: T | undefined = undefined
): T | undefined => {
  const item = localStorage.getItem(key);

  if (item) {
    try {
      return JSON.parse(item) as T;
    } catch {
      // Corrupt or truncated value (quota hit mid-write, manual edit).
      // Several callers run at module evaluation, so throwing here kept
      // React from mounting at all; fall back and drop the bad value so
      // the next write starts clean.
      localStorage.removeItem(key);
    }
  }

  return defaultValue;
};

const setLocalStorageItemAsJSON = <T>(key: LocalStorageKey, value: T): void => {
  localStorage.setItem(key, JSON.stringify(value));
};

const setLocalStorageItem = (key: LocalStorageKey, value: string): void => {
  localStorage.setItem(key, value);
};

const removeLocalStorageItem = (key: LocalStorageKey): void => {
  localStorage.removeItem(key);
};

export {
  getLocalStorageItem,
  getLocalStorageItemAsJSON,
  removeLocalStorageItem,
  setLocalStorageItem,
  setLocalStorageItemAsJSON
};

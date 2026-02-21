export enum LocalStorageKey {
  EMAIL = 'pulse-email',
  REMEMBER_CREDENTIALS = 'pulse-remember-identity',
  SERVER_PASSWORD = 'pulse-server-password',
  VITE_UI_THEME = 'vite-ui-theme',
  DEVICES_SETTINGS = 'pulse-devices-settings',
  FLOATING_CARD_POSITION = 'pulse-floating-card-position',
  RIGHT_SIDEBAR_STATE = 'pulse-right-sidebar-state',
  VOICE_CHAT_SIDEBAR_STATE = 'pulse-voice-chat-sidebar-state',
  VOICE_CHAT_SIDEBAR_WIDTH = 'pulse-voice-chat-sidebar-width',
  VOLUME_SETTINGS = 'pulse-volume-settings',
  RECENT_EMOJIS = 'pulse-recent-emojis',
  ACTIVE_SERVER_ID = 'pulse-active-server-id',
  FEDERATED_SERVERS = 'pulse-federated-servers',
  ACTIVE_INSTANCE = 'pulse-active-instance',
  APPEARANCE_SETTINGS = 'pulse-appearance-settings',
  SERVER_CHANNEL_MAP = 'pulse-server-channel-map',
  SOUND_NOTIFICATION_SETTINGS = 'pulse-sound-notification-settings',
  ACTIVE_VIEW = 'pulse-active-view',
  SCROLL_POSITIONS = 'pulse-scroll-positions',
  DM_SCROLL_POSITIONS = 'pulse-dm-scroll-positions',
  ACTIVE_DM_CHANNEL_ID = 'pulse-active-dm-channel-id',
  HOME_TAB = 'pulse-home-tab'
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
    return JSON.parse(item) as T;
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

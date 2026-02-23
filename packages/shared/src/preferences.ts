export type TUserPreferences = {
  appearance: {
    compactMode: boolean;
    messageSpacing: 'tight' | 'normal' | 'relaxed';
    fontScale: number;
    zoomLevel: number;
    timeFormat: '12h' | '24h';
  };
  soundNotification: {
    masterVolume: number;
    messageSoundsEnabled: boolean;
    voiceSoundsEnabled: boolean;
    actionSoundsEnabled: boolean;
    desktopNotificationsEnabled: boolean;
  };
  theme: 'dark' | 'light' | 'onyx' | 'midnight' | 'sunset' | 'rose' | 'forest' | 'dracula' | 'nord' | 'sand' | 'system';
  serverChannelMap: Record<string, number>;
  rightSidebarOpen: boolean;
};

export const DEFAULT_USER_PREFERENCES: TUserPreferences = {
  appearance: {
    compactMode: false,
    messageSpacing: 'normal',
    fontScale: 100,
    zoomLevel: 100,
    timeFormat: '12h'
  },
  soundNotification: {
    masterVolume: 100,
    messageSoundsEnabled: true,
    voiceSoundsEnabled: true,
    actionSoundsEnabled: true,
    desktopNotificationsEnabled: false
  },
  theme: 'dark',
  serverChannelMap: {},
  rightSidebarOpen: false
};

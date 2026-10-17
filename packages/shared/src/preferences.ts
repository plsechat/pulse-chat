export type TUserPreferences = {
  appearance: {
    compactMode: boolean;
    messageSpacing: 'tight' | 'normal' | 'relaxed';
    fontScale: number;
    zoomLevel: number;
    timeFormat: '12h' | '24h';
    showFormattingHints: boolean;
    /** Shell layout: community tabs with side panels (the default), or the traditional server rail. */
    layout: 'classic' | 'deck';
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
  /**
   * Game presence. `shareGame` is the master switch the desktop shell's
   * detection is gated on (off by default — nothing leaves the machine
   * until the user opts in). `hiddenServers` lists the communities that
   * must not see it even then: numeric ids for home servers,
   * `domain:publicId` strings for federated ones.
   */
  presence: {
    shareGame: boolean;
    hiddenServers: Array<number | string>;
  };
};

export const DEFAULT_USER_PREFERENCES: TUserPreferences = {
  appearance: {
    compactMode: false,
    messageSpacing: 'normal',
    fontScale: 100,
    zoomLevel: 100,
    timeFormat: '12h',
    showFormattingHints: false,
    layout: 'deck'
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
  rightSidebarOpen: false,
  presence: {
    shareGame: false,
    hiddenServers: []
  }
};

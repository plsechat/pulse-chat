import { SoundType } from '@/features/server/types';
import {
  getLocalStorageItemAsJSON,
  LocalStorageKey,
  setLocalStorageItemAsJSON
} from '@/helpers/storage';
import { syncPreference } from '@/lib/preferences-sync';
import { useCallback, useSyncExternalStore } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SoundCategory = 'messages' | 'voice' | 'actions';

export type SoundNotificationSettings = {
  masterVolume: number;
  messageSoundsEnabled: boolean;
  voiceSoundsEnabled: boolean;
  actionSoundsEnabled: boolean;
  desktopNotificationsEnabled: boolean;
};

// ---------------------------------------------------------------------------
// Category → SoundType mapping
// ---------------------------------------------------------------------------

export const SOUND_CATEGORIES: Record<
  SoundCategory,
  { label: string; description: string; types: SoundType[]; preview: SoundType }
> = {
  messages: {
    label: 'Messages',
    description: 'Sounds for sent and received messages',
    types: [SoundType.MESSAGE_RECEIVED, SoundType.MESSAGE_SENT],
    preview: SoundType.MESSAGE_RECEIVED
  },
  voice: {
    label: 'Voice',
    description: 'Sounds for joining and leaving voice channels',
    types: [
      SoundType.OWN_USER_JOINED_VOICE_CHANNEL,
      SoundType.OWN_USER_LEFT_VOICE_CHANNEL,
      SoundType.REMOTE_USER_JOINED_VOICE_CHANNEL,
      SoundType.REMOTE_USER_LEFT_VOICE_CHANNEL
    ],
    preview: SoundType.OWN_USER_JOINED_VOICE_CHANNEL
  },
  actions: {
    label: 'Actions',
    description: 'Sounds for mic, audio, webcam, and screen share toggles',
    types: [
      SoundType.OWN_USER_MUTED_MIC,
      SoundType.OWN_USER_UNMUTED_MIC,
      SoundType.OWN_USER_MUTED_SOUND,
      SoundType.OWN_USER_UNMUTED_SOUND,
      SoundType.OWN_USER_STARTED_WEBCAM,
      SoundType.OWN_USER_STOPPED_WEBCAM,
      SoundType.OWN_USER_STARTED_SCREENSHARE,
      SoundType.OWN_USER_STOPPED_SCREENSHARE
    ],
    preview: SoundType.OWN_USER_MUTED_MIC
  }
};

// Pre-compute a reverse lookup: SoundType → category key for the enabled flag
const soundToCategoryKey: Record<string, keyof SoundNotificationSettings> = {};
for (const [, cat] of Object.entries(SOUND_CATEGORIES)) {
  const key =
    cat === SOUND_CATEGORIES.messages
      ? 'messageSoundsEnabled'
      : cat === SOUND_CATEGORIES.voice
        ? 'voiceSoundsEnabled'
        : 'actionSoundsEnabled';
  for (const t of cat.types) {
    soundToCategoryKey[t] = key;
  }
}

// ---------------------------------------------------------------------------
// Defaults & module-level state (mirrors use-appearance-settings.ts)
// ---------------------------------------------------------------------------

const defaultSettings: SoundNotificationSettings = {
  masterVolume: 100,
  messageSoundsEnabled: true,
  voiceSoundsEnabled: true,
  actionSoundsEnabled: true,
  desktopNotificationsEnabled: false
};

let listeners: Array<() => void> = [];
let currentSettings: SoundNotificationSettings | null = null;

const getSettings = (): SoundNotificationSettings => {
  if (currentSettings === null) {
    currentSettings =
      getLocalStorageItemAsJSON<SoundNotificationSettings>(
        LocalStorageKey.SOUND_NOTIFICATION_SETTINGS,
        defaultSettings
      ) ?? defaultSettings;
  }
  return currentSettings;
};

const subscribe = (listener: () => void) => {
  listeners = [...listeners, listener];
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
};

const updateSettings = (partial: Partial<SoundNotificationSettings>) => {
  currentSettings = { ...getSettings(), ...partial };
  setLocalStorageItemAsJSON(
    LocalStorageKey.SOUND_NOTIFICATION_SETTINGS,
    currentSettings
  );
  syncPreference({ soundNotification: partial });
  for (const listener of listeners) {
    listener();
  }
};

// Re-read from localStorage when server preferences are applied
if (typeof window !== 'undefined') {
  window.addEventListener('pulse-preferences-loaded', () => {
    currentSettings = null;
    getSettings();
    for (const listener of listeners) {
      listener();
    }
  });
}

// ---------------------------------------------------------------------------
// Non-React exports (for playSound / desktop-notification)
// ---------------------------------------------------------------------------

export const getSoundNotificationSettings = getSettings;

export const isCategoryEnabledForSound = (type: SoundType): boolean => {
  const key = soundToCategoryKey[type];
  if (!key) return true;
  return getSettings()[key] as boolean;
};

export const getMasterVolumeMultiplier = (): number =>
  getSettings().masterVolume / 100;

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

export const useSoundNotificationSettings = () => {
  const settings = useSyncExternalStore(subscribe, getSettings);

  const setMasterVolume = useCallback((value: number) => {
    updateSettings({ masterVolume: value });
  }, []);

  const setMessageSoundsEnabled = useCallback((value: boolean) => {
    updateSettings({ messageSoundsEnabled: value });
  }, []);

  const setVoiceSoundsEnabled = useCallback((value: boolean) => {
    updateSettings({ voiceSoundsEnabled: value });
  }, []);

  const setActionSoundsEnabled = useCallback((value: boolean) => {
    updateSettings({ actionSoundsEnabled: value });
  }, []);

  const setDesktopNotificationsEnabled = useCallback((value: boolean) => {
    updateSettings({ desktopNotificationsEnabled: value });
  }, []);

  return {
    settings,
    setMasterVolume,
    setMessageSoundsEnabled,
    setVoiceSoundsEnabled,
    setActionSoundsEnabled,
    setDesktopNotificationsEnabled
  };
};

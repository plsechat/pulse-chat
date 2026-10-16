import { SoundType } from '@/features/server/types';
import { LocalStorageKey } from '@/helpers/storage';
import { createPreferenceStore } from '@/lib/preference-store';
import { useCallback, useSyncExternalStore } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SoundCategory = 'messages' | 'voice' | 'actions' | 'calls';

export type SoundNotificationSettings = {
  masterVolume: number;
  messageSoundsEnabled: boolean;
  voiceSoundsEnabled: boolean;
  actionSoundsEnabled: boolean;
  /** The incoming-call ring. Its own switch: the ring loops while a call
   *  invitation is open and is the one sound people want off at night
   *  while still hearing who joins their channel. */
  callSoundsEnabled: boolean;
  desktopNotificationsEnabled: boolean;
  /** Per-event selected sound variant id (see SOUND_VARIANTS in
   *  sounds/actions.ts). Missing key = that event's default variant. */
  soundVariants: Partial<Record<string, string>>;
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
      SoundType.REMOTE_USER_LEFT_VOICE_CHANNEL,
      SoundType.REMOTE_USER_STARTED_SCREENSHARE
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
  },
  calls: {
    label: 'Calls',
    description: 'Ring for incoming calls',
    types: [SoundType.INCOMING_CALL],
    preview: SoundType.INCOMING_CALL
  }
};

/** The settings flag that enables each category. */
export const SOUND_CATEGORY_SETTING_KEY = {
  messages: 'messageSoundsEnabled',
  voice: 'voiceSoundsEnabled',
  actions: 'actionSoundsEnabled',
  calls: 'callSoundsEnabled'
} as const satisfies Record<SoundCategory, keyof SoundNotificationSettings>;

// Pre-compute a reverse lookup: SoundType → category key for the enabled flag
const soundToCategoryKey: Partial<
  Record<SoundType, keyof SoundNotificationSettings>
> = {};
for (const category of Object.keys(SOUND_CATEGORIES) as SoundCategory[]) {
  for (const t of SOUND_CATEGORIES[category].types) {
    soundToCategoryKey[t] = SOUND_CATEGORY_SETTING_KEY[category];
  }
}

// ---------------------------------------------------------------------------
// Defaults & store
// ---------------------------------------------------------------------------

const defaultSettings: SoundNotificationSettings = {
  masterVolume: 100,
  messageSoundsEnabled: true,
  voiceSoundsEnabled: true,
  actionSoundsEnabled: true,
  callSoundsEnabled: true,
  desktopNotificationsEnabled: false,
  soundVariants: {}
};

const store = createPreferenceStore<SoundNotificationSettings>({
  storageKey: LocalStorageKey.SOUND_NOTIFICATION_SETTINGS,
  defaults: defaultSettings,
  syncKey: 'soundNotification'
});

// ---------------------------------------------------------------------------
// Non-React exports (for playSound / desktop-notification)
// ---------------------------------------------------------------------------

export const getSoundNotificationSettings = store.getSettings;

export const isCategoryEnabledForSound = (type: SoundType): boolean => {
  const key = soundToCategoryKey[type];
  if (!key) return true;
  // A flag added after the settings were persisted is absent from the
  // stored object: treat it as its default (on) rather than as off.
  return store.getSettings()[key] !== false;
};

/** Non-React updater (the hook's setters wrap it). */
export const updateSoundNotificationSettings = store.updateSettings;

export const getMasterVolumeMultiplier = (): number =>
  store.getSettings().masterVolume / 100;

/** Selected variant id for an event, or undefined for its default. */
export const getSelectedSoundVariant = (
  type: SoundType
): string | undefined => store.getSettings().soundVariants?.[type];

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

export const useSoundNotificationSettings = () => {
  const settings = useSyncExternalStore(store.subscribe, store.getSettings);

  const setMasterVolume = useCallback(
    (value: number) => store.updateSettings({ masterVolume: value }),
    []
  );
  const setMessageSoundsEnabled = useCallback(
    (value: boolean) =>
      store.updateSettings({ messageSoundsEnabled: value }),
    []
  );
  const setVoiceSoundsEnabled = useCallback(
    (value: boolean) => store.updateSettings({ voiceSoundsEnabled: value }),
    []
  );
  const setActionSoundsEnabled = useCallback(
    (value: boolean) => store.updateSettings({ actionSoundsEnabled: value }),
    []
  );
  const setCallSoundsEnabled = useCallback(
    (value: boolean) => store.updateSettings({ callSoundsEnabled: value }),
    []
  );
  const setDesktopNotificationsEnabled = useCallback(
    (value: boolean) =>
      store.updateSettings({ desktopNotificationsEnabled: value }),
    []
  );
  const setSoundVariant = useCallback(
    (type: SoundType, variantId: string) =>
      store.updateSettings({
        soundVariants: {
          ...store.getSettings().soundVariants,
          [type]: variantId
        }
      }),
    []
  );

  return {
    settings,
    setMasterVolume,
    setMessageSoundsEnabled,
    setVoiceSoundsEnabled,
    setActionSoundsEnabled,
    setCallSoundsEnabled,
    setDesktopNotificationsEnabled,
    setSoundVariant
  };
};

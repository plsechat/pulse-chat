import { LocalStorageKey } from '@/helpers/storage';
import { createPreferenceStore } from '@/lib/preference-store';
import { DEFAULT_USER_PREFERENCES, type TUserPreferences } from '@pulse/shared';
import { useCallback, useSyncExternalStore } from 'react';

/**
 * Game presence sharing (User Settings → Privacy). `shareGame` gates the
 * desktop bridge (hooks/use-game-presence-bridge.ts): nothing is read
 * from the shell while it is off. `hiddenServers` is the per-community
 * opt-out the server applies to every roster — numeric ids for home
 * servers, `domain:publicId` keys for federated ones.
 */
export type PresenceSettings = TUserPreferences['presence'];

/** One key shape for a hidden entry: a home server id, or a federated server's `domain:publicId`. */
export type HiddenServerKey = number | string;

export const federatedServerKey = (
  instanceDomain: string,
  serverPublicId: string
): string => `${instanceDomain}:${serverPublicId}`;

const store = createPreferenceStore<PresenceSettings>({
  storageKey: LocalStorageKey.PRESENCE_SETTINGS,
  defaults: DEFAULT_USER_PREFERENCES.presence,
  syncKey: 'presence'
});

/** Non-React readers (the bridge decides on these without rendering). */
export const getPresenceSettings = store.getSettings;
export const subscribePresenceSettings = store.subscribe;

export const usePresenceSettings = () => {
  const settings = useSyncExternalStore(store.subscribe, store.getSettings);

  const setShareGame = useCallback(
    (value: boolean) => store.updateSettings({ shareGame: value }),
    []
  );

  const setServerHidden = useCallback((key: HiddenServerKey, hidden: boolean) => {
    const current = store.getSettings().hiddenServers;
    const without = current.filter((k) => k !== key);
    store.updateSettings({
      hiddenServers: hidden ? [...without, key] : without
    });
  }, []);

  return { settings, setShareGame, setServerHidden };
};

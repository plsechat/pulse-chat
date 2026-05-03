import {
  getLocalStorageItemAsJSON,
  type LocalStorageKey,
  setLocalStorageItemAsJSON
} from '@/helpers/storage';
import { syncPreference } from '@/lib/preferences-sync';

/**
 * Module-level cache store for a JSON-shaped user preference. Two
 * hooks (use-appearance-settings, use-sound-notification-settings)
 * had ~100 identical lines of state-machine boilerplate each:
 * lazy-load on first read, in-memory cache, listener set,
 * write-through to localStorage, push-to-server via `syncPreference`,
 * re-read on `pulse-preferences-loaded`. This factory consolidates
 * that boilerplate; each preference becomes a config-only call.
 *
 * Returns a `getSettings` / `subscribe` pair shaped for
 * `useSyncExternalStore`, plus a typed `updateSettings(partial)` for
 * the hook's setters and `reset()` (used internally on the
 * `pulse-preferences-loaded` event).
 */
type CreatePreferenceStoreOpts<T> = {
  storageKey: LocalStorageKey;
  defaults: T;
  /**
   * Key under which `syncPreference` should publish the partial
   * update so the server can persist it. Loose-typed so we don't
   * have to drag the full TUserPreferences shape into this lib.
   */
  syncKey: string;
  /**
   * Optional side-effect run AFTER the cache updates and BEFORE
   * listeners are notified. Used by appearance settings to push
   * --font-scale / body transform onto the DOM.
   */
  onChange?: (settings: T) => void;
};

const createPreferenceStore = <T>({
  storageKey,
  defaults,
  syncKey,
  onChange
}: CreatePreferenceStoreOpts<T>) => {
  let listeners: Array<() => void> = [];
  let currentSettings: T | null = null;

  const getSettings = (): T => {
    if (currentSettings === null) {
      currentSettings =
        getLocalStorageItemAsJSON<T>(storageKey, defaults) ?? defaults;
    }
    return currentSettings;
  };

  const subscribe = (listener: () => void) => {
    listeners = [...listeners, listener];
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  };

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const updateSettings = (partial: Partial<T>) => {
    currentSettings = { ...getSettings(), ...partial };
    setLocalStorageItemAsJSON(storageKey, currentSettings);
    onChange?.(currentSettings);
    syncPreference({ [syncKey]: partial } as Parameters<
      typeof syncPreference
    >[0]);
    notify();
  };

  // Re-read from localStorage when server preferences are applied.
  // Server-side preference sync writes the canonical state to
  // localStorage and dispatches `pulse-preferences-loaded`; we drop
  // our in-memory cache so the next getSettings() picks up the new
  // values, then fire the side-effect and notify subscribers.
  if (typeof window !== 'undefined') {
    window.addEventListener('pulse-preferences-loaded', () => {
      currentSettings = null;
      const fresh = getSettings();
      onChange?.(fresh);
      notify();
    });
  }

  return { getSettings, subscribe, updateSettings };
};

export { createPreferenceStore };

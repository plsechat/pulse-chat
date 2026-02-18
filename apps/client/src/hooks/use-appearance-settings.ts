import {
  getLocalStorageItemAsJSON,
  LocalStorageKey,
  setLocalStorageItemAsJSON
} from '@/helpers/storage';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

export type MessageSpacing = 'tight' | 'normal' | 'relaxed';

export type AppearanceSettings = {
  compactMode: boolean;
  messageSpacing: MessageSpacing;
  fontScale: number;
  zoomLevel: number;
};

const defaultSettings: AppearanceSettings = {
  compactMode: false,
  messageSpacing: 'normal',
  fontScale: 100,
  zoomLevel: 100
};

let listeners: Array<() => void> = [];
let currentSettings: AppearanceSettings | null = null;

const getSettings = (): AppearanceSettings => {
  if (currentSettings === null) {
    currentSettings =
      getLocalStorageItemAsJSON<AppearanceSettings>(
        LocalStorageKey.APPEARANCE_SETTINGS,
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

const updateSettings = (partial: Partial<AppearanceSettings>) => {
  currentSettings = { ...getSettings(), ...partial };
  setLocalStorageItemAsJSON(
    LocalStorageKey.APPEARANCE_SETTINGS,
    currentSettings
  );
  applySettingsToDOM(currentSettings);
  for (const listener of listeners) {
    listener();
  }
};

const applySettingsToDOM = (settings: AppearanceSettings) => {
  const root = document.documentElement;
  root.style.setProperty('--font-scale', `${settings.fontScale / 100}`);
  root.style.setProperty('--zoom-level', `${settings.zoomLevel / 100}`);
  root.setAttribute(
    'data-compact',
    settings.compactMode ? 'true' : 'false'
  );
  root.setAttribute('data-spacing', settings.messageSpacing);
};

// Apply on load
applySettingsToDOM(getSettings());

export const useAppearanceSettings = () => {
  const settings = useSyncExternalStore(subscribe, getSettings);

  useEffect(() => {
    applySettingsToDOM(settings);
  }, [settings]);

  const setCompactMode = useCallback((value: boolean) => {
    updateSettings({ compactMode: value });
  }, []);

  const setMessageSpacing = useCallback((value: MessageSpacing) => {
    updateSettings({ messageSpacing: value });
  }, []);

  const setFontScale = useCallback((value: number) => {
    updateSettings({ fontScale: value });
  }, []);

  const setZoomLevel = useCallback((value: number) => {
    updateSettings({ zoomLevel: value });
  }, []);

  return {
    settings,
    setCompactMode,
    setMessageSpacing,
    setFontScale,
    setZoomLevel
  };
};

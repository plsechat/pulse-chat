import {
  getLocalStorageItemAsJSON,
  LocalStorageKey,
  setLocalStorageItemAsJSON
} from '@/helpers/storage';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

export type MessageSpacing = 'tight' | 'normal' | 'relaxed';
export type TimeFormat = '12h' | '24h';

export type AppearanceSettings = {
  compactMode: boolean;
  messageSpacing: MessageSpacing;
  fontScale: number;
  zoomLevel: number;
  timeFormat: TimeFormat;
};

const defaultSettings: AppearanceSettings = {
  compactMode: false,
  messageSpacing: 'normal',
  fontScale: 100,
  zoomLevel: 100,
  timeFormat: '12h'
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
  // Zoom is applied via transform on body to avoid breaking overflow/scrolling
  document.body.style.transform =
    settings.zoomLevel !== 100 ? `scale(${settings.zoomLevel / 100})` : '';
  document.body.style.transformOrigin =
    settings.zoomLevel !== 100 ? 'top left' : '';
  document.body.style.width =
    settings.zoomLevel !== 100
      ? `${10000 / settings.zoomLevel}%`
      : '';
  document.body.style.height =
    settings.zoomLevel !== 100
      ? `${10000 / settings.zoomLevel}%`
      : '';
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

  const setTimeFormat = useCallback((value: TimeFormat) => {
    updateSettings({ timeFormat: value });
  }, []);

  return {
    settings,
    setCompactMode,
    setMessageSpacing,
    setFontScale,
    setZoomLevel,
    setTimeFormat
  };
};

/** Non-React getter for current time format preference */
export const getTimeFormat = (): TimeFormat => getSettings().timeFormat;

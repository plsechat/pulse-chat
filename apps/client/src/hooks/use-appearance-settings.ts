import { LocalStorageKey } from '@/helpers/storage';
import { createPreferenceStore } from '@/lib/preference-store';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

export type MessageSpacing = 'tight' | 'normal' | 'relaxed';
export type TimeFormat = '12h' | '24h';

export type AppearanceSettings = {
  compactMode: boolean;
  messageSpacing: MessageSpacing;
  fontScale: number;
  zoomLevel: number;
  timeFormat: TimeFormat;
  showFormattingHints: boolean;
};

const defaultSettings: AppearanceSettings = {
  compactMode: false,
  messageSpacing: 'normal',
  fontScale: 100,
  zoomLevel: 100,
  timeFormat: '12h',
  showFormattingHints: false
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
    settings.zoomLevel !== 100 ? `${10000 / settings.zoomLevel}%` : '';
  document.body.style.height =
    settings.zoomLevel !== 100 ? `${10000 / settings.zoomLevel}%` : '';
};

const store = createPreferenceStore<AppearanceSettings>({
  storageKey: LocalStorageKey.APPEARANCE_SETTINGS,
  defaults: defaultSettings,
  syncKey: 'appearance',
  onChange: applySettingsToDOM
});

// Apply on initial module load.
applySettingsToDOM(store.getSettings());

export const useAppearanceSettings = () => {
  const settings = useSyncExternalStore(store.subscribe, store.getSettings);

  // Re-apply DOM side-effects on every mount; the store fires onChange
  // on update, but a fresh component should also see the current state
  // reflected on the DOM (e.g. after route changes).
  useEffect(() => {
    applySettingsToDOM(settings);
  }, [settings]);

  const setCompactMode = useCallback(
    (value: boolean) => store.updateSettings({ compactMode: value }),
    []
  );
  const setMessageSpacing = useCallback(
    (value: MessageSpacing) => store.updateSettings({ messageSpacing: value }),
    []
  );
  const setFontScale = useCallback(
    (value: number) => store.updateSettings({ fontScale: value }),
    []
  );
  const setZoomLevel = useCallback(
    (value: number) => store.updateSettings({ zoomLevel: value }),
    []
  );
  const setTimeFormat = useCallback(
    (value: TimeFormat) => store.updateSettings({ timeFormat: value }),
    []
  );
  const setShowFormattingHints = useCallback(
    (value: boolean) => store.updateSettings({ showFormattingHints: value }),
    []
  );

  return {
    settings,
    setCompactMode,
    setMessageSpacing,
    setFontScale,
    setZoomLevel,
    setTimeFormat,
    setShowFormattingHints
  };
};

/** Non-React getter for current time format preference */
export const getTimeFormat = (): TimeFormat => store.getSettings().timeFormat;

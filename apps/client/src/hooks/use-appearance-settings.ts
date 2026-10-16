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
  messageSpacing: 'relaxed',
  fontScale: 100,
  zoomLevel: 100,
  timeFormat: '12h',
  showFormattingHints: false
};

/** Inclusive bounds of the two sliders; stored values outside are clamped. */
export const FONT_SCALE_RANGE = { min: 80, max: 120, step: 5 } as const;
export const ZOOM_LEVEL_RANGE = { min: 80, max: 120, step: 5 } as const;

const clamp = (value: number, range: { min: number; max: number }) =>
  Number.isFinite(value) ? Math.min(range.max, Math.max(range.min, value)) : 100;

/**
 * Pushes the two scaling preferences onto the document. Font scale is a
 * CSS variable the chat surface reads; zoom is the CSS `zoom` property
 * on <html>, which rescales layout the way browser zoom does: fixed
 * overlays and viewport units keep covering the real viewport, so
 * dialogs stay on screen at 120 %. (The previous body `transform:
 * scale()` + oversized box left every fixed dialog overflowing — the
 * reason the controls had been hidden behind an owner gate.)
 */
export const applyAppearanceToDOM = (
  settings: Pick<AppearanceSettings, 'fontScale' | 'zoomLevel'>,
  root: HTMLElement = document.documentElement
) => {
  const fontScale = clamp(settings.fontScale, FONT_SCALE_RANGE);
  const zoomLevel = clamp(settings.zoomLevel, ZOOM_LEVEL_RANGE);
  root.style.setProperty('--font-scale', `${fontScale / 100}`);
  root.style.setProperty('zoom', zoomLevel !== 100 ? `${zoomLevel}%` : '');
};

const applySettingsToDOM = (settings: AppearanceSettings) =>
  applyAppearanceToDOM(settings);

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

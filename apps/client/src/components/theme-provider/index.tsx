import {
  getLocalStorageItem,
  LocalStorageKey,
  setLocalStorageItem
} from '@/helpers/storage';
import { syncPreference } from '@/lib/preferences-sync';
import { createContext, useContext, useEffect, useState } from 'react';
import { onAppEvent } from '@/lib/events';

type Theme = 'dark' | 'light' | 'onyx' | 'midnight' | 'sunset' | 'rose' | 'forest' | 'dracula' | 'nord' | 'sand' | 'system';

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: LocalStorageKey;
};

type ThemeProviderState = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

const initialState: ThemeProviderState = {
  theme: 'system',
  setTheme: () => null
};

const ThemeProviderContext = createContext<ThemeProviderState>(initialState);

const THEME_CLASSES: Exclude<Theme, 'system'>[] = [
  'light',
  'dark',
  'onyx',
  'midnight',
  'sunset',
  'rose',
  'forest',
  'dracula',
  'nord',
  'sand'
];

/** The concrete theme the "system" option resolves to. */
const resolveSystemTheme = (
  prefersDark: boolean
): Exclude<Theme, 'system'> => (prefersDark ? 'dark' : 'light');

const applyThemeClass = (root: HTMLElement, theme: Exclude<Theme, 'system'>) => {
  root.classList.remove(...THEME_CLASSES);
  root.classList.add(theme);
};

function ThemeProvider({
  children,
  defaultTheme = 'system',
  storageKey = LocalStorageKey.VITE_UI_THEME,
  ...props
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(
    () => (getLocalStorageItem(storageKey) as Theme) || defaultTheme
  );

  useEffect(() => {
    const root = window.document.documentElement;

    if (theme !== 'system') {
      applyThemeClass(root, theme);
      return;
    }

    // "System" follows the OS for as long as it is selected — switching
    // the OS between light and dark re-applies without a reload.
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => applyThemeClass(root, resolveSystemTheme(mql.matches));
    apply();
    mql.addEventListener('change', apply);
    return () => mql.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    const handler = () => {
      const stored = getLocalStorageItem(storageKey) as Theme;
      if (stored) setTheme(stored);
    };
    return onAppEvent('preferences-loaded', handler);
  }, [storageKey]);

  const value = {
    theme,
    setTheme: (theme: Theme) => {
      setLocalStorageItem(storageKey, theme);
      setTheme(theme);
      syncPreference({ theme });
    }
  };

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

const useTheme = () => {
  const context = useContext(ThemeProviderContext);

  if (context === undefined)
    throw new Error('useTheme must be used within a ThemeProvider');

  return context;
};

// eslint-disable-next-line react-refresh/only-export-components
export { resolveSystemTheme, ThemeProvider, useTheme, type Theme };

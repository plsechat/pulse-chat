/// <reference types="vite/client" />
/// <reference types="zzfx" />

// Pulse Desktop (Electron) bridge API
interface PulseDesktopAudioDriver {
  getStatus(): Promise<{ supported: boolean; fileInstalled: boolean; active: boolean }>;
  install(): Promise<{ success: boolean; error?: string }>;
  uninstall(): Promise<{ success: boolean; error?: string }>;
}

interface PulseDesktopAudioCapture {
  isAvailable(): Promise<boolean>;
  start(): Promise<{ pulseDeviceUID: string; realOutputDeviceName: string } | null>;
  stop(): Promise<void>;
}

interface PulseDesktop {
  isElectron: true;
  platform: string;
  connectToServer(url: string): Promise<{ success: boolean; name?: string; version?: string; error?: string }>;
  disconnectServer(): Promise<void>;
  getSettings(): Promise<Record<string, unknown>>;
  updateSetting(key: string, value: unknown): Promise<void>;
  audioDriver: PulseDesktopAudioDriver;
  audioCapture: PulseDesktopAudioCapture;
  // Added in desktop 0.1.0 — optional so older shells stay type-correct.
  setBadgeCount?(count: number): Promise<void>;
  getStartupEnabled?(): Promise<boolean>;
  setStartupEnabled?(enabled: boolean): Promise<void>;
  // Added in desktop 0.2.0 — frameless window chrome (Windows overlay).
  getWindowChrome?(): Promise<'overlay' | 'native'>;
  setTitleBarOverlay?(overlay: {
    color?: string;
    symbolColor?: string;
  }): Promise<void>;
}

// Extend the Window interface for global functions
declare global {
  interface Window {
    printVoiceStats?: () => void;
    DEBUG?: boolean;
    pulseDesktop?: PulseDesktop;
  }

  const VITE_APP_VERSION: string;
}

export {};

import {
  getLocalStorageItemAsJSON,
  LocalStorageKey,
  setLocalStorageItemAsJSON
} from '@/helpers/storage';
import { DEFAULT_NOISE_GATE_THRESHOLD_DB } from '@/components/voice-provider/mic-pipeline';
import { Resolution, type TDeviceSettings } from '@/types';
import {
  createContext,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState
} from 'react';
import { useAvailableDevices } from './hooks/use-available-devices';
import {
  DEVICE_SETTINGS_SCHEMA_VERSION,
  migrateStoredDeviceSettings,
  type TStoredDeviceSettings
} from './migrate';

const DEFAULT_DEVICE_SETTINGS: TDeviceSettings = {
  microphoneId: undefined,
  playbackId: undefined,
  webcamId: undefined,
  webcamResolution: Resolution['720p'],
  webcamFramerate: 30,
  echoCancellation: false,
  noiseSuppressionMode: 'automatic',
  noiseGateThreshold: DEFAULT_NOISE_GATE_THRESHOLD_DB,
  autoGainControl: true,
  // ON preserves what every share did before the toggle existed.
  shareSystemAudio: true,
  screenResolution: Resolution['720p'],
  // Screen content is mostly static; 15 fps keeps text crisp at a
  // fraction of the encoder load of 30 (the laptop-heat complaint).
  screenFramerate: 15,
  screenAudioBitrate: 128
};

export type TDevicesProvider = {
  loading: boolean;
  devices: TDeviceSettings;
  saveDevices: (newDevices: TDeviceSettings) => void;
};

const DevicesProviderContext = createContext<TDevicesProvider>({
  loading: false,
  devices: DEFAULT_DEVICE_SETTINGS,
  saveDevices: () => {}
});

type TDevicesProviderProps = {
  children: React.ReactNode;
};

const DevicesProvider = memo(({ children }: TDevicesProviderProps) => {
  const [loading, setLoading] = useState<boolean>(true);
  const [devices, setDevices] = useState<TDeviceSettings>(
    DEFAULT_DEVICE_SETTINGS
  );
  const { loading: devicesLoading } = useAvailableDevices();

  const saveDevices = useCallback((newDevices: TDeviceSettings) => {
    setDevices(newDevices);
    setLocalStorageItemAsJSON<TStoredDeviceSettings>(
      LocalStorageKey.DEVICES_SETTINGS,
      { ...newDevices, schemaVersion: DEVICE_SETTINGS_SCHEMA_VERSION }
    );
  }, []);

  useEffect(() => {
    if (devicesLoading) return;

    const savedSettings = getLocalStorageItemAsJSON<TStoredDeviceSettings>(
      LocalStorageKey.DEVICES_SETTINGS
    );

    if (savedSettings) {
      setDevices(
        migrateStoredDeviceSettings(savedSettings, DEFAULT_DEVICE_SETTINGS)
      );
    }

    setLoading(false);
  }, [devicesLoading]);

  const contextValue = useMemo<TDevicesProvider>(
    () => ({
      loading,
      devices,
      saveDevices
    }),
    [loading, devices, saveDevices]
  );

  return (
    <DevicesProviderContext.Provider value={contextValue}>
      {children}
    </DevicesProviderContext.Provider>
  );
});

export { DevicesProvider, DevicesProviderContext };

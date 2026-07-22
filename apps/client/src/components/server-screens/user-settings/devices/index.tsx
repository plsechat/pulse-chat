import { useDevices } from '@/components/devices-provider/hooks/use-devices';
import { Button } from '@/components/ui/button';
import { LoadingCard } from '@/components/ui/loading-card';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import {
  Resolution,
  type NoiseSuppressionMode,
  type TDeviceSettings
} from '@/types';
import { Download, Trash2, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  SettingRow,
  SettingRowStack,
  SettingsSection
} from '../settings-primitives';
import { useAvailableDevices } from './hooks/use-available-devices';
import { MicMeter } from './mic-meter';

const DEFAULT_NAME = 'default';

const RESOLUTIONS = ['144p', '240p', '360p', '720p', '1080p', '1440p', '2160p'];
const FRAMERATES = [10, 15, 24, 30, 60, 120];

/** Resolution + framerate pair, sized for a row's right rail. */
const QualityPair = memo(
  ({
    resolution,
    framerate,
    onResolutionChange,
    onFramerateChange
  }: {
    resolution: string;
    framerate: number;
    onResolutionChange: (value: string) => void;
    onFramerateChange: (value: number) => void;
  }) => (
    <>
      <Select value={resolution} onValueChange={onResolutionChange}>
        <SelectTrigger size="sm" className="w-24">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {RESOLUTIONS.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Select
        value={framerate.toString()}
        onValueChange={(value) => onFramerateChange(+value)}
      >
        <SelectTrigger size="sm" className="w-24">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {FRAMERATES.map((f) => (
              <SelectItem key={f} value={f.toString()}>
                {f} fps
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </>
  )
);

const Devices = memo(() => {
  const currentVoiceChannelId = useCurrentVoiceChannelId();
  const {
    inputDevices,
    videoDevices,
    loading: availableDevicesLoading
  } = useAvailableDevices();
  const { devices, saveDevices, loading: devicesLoading } = useDevices();

  // Settings apply the moment they change — persisted immediately and,
  // mid-call, picked up live by the voice provider's device-diff effect.
  // No Save/Cancel gate.
  const values = devices;
  const onChange = useCallback(
    <K extends keyof TDeviceSettings>(key: K, value: TDeviceSettings[K]) => {
      saveDevices({ ...devices, [key]: value });
    },
    [devices, saveDevices]
  );

  if (availableDevicesLoading || devicesLoading) {
    return <LoadingCard className="h-[600px]" />;
  }

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Microphone"
        description="Input device and voice processing. Changes apply live to an active call."
      >
        <SettingRowStack label="Device">
          <Select
            onValueChange={(value) => onChange('microphoneId', value)}
            value={values.microphoneId}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select the input device" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {inputDevices.map((device) => (
                  <SelectItem
                    key={device?.deviceId}
                    value={device?.deviceId || DEFAULT_NAME}
                  >
                    {device?.label.trim() || 'Default Microphone'}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingRowStack>

        <SettingRow
          label="Echo cancellation"
          description="Keeps your speakers out of your mic."
        >
          <Switch
            checked={!!values.echoCancellation}
            onCheckedChange={(checked) => onChange('echoCancellation', checked)}
          />
        </SettingRow>

        <SettingRow
          label="Automatic gain control"
          description="Evens out how loud you are."
        >
          <Switch
            checked={!!values.autoGainControl}
            onCheckedChange={(checked) => onChange('autoGainControl', checked)}
          />
        </SettingRow>

        <SettingRow
          label="Noise suppression"
          description="Automatic filtering, a manual gate, or nothing."
        >
          <Select
            value={values.noiseSuppressionMode}
            onValueChange={(value) =>
              onChange('noiseSuppressionMode', value as NoiseSuppressionMode)
            }
          >
            <SelectTrigger size="sm" className="w-36">
              <SelectValue placeholder="Noise suppression" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="automatic">Automatic</SelectItem>
                <SelectItem value="manual">Noise gate</SelectItem>
                <SelectItem value="off">Off</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRowStack
          label={
            values.noiseSuppressionMode === 'manual'
              ? 'Input sensitivity'
              : 'Input level'
          }
          description={
            values.noiseSuppressionMode === 'manual'
              ? 'The bar lights up green while your mic would transmit.'
              : values.noiseSuppressionMode === 'automatic'
                ? 'Background noise is filtered automatically.'
                : undefined
          }
        >
          <MicMeter
            microphoneId={values.microphoneId}
            echoCancellation={!!values.echoCancellation}
            autoGainControl={!!values.autoGainControl}
            mode={values.noiseSuppressionMode}
            threshold={values.noiseGateThreshold}
            onThresholdChange={(db) => onChange('noiseGateThreshold', db)}
          />
        </SettingRowStack>
      </SettingsSection>

      <SettingsSection title="Camera">
        <SettingRowStack label="Device">
          <Select
            onValueChange={(value) => onChange('webcamId', value)}
            value={values.webcamId}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select the camera" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {videoDevices.map((device) => (
                  <SelectItem
                    key={device?.deviceId}
                    value={device?.deviceId || DEFAULT_NAME}
                  >
                    {device?.label.trim() || 'Default Webcam'}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingRowStack>

        <SettingRow
          label="Quality"
          description="Resolution and framerate for your camera."
        >
          <QualityPair
            resolution={values.webcamResolution}
            framerate={values.webcamFramerate}
            onResolutionChange={(value) =>
              onChange('webcamResolution', value as Resolution)
            }
            onFramerateChange={(value) => onChange('webcamFramerate', value)}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title="Screen sharing"
        description={
          currentVoiceChannelId
            ? 'Changes apply live to an active share.'
            : undefined
        }
      >
        <SettingRow
          label="Quality"
          description="Resolution and framerate for your stream."
        >
          <QualityPair
            resolution={values.screenResolution}
            framerate={values.screenFramerate}
            onResolutionChange={(value) =>
              onChange('screenResolution', value as Resolution)
            }
            onFramerateChange={(value) => onChange('screenFramerate', value)}
          />
        </SettingRow>

        <SettingRow
          label="Audio bitrate"
          description="Quality of the audio in your stream."
        >
          <Select
            value={(values.screenAudioBitrate ?? 128).toString()}
            onValueChange={(value) => onChange('screenAudioBitrate', +value)}
          >
            <SelectTrigger size="sm" className="w-28">
              <SelectValue placeholder="Audio bitrate" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {[64, 96, 128, 192, 256, 320].map((kbps) => (
                  <SelectItem key={kbps} value={kbps.toString()}>
                    {kbps} kbps
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsSection>

      {/* macOS Audio Driver — only shown in Electron on macOS */}
      <MacOSAudioDriverSection />
    </div>
  );
});

/** macOS system audio capture driver management section */
const MacOSAudioDriverSection = memo(() => {
  const isMacElectron = window.pulseDesktop?.platform === 'darwin';
  const [driverStatus, setDriverStatus] = useState<{
    supported: boolean;
    fileInstalled: boolean;
    active: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  const refreshStatus = useCallback(async () => {
    if (!window.pulseDesktop?.audioDriver) return;
    try {
      const status = await window.pulseDesktop.audioDriver.getStatus();
      setDriverStatus(status);
    } catch {
      setDriverStatus(null);
    }
  }, []);

  useEffect(() => {
    if (isMacElectron) refreshStatus();
  }, [isMacElectron, refreshStatus]);

  if (!isMacElectron || !driverStatus?.supported) return null;

  const handleInstall = async () => {
    setLoading(true);
    try {
      const result = await window.pulseDesktop!.audioDriver.install();
      if (result.success) {
        toast.success('Audio driver installed — "Pulse Audio" device is now available');
      } else if (result.error) {
        toast.error(result.error);
      }
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to install audio driver'));
    } finally {
      setLoading(false);
      refreshStatus();
    }
  };

  const handleUninstall = async () => {
    setLoading(true);
    try {
      const result = await window.pulseDesktop!.audioDriver.uninstall();
      if (result.success) {
        toast.success('Audio driver uninstalled');
      } else if (result.error) {
        toast.error(result.error);
      }
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to uninstall audio driver'));
    } finally {
      setLoading(false);
      refreshStatus();
    }
  };

  return (
    <SettingsSection
      title="System audio capture"
      description="Share system audio during screen sharing — needs a virtual audio driver installed on this Mac."
    >
      <SettingRow
        label="Driver status"
        description={
          driverStatus.active
            ? undefined
            : driverStatus.fileInstalled
              ? 'Restart coreaudiod to activate.'
              : 'Installs to /Library/Audio/Plug-Ins/HAL/.'
        }
      >
        {driverStatus.active ? (
          <span className="flex items-center gap-2 text-sm text-green-500">
            <CheckCircle className="h-4 w-4" /> Installed and active
          </span>
        ) : driverStatus.fileInstalled ? (
          <span className="flex items-center gap-2 text-sm text-yellow-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Installed, not active
          </span>
        ) : (
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <XCircle className="h-4 w-4" /> Not installed
          </span>
        )}
      </SettingRow>

      <SettingRow label="Manage driver">
        {!driverStatus.active && (
          <Button size="sm" onClick={handleInstall} disabled={loading}>
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            Install Driver
          </Button>
        )}
        {(driverStatus.fileInstalled || driverStatus.active) && (
          <Button
            size="sm"
            variant="destructive"
            onClick={handleUninstall}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="mr-2 h-4 w-4" />
            )}
            Uninstall Driver
          </Button>
        )}
      </SettingRow>
    </SettingsSection>
  );
});

export { Devices };

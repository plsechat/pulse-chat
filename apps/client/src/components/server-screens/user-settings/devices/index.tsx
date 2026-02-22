import { useDevices } from '@/components/devices-provider/hooks/use-devices';
import { Button } from '@/components/ui/button';
import { Group } from '@/components/ui/group';
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
import { closeServerScreens } from '@/features/server-screens/actions';
import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { useForm } from '@/hooks/use-form';
import { Resolution } from '@/types';
import { Download, Trash2, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useAvailableDevices } from './hooks/use-available-devices';
import ResolutionFpsControl from './resolution-fps-control';

const DEFAULT_NAME = 'default';

const Devices = memo(() => {
  const currentVoiceChannelId = useCurrentVoiceChannelId();
  const {
    inputDevices,
    videoDevices,
    loading: availableDevicesLoading
  } = useAvailableDevices();
  const { devices, saveDevices, loading: devicesLoading } = useDevices();
  const { values, onChange } = useForm(devices);

  const saveDeviceSettings = useCallback(() => {
    saveDevices(values);
    toast.success('Device settings saved');
  }, [saveDevices, values]);

  if (availableDevicesLoading || devicesLoading) {
    return <LoadingCard className="h-[600px]" />;
  }

  return (
    <div className="space-y-4">
        <Group label="Microphone">
          <Select
            onValueChange={(value) => onChange('microphoneId', value)}
            value={values.microphoneId}
          >
            <SelectTrigger className="w-[500px]">
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

          <div className="flex gap-8">
            <Group label="Echo cancellation">
              <Switch
                checked={!!values.echoCancellation}
                onCheckedChange={(checked) =>
                  onChange('echoCancellation', checked)
                }
              />
            </Group>

            <Group label="Noise suppression">
              <Switch
                checked={!!values.noiseSuppression}
                onCheckedChange={(checked) =>
                  onChange('noiseSuppression', checked)
                }
              />
            </Group>

            <Group label="Automatic gain control">
              <Switch
                checked={!!values.autoGainControl}
                onCheckedChange={(checked) =>
                  onChange('autoGainControl', checked)
                }
              />
            </Group>
          </div>
        </Group>

        <Group label="Webcam">
          <Select
            onValueChange={(value) => onChange('webcamId', value)}
            value={values.webcamId}
          >
            <SelectTrigger className="w-[500px]">
              <SelectValue placeholder="Select the input device" />
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

          <ResolutionFpsControl
            framerate={values.webcamFramerate}
            resolution={values.webcamResolution}
            onFramerateChange={(value) => onChange('webcamFramerate', value)}
            onResolutionChange={(value) =>
              onChange('webcamResolution', value as Resolution)
            }
          />
        </Group>

        <Group label="Screen Sharing" description={currentVoiceChannelId ? 'Screen sharing settings take effect on your next share.' : undefined}>
          <ResolutionFpsControl
            framerate={values.screenFramerate}
            resolution={values.screenResolution}
            onFramerateChange={(value) => onChange('screenFramerate', value)}
            onResolutionChange={(value) =>
              onChange('screenResolution', value as Resolution)
            }
          />

          <div className="flex items-center gap-2">
            <Group label="Audio Bitrate">
              <Select
                value={(values.screenAudioBitrate ?? 128).toString()}
                onValueChange={(value) =>
                  onChange('screenAudioBitrate', +value)
                }
              >
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="Audio bitrate" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="64">64 kbps</SelectItem>
                    <SelectItem value="96">96 kbps</SelectItem>
                    <SelectItem value="128">128 kbps</SelectItem>
                    <SelectItem value="192">192 kbps</SelectItem>
                    <SelectItem value="256">256 kbps</SelectItem>
                    <SelectItem value="320">320 kbps</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Group>
          </div>
        </Group>
        {/* macOS Audio Driver — only shown in Electron on macOS */}
        <MacOSAudioDriverSection />

        <div className="flex justify-end gap-2 pt-4">
          <Button variant="outline" onClick={closeServerScreens}>
            Cancel
          </Button>
          <Button onClick={saveDeviceSettings}>Save Changes</Button>
        </div>
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
    } catch {
      toast.error('Failed to install audio driver');
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
    } catch {
      toast.error('Failed to uninstall audio driver');
    } finally {
      setLoading(false);
      refreshStatus();
    }
  };

  return (
    <Group label="System Audio Capture (macOS)">
      <p className="text-sm text-muted-foreground">
        Share system audio during screen sharing. Requires a virtual audio driver
        installed to <code>/Library/Audio/Plug-Ins/HAL/</code>.
      </p>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          {driverStatus.active ? (
            <>
              <CheckCircle className="h-4 w-4 text-green-500" />
              <span className="text-sm text-green-500">Driver installed and active</span>
            </>
          ) : driverStatus.fileInstalled ? (
            <>
              <Loader2 className="h-4 w-4 text-yellow-500 animate-spin" />
              <span className="text-sm text-yellow-500">Driver installed but not active (restart coreaudiod)</span>
            </>
          ) : (
            <>
              <XCircle className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Driver not installed</span>
            </>
          )}
        </div>
      </div>
      <div className="flex gap-2">
        {!driverStatus.active && (
          <Button
            size="sm"
            onClick={handleInstall}
            disabled={loading}
          >
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
      </div>
    </Group>
  );
});

export { Devices };

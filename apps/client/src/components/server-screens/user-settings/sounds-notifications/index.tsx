import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { playSoundForPreview } from '@/features/server/sounds/actions';
import {
  SOUND_CATEGORIES,
  useSoundNotificationSettings,
  type SoundCategory
} from '@/hooks/use-sound-notification-settings';
import { AlertTriangle, Play } from 'lucide-react';
import { memo, useCallback, useState } from 'react';

const categorySettingKeys = {
  messages: 'messageSoundsEnabled',
  voice: 'voiceSoundsEnabled',
  actions: 'actionSoundsEnabled'
} as const;

const categorySetters = {
  messages: 'setMessageSoundsEnabled',
  voice: 'setVoiceSoundsEnabled',
  actions: 'setActionSoundsEnabled'
} as const;

const SoundsNotifications = memo(() => {
  const {
    settings,
    setMasterVolume,
    setMessageSoundsEnabled,
    setVoiceSoundsEnabled,
    setActionSoundsEnabled,
    setDesktopNotificationsEnabled
  } = useSoundNotificationSettings();

  const [notificationPermission, setNotificationPermission] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied'
  );

  const setters = {
    setMessageSoundsEnabled,
    setVoiceSoundsEnabled,
    setActionSoundsEnabled
  };

  const handleDesktopNotificationToggle = useCallback(
    async (enabled: boolean) => {
      if (enabled && Notification.permission === 'default') {
        const result = await Notification.requestPermission();
        setNotificationPermission(result);
        if (result !== 'granted') return;
      }
      setDesktopNotificationsEnabled(enabled);
    },
    [setDesktopNotificationsEnabled]
  );

  return (
    <div className="space-y-8">
      {/* Master Volume */}
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">Master Volume</h3>
          <p className="text-sm text-muted-foreground">
            Control the overall volume for all sounds.
          </p>
        </div>

        <Slider
          min={0}
          max={100}
          step={1}
          value={[settings.masterVolume]}
          onValueChange={([value]) => setMasterVolume(value)}
          rightSlot={
            <span className="text-sm text-muted-foreground w-10 text-right tabular-nums">
              {settings.masterVolume}%
            </span>
          }
        />
      </div>

      {/* Sound Categories */}
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">Sound Categories</h3>
          <p className="text-sm text-muted-foreground">
            Enable or disable sounds for each category.
          </p>
        </div>

        <div className="space-y-3">
          {(Object.keys(SOUND_CATEGORIES) as SoundCategory[]).map((key) => {
            const cat = SOUND_CATEGORIES[key];
            const settingKey = categorySettingKeys[key];
            const setterKey = categorySetters[key];
            const enabled = settings[settingKey];

            return (
              <div
                key={key}
                className="flex items-center justify-between rounded-lg border border-border p-4"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{cat.label}</div>
                  <div className="text-sm text-muted-foreground">
                    {cat.description}
                  </div>
                </div>

                <div className="flex items-center gap-3 ml-4">
                  <button
                    onClick={() => playSoundForPreview(cat.preview)}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    title="Preview sound"
                  >
                    <Play className="h-4 w-4" />
                  </button>
                  <Switch
                    checked={enabled}
                    onCheckedChange={(val) => setters[setterKey](val)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Desktop Notifications */}
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">Desktop Notifications</h3>
          <p className="text-sm text-muted-foreground">
            Show browser notifications when you receive messages while the tab is
            in the background.
          </p>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-border p-4">
          <div className="flex-1 min-w-0">
            <div className="font-medium">Enable Desktop Notifications</div>
            <div className="text-sm text-muted-foreground">
              {notificationPermission === 'denied'
                ? 'Notifications are blocked by your browser.'
                : 'Receive alerts for new messages when the tab is not focused.'}
            </div>
          </div>

          <div className="ml-4">
            <Switch
              checked={settings.desktopNotificationsEnabled}
              onCheckedChange={handleDesktopNotificationToggle}
              disabled={notificationPermission === 'denied'}
            />
          </div>
        </div>

        {notificationPermission === 'denied' && (
          <div className="flex items-start gap-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-600 dark:text-yellow-400">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              Notifications are blocked. To enable them, update your browser's
              site permissions for this page and refresh.
            </span>
          </div>
        )}
      </div>
    </div>
  );
});

export { SoundsNotifications };

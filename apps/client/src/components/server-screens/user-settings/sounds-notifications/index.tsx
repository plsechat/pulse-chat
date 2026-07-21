import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  playSoundForPreview,
  SOUND_VARIANTS
} from '@/features/server/sounds/actions';
import { SoundType } from '@/features/server/types';
import {
  SOUND_CATEGORIES,
  useSoundNotificationSettings,
  type SoundCategory
} from '@/hooks/use-sound-notification-settings';
import { AlertTriangle, Play } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import {
  SettingRow,
  SettingRowStack,
  SettingsSection
} from '../settings-primitives';

/** The events with selectable sounds, in display order. */
const VARIANT_EVENTS: { type: SoundType; label: string; hint: string }[] = [
  {
    type: SoundType.MESSAGE_RECEIVED,
    label: 'Message received',
    hint: 'Plays when a new message arrives'
  },
  {
    type: SoundType.MESSAGE_SENT,
    label: 'Message sent',
    hint: 'Plays when your message goes out'
  },
  {
    type: SoundType.OWN_USER_JOINED_VOICE_CHANNEL,
    label: 'Join voice',
    hint: 'Plays when you join a voice channel'
  },
  {
    type: SoundType.OWN_USER_LEFT_VOICE_CHANNEL,
    label: 'Leave voice',
    hint: 'Plays when you leave a voice channel'
  },
  {
    type: SoundType.INCOMING_CALL,
    label: 'Incoming call',
    hint: 'Rings while a call invitation is open'
  }
];

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
    setDesktopNotificationsEnabled,
    setSoundVariant
  } = useSoundNotificationSettings();

  // Picking a variant applies instantly AND plays it, so choosing a
  // sound doubles as auditioning it.
  const handleVariantChange = useCallback(
    (type: SoundType, variantId: string) => {
      setSoundVariant(type, variantId);
      playSoundForPreview(type, variantId);
    },
    [setSoundVariant]
  );

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
      <SettingsSection
        title="Volume"
        description="Overall loudness for every sound the app makes."
      >
        <SettingRowStack
          label="Master volume"
          description="Double-click the slider to reset to 100%."
        >
          {/* Double-click resets to exactly 100 — dragging back to the
              precise midpoint is fiddly. Boosted range renders yellow. */}
          <div
            onDoubleClick={() => setMasterVolume(100)}
            title="Double-click to reset to 100%"
          >
            <Slider
              min={0}
              max={200}
              step={1}
              value={[settings.masterVolume]}
              onValueChange={([value]) => setMasterVolume(value)}
              className={
                settings.masterVolume > 100
                  ? '[&_[data-slot=slider-range]]:bg-yellow-500 [&_[data-slot=slider-thumb]]:border-yellow-500'
                  : undefined
              }
              rightSlot={
                <span
                  className={
                    settings.masterVolume > 100
                      ? 'text-sm w-10 text-right tabular-nums text-yellow-600 dark:text-yellow-400'
                      : 'text-sm text-muted-foreground w-10 text-right tabular-nums'
                  }
                >
                  {settings.masterVolume}%
                </span>
              }
            />
          </div>
          {settings.masterVolume > 100 && (
            <p className="text-xs text-yellow-600 dark:text-yellow-400">
              Boosted above 100% — sounds may clip on some speakers.
            </p>
          )}
        </SettingRowStack>
      </SettingsSection>

      <SettingsSection
        title="Notification sounds"
        description="Pick the sound for each event. Choosing one plays it."
      >
        {VARIANT_EVENTS.map(({ type, label, hint }) => {
          const variants = SOUND_VARIANTS[type];
          if (!variants) return null;
          const selected = settings.soundVariants?.[type] ?? variants[0].id;
          // Registry order encodes the default (index 0); the picker
          // shows them alphabetically.
          const sorted = [...variants].sort((a, b) =>
            a.label.localeCompare(b.label)
          );

          return (
            <SettingRow key={type} label={label} description={hint}>
              <button
                onClick={() => playSoundForPreview(type, selected)}
                className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title="Preview sound"
              >
                <Play className="h-4 w-4" />
              </button>
              <Select
                value={selected}
                onValueChange={(value) => handleVariantChange(type, value)}
              >
                <SelectTrigger size="sm" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sorted.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
          );
        })}
      </SettingsSection>

      <SettingsSection
        title="Sound categories"
        description="Silence whole groups of sounds at once."
      >
        {(Object.keys(SOUND_CATEGORIES) as SoundCategory[]).map((key) => {
          const cat = SOUND_CATEGORIES[key];
          const settingKey = categorySettingKeys[key];
          const setterKey = categorySetters[key];
          const enabled = settings[settingKey];

          return (
            <SettingRow key={key} label={cat.label} description={cat.description}>
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
            </SettingRow>
          );
        })}
      </SettingsSection>

      <SettingsSection
        title="Desktop notifications"
        description="Browser alerts for new messages while the tab is in the background."
      >
        <SettingRow
          label="Enable desktop notifications"
          description={
            notificationPermission === 'denied'
              ? 'Notifications are blocked by your browser.'
              : 'Alerts for new messages when the tab is not focused.'
          }
        >
          <Switch
            checked={settings.desktopNotificationsEnabled}
            onCheckedChange={handleDesktopNotificationToggle}
            disabled={notificationPermission === 'denied'}
          />
        </SettingRow>
      </SettingsSection>

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
  );
});

export { SoundsNotifications };

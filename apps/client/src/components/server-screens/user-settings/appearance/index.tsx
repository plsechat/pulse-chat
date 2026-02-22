import { useTheme } from '@/components/theme-provider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import {
  useAppearanceSettings,
  type MessageSpacing,
  type TimeFormat
} from '@/hooks/use-appearance-settings';
import { useIsOwnUserOwner } from '@/features/server/hooks';
import { Check, Circle, Monitor, Moon, Sun } from 'lucide-react';
import { memo } from 'react';

type ThemeOption = {
  value: 'dark' | 'light' | 'onyx' | 'system';
  label: string;
  icon: React.ReactNode;
  swatch: React.ReactNode;
};

const themeOptions: ThemeOption[] = [
  {
    value: 'dark',
    label: 'Dark',
    icon: <Moon className="h-4 w-4" />,
    swatch: <div className="h-full w-full rounded bg-[#313338]" />
  },
  {
    value: 'light',
    label: 'Light',
    icon: <Sun className="h-4 w-4" />,
    swatch: (
      <div className="h-full w-full rounded border border-border bg-white" />
    )
  },
  {
    value: 'onyx',
    label: 'Onyx',
    icon: <Circle className="h-4 w-4" />,
    swatch: <div className="h-full w-full rounded bg-[#0F0F0F]" />
  },
  {
    value: 'system',
    label: 'System',
    icon: <Monitor className="h-4 w-4" />,
    swatch: (
      <div className="flex h-full w-full overflow-hidden rounded">
        <div className="w-1/2 bg-white" />
        <div className="w-1/2 bg-[#313338]" />
      </div>
    )
  }
];

const Appearance = memo(() => {
  const { theme, setTheme } = useTheme();
  const {
    settings,
    setCompactMode,
    setMessageSpacing,
    setFontScale,
    setZoomLevel,
    setTimeFormat
  } = useAppearanceSettings();
  const isOwner = useIsOwnUserOwner();

  return (
    <div className="space-y-8">
      {/* Theme */}
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">Theme</h3>
          <p className="text-sm text-muted-foreground">
            Choose how the app looks for you.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {themeOptions.map((option) => (
            <button
              key={option.value}
              onClick={() => setTheme(option.value)}
              className={`relative flex flex-col items-center gap-2 rounded-lg border-2 p-4 transition-colors hover:bg-accent/50 ${
                theme === option.value
                  ? 'border-primary bg-accent/30'
                  : 'border-border'
              }`}
            >
              {theme === option.value && (
                <div className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-primary">
                  <Check className="h-3 w-3 text-primary-foreground" />
                </div>
              )}
              <div className="h-16 w-full">{option.swatch}</div>
              <div className="flex items-center gap-1.5 text-sm font-medium">
                {option.icon}
                {option.label}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Chat Density */}
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">Chat Density</h3>
          <p className="text-sm text-muted-foreground">
            Choose between a cozy or compact message layout.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => setCompactMode(false)}
            className={`relative flex flex-col items-center gap-2 rounded-lg border-2 p-4 transition-colors hover:bg-accent/50 ${
              !settings.compactMode
                ? 'border-primary bg-accent/30'
                : 'border-border'
            }`}
          >
            {!settings.compactMode && (
              <div className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-primary">
                <Check className="h-3 w-3 text-primary-foreground" />
              </div>
            )}
            <div className="h-12 w-full flex flex-col gap-1.5 px-2">
              <div className="flex items-center gap-2">
                <div className="h-6 w-6 rounded-full bg-muted-foreground/20" />
                <div className="h-2 w-16 rounded bg-muted-foreground/20" />
              </div>
              <div className="h-2 w-24 rounded bg-muted-foreground/10 ml-8" />
            </div>
            <span className="text-sm font-medium">Cozy</span>
          </button>
          <button
            onClick={() => setCompactMode(true)}
            className={`relative flex flex-col items-center gap-2 rounded-lg border-2 p-4 transition-colors hover:bg-accent/50 ${
              settings.compactMode
                ? 'border-primary bg-accent/30'
                : 'border-border'
            }`}
          >
            {settings.compactMode && (
              <div className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-primary">
                <Check className="h-3 w-3 text-primary-foreground" />
              </div>
            )}
            <div className="h-12 w-full flex flex-col gap-0.5 px-2 justify-center">
              <div className="flex items-center gap-1.5">
                <div className="h-3 w-3 rounded-full bg-muted-foreground/20" />
                <div className="h-1.5 w-12 rounded bg-muted-foreground/20" />
                <div className="h-1.5 w-20 rounded bg-muted-foreground/10" />
              </div>
              <div className="flex items-center gap-1.5">
                <div className="h-3 w-3 rounded-full bg-muted-foreground/20" />
                <div className="h-1.5 w-10 rounded bg-muted-foreground/20" />
                <div className="h-1.5 w-16 rounded bg-muted-foreground/10" />
              </div>
            </div>
            <span className="text-sm font-medium">Compact</span>
          </button>
        </div>
      </div>

      {/* Message Spacing */}
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">Message Spacing</h3>
          <p className="text-sm text-muted-foreground">
            Control the space between message groups.
          </p>
        </div>

        <Select
          value={settings.messageSpacing}
          onValueChange={(value) => setMessageSpacing(value as MessageSpacing)}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="tight">Tight</SelectItem>
            <SelectItem value="normal">Normal</SelectItem>
            <SelectItem value="relaxed">Relaxed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Time Format */}
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">Time Format</h3>
          <p className="text-sm text-muted-foreground">
            Choose how timestamps are displayed.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {([
            { value: '12h' as TimeFormat, label: '12 Hour', example: '3:45 PM' },
            { value: '24h' as TimeFormat, label: '24 Hour', example: '15:45' }
          ]).map((option) => (
            <button
              key={option.value}
              onClick={() => setTimeFormat(option.value)}
              className={`relative flex flex-col items-center gap-2 rounded-lg border-2 p-4 transition-colors hover:bg-accent/50 ${
                settings.timeFormat === option.value
                  ? 'border-primary bg-accent/30'
                  : 'border-border'
              }`}
            >
              {settings.timeFormat === option.value && (
                <div className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-primary">
                  <Check className="h-3 w-3 text-primary-foreground" />
                </div>
              )}
              <span className="text-lg font-mono text-muted-foreground">
                {option.example}
              </span>
              <span className="text-sm font-medium">{option.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Font Scaling & Zoom — admin only (experimental) */}
      {isOwner && (
        <>
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold">Font Scaling</h3>
              <p className="text-sm text-muted-foreground">
                Adjust the text size in chat messages.
              </p>
            </div>

            <Slider
              min={80}
              max={120}
              step={5}
              value={[settings.fontScale]}
              onValueChange={([value]) => setFontScale(value)}
              rightSlot={
                <span className="text-sm text-muted-foreground w-10 text-right tabular-nums">
                  {settings.fontScale}%
                </span>
              }
            />
          </div>

          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold">Zoom Level</h3>
              <p className="text-sm text-muted-foreground">
                Scale the entire interface. Best suited for desktop.
              </p>
            </div>

            <Slider
              min={80}
              max={120}
              step={5}
              value={[settings.zoomLevel]}
              onValueChange={([value]) => setZoomLevel(value)}
              rightSlot={
                <span className="text-sm text-muted-foreground w-10 text-right tabular-nums">
                  {settings.zoomLevel}%
                </span>
              }
            />
          </div>
        </>
      )}
    </div>
  );
});

export { Appearance };

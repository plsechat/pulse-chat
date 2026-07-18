import type { TEmojiItem } from '@/components/tiptap-input/types';
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@/components/ui/popover';
import { useTheme } from '@/components/theme-provider';
import { useCustomEmojis } from '@/features/server/emojis/hooks';
import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';
import { memo, useCallback, useMemo, useState } from 'react';

type TEmojiPickerProps = {
  children: React.ReactNode;
  onEmojiSelect: (emoji: TEmojiItem) => void;
};

type TEmojiMartEmoji = {
  id: string;
  name: string;
  native?: string;
  shortcodes: string;
  src?: string;
};

const THEME_MAP: Record<string, 'light' | 'dark' | 'auto'> = {
  light: 'light',
  dark: 'dark',
  onyx: 'dark',
  midnight: 'dark',
  sunset: 'dark',
  rose: 'dark',
  forest: 'dark',
  dracula: 'dark',
  nord: 'light',
  sand: 'light',
  system: 'auto'
};

/**
 * The bare emoji-mart panel (custom-emoji category + theme wiring),
 * decoupled from any Popover. Use this directly when the picker must be
 * hosted by an overlay the parent already owns — e.g. opened FROM a
 * context/dropdown menu, where nesting a second Popover inside the menu
 * makes the menu's dismiss layer tear the picker down on hover/focus.
 */
const EmojiPickerPanel = memo(
  ({ onEmojiSelect }: { onEmojiSelect: (emoji: TEmojiItem) => void }) => {
    const customEmojis = useCustomEmojis();
    const { theme } = useTheme();

    const customCategory = useMemo(() => {
      if (customEmojis.length === 0) return [];
      return [
        {
          id: 'server-emojis',
          name: 'Server Emojis',
          emojis: customEmojis.map((e) => ({
            id: e.name,
            name: e.name,
            keywords: [e.name, 'custom'],
            skins: [{ src: e.fallbackImage }]
          }))
        }
      ];
    }, [customEmojis]);

    const handleEmojiSelect = useCallback(
      (emoji: TEmojiMartEmoji) => {
        const custom = customEmojis.find((e) => e.name === emoji.id);
        const item: TEmojiItem = {
          id: custom?.id as number | undefined,
          name: emoji.id,
          shortcodes: [emoji.shortcodes?.replace(/:/g, '') || emoji.id],
          emoji: emoji.native,
          fallbackImage: emoji.src
        };
        onEmojiSelect(item);
      },
      [onEmojiSelect, customEmojis]
    );

    return (
      <Picker
        data={data}
        onEmojiSelect={handleEmojiSelect}
        theme={THEME_MAP[theme] ?? 'auto'}
        set="native"
        custom={customCategory}
        autoFocus
        previewPosition="none"
        skinTonePosition="search"
        maxFrequentRows={2}
        perLine={8}
      />
    );
  }
);

EmojiPickerPanel.displayName = 'EmojiPickerPanel';

const EmojiPicker = memo(({ children, onEmojiSelect }: TEmojiPickerProps) => {
  const [open, setOpen] = useState(false);

  const handleSelect = useCallback(
    (item: TEmojiItem) => {
      onEmojiSelect(item);
      setOpen(false);
    },
    [onEmojiSelect]
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        // `duration-0` on close: when the trigger sits inside a hover-only
        // action bar, clicking an emoji makes the bar `display:none` (mouse
        // is no longer over the message group, and Radix has flipped the
        // trigger's data-state to "closed" so the bar's `:has` keep-open
        // rule no longer applies). The popover then animates its close from
        // a zero-bounding-box trigger, snapping to (0,0) before fading out.
        // Killing the close animation removes the window in which the
        // misplacement is visible. Open animation is unaffected.
        className="w-auto p-0 border-none shadow-none bg-transparent data-[state=closed]:duration-0"
        align="start"
        sideOffset={8}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <EmojiPickerPanel onEmojiSelect={handleSelect} />
      </PopoverContent>
    </Popover>
  );
});

EmojiPicker.displayName = 'EmojiPicker';

export { EmojiPicker, EmojiPickerPanel };

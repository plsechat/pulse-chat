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
  system: 'auto'
};

const EmojiPicker = memo(({ children, onEmojiSelect }: TEmojiPickerProps) => {
  const [open, setOpen] = useState(false);
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
      const item: TEmojiItem = {
        name: emoji.id,
        shortcodes: [emoji.shortcodes?.replace(/:/g, '') || emoji.id],
        emoji: emoji.native,
        fallbackImage: emoji.src
      };
      onEmojiSelect(item);
      setOpen(false);
    },
    [onEmojiSelect]
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        className="w-auto p-0 border-none shadow-none bg-transparent"
        align="start"
        sideOffset={8}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onFocusOutside={(e) => e.preventDefault()}
      >
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
      </PopoverContent>
    </Popover>
  );
});

EmojiPicker.displayName = 'EmojiPicker';

export { EmojiPicker };

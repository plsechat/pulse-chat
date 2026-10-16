import type { TEmojiItem } from '@/components/tiptap-input/types';
import { useTheme } from '@/components/theme-provider';
import { useCustomEmojis } from '@/features/server/emojis/hooks';
import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';
import { Data as emojiMartData } from 'emoji-mart';
import { memo, useCallback, useMemo } from 'react';

/**
 * The emoji-mart panel and its ~430 kB emoji dataset. Imported only
 * through the lazy wrapper in ./index.tsx, so this module (and the
 * emoji vendor chunk) is fetched the first time a picker opens.
 */

type TEmojiMartEmoji = {
  id: string;
  name: string;
  native?: string;
  shortcodes: string;
  src?: string;
};

type TCustomEmojiEntry = {
  id: string;
  name: string;
  keywords: string[];
  skins: { src: string | undefined }[];
};

type TCustomCategory = {
  id: string;
  name: string;
  emojis: TCustomEmojiEntry[];
};

/**
 * ONE stable category object for the whole app, mutated in place.
 *
 * emoji-mart snapshots its category list into a module-global
 * (Data.originalCategories) on the very first init after page load, and —
 * whenever a `categories` ordering is supplied (we supply one to put server
 * emojis under Frequent) — rebuilds the visible grid from that snapshot on
 * every later init. Passing a fresh category object per render therefore
 * shows a stale emoji list until a full page reload. Because the snapshot
 * holds our object BY REFERENCE, keeping one identity and updating its
 * `emojis` array is what makes newly added server emojis appear live.
 */
const SERVER_EMOJI_CATEGORY: TCustomCategory = {
  id: 'server-emojis',
  name: 'Server Emojis',
  emojis: []
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
      SERVER_EMOJI_CATEGORY.emojis = customEmojis.map((e) => ({
        id: e.name,
        name: e.name,
        keywords: [e.name, 'custom'],
        skins: [{ src: e.fallbackImage }]
      }));

      // Keep emoji-mart's frozen category snapshot in sync with the
      // singleton (see SERVER_EMOJI_CATEGORY). Handles the edge where the
      // first-ever picker init ran with zero server emojis — emoji-mart
      // skips empty custom categories, so the snapshot never learned about
      // ours and later inits would drop it forever.
      const snapshot = (
        emojiMartData as { originalCategories?: TCustomCategory[] } | null
      )?.originalCategories;
      if (snapshot) {
        const index = snapshot.indexOf(SERVER_EMOJI_CATEGORY);
        if (SERVER_EMOJI_CATEGORY.emojis.length > 0 && index === -1) {
          snapshot.push(SERVER_EMOJI_CATEGORY);
        } else if (SERVER_EMOJI_CATEGORY.emojis.length === 0 && index !== -1) {
          snapshot.splice(index, 1);
        }
      }

      return SERVER_EMOJI_CATEGORY.emojis.length > 0
        ? [SERVER_EMOJI_CATEGORY]
        : [];
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
        categories={[
          'frequent',
          'server-emojis',
          'people',
          'nature',
          'foods',
          'activity',
          'places',
          'objects',
          'symbols',
          'flags'
        ]}
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

export { EmojiPickerPanel };

import type { TEmojiItem } from '@/components/tiptap-input/types';
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@/components/ui/popover';
import { LazyFallback } from '@/components/lazy-fallback';
import { lazy, memo, Suspense, useCallback, useState } from 'react';

type TEmojiPickerProps = {
  children: React.ReactNode;
  onEmojiSelect: (emoji: TEmojiItem) => void;
};

type TEmojiPickerPanelProps = {
  onEmojiSelect: (emoji: TEmojiItem) => void;
};

const Panel = lazy(() =>
  import('./panel').then((m) => ({ default: m.EmojiPickerPanel }))
);

// emoji-mart's own panel footprint, so the popover holds its final
// size while the chunk loads instead of growing from nothing.
const PANEL_SIZE_CLASS = 'h-[435px] w-[352px]';

/**
 * The bare emoji picker panel (custom-emoji category + theme wiring),
 * decoupled from any Popover. Use this directly when the picker must be
 * hosted by an overlay the parent already owns — e.g. opened FROM a
 * context/dropdown menu, where nesting a second Popover inside the menu
 * makes the menu's dismiss layer tear the picker down on hover/focus.
 *
 * The implementation (and the emoji dataset) lives in ./panel and is
 * fetched on first open; nothing on the way to the first message
 * needs it.
 */
const EmojiPickerPanel = memo(({ onEmojiSelect }: TEmojiPickerPanelProps) => (
  <Suspense
    fallback={
      <LazyFallback
        className={`${PANEL_SIZE_CLASS} rounded-lg border border-border bg-popover`}
      />
    }
  >
    <Panel onEmojiSelect={onEmojiSelect} />
  </Suspense>
));

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

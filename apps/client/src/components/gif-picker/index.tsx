import { LazyFallback } from '@/components/lazy-fallback';
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@/components/ui/popover';
import { lazy, memo, Suspense, useCallback, useState } from 'react';

type TGifPickerProps = {
  children: React.ReactNode;
  onSelect: (gifUrl: string) => void;
};

// The search + grid lives in ./panel and is fetched the first time a
// picker opens; the trigger shell here is all the composer needs.
const Panel = lazy(() =>
  import('./panel').then((m) => ({ default: m.GifPickerPanel }))
);

const GifPicker = memo(({ children, onSelect }: TGifPickerProps) => {
  const [open, setOpen] = useState(false);

  const handleSelect = useCallback(
    (gifUrl: string) => {
      onSelect(gifUrl);
      setOpen(false);
    },
    [onSelect]
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-[420px] p-0"
      >
        <Suspense fallback={<LazyFallback className="h-[200px]" />}>
          <Panel onSelect={handleSelect} />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
});

export { GifPicker };

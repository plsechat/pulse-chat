import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@/components/ui/popover';
import Spinner from '@/components/ui/spinner';
import {
  searchGifs,
  trendingGifs,
  type TGiphyGif
} from '@/helpers/giphy';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

type TGifPickerProps = {
  children: React.ReactNode;
  onSelect: (gifUrl: string) => void;
};

const GifPicker = memo(({ children, onSelect }: TGifPickerProps) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState<TGiphyGif[]>([]);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchGifs = useCallback(
    async (searchQuery: string, newOffset: number, append = false) => {
      setLoading(true);

      try {
        const result = searchQuery.trim()
          ? await searchGifs(searchQuery, newOffset)
          : await trendingGifs(newOffset);

        const newGifs = result.data ?? [];

        setGifs((prev) => (append ? [...prev, ...newGifs] : newGifs));
        setOffset(newOffset + newGifs.length);
        setHasMore(newGifs.length === 20);
      } catch {
        // ignore API errors
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (!open) return;

    setGifs([]);
    setOffset(0);
    setHasMore(true);
    fetchGifs('', 0);
  }, [open, fetchGifs]);

  useEffect(() => {
    if (!open) return;

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      setGifs([]);
      setOffset(0);
      setHasMore(true);
      fetchGifs(query, 0);
    }, 300);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [query, open, fetchGifs]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || loading || !hasMore) return;

    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 100) {
      fetchGifs(query, offset, true);
    }
  }, [loading, hasMore, query, offset, fetchGifs]);

  const handleSelect = useCallback(
    (gif: TGiphyGif) => {
      onSelect(gif.images.original.url);
      setOpen(false);
      setQuery('');
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
        <div className="flex flex-col">
          <div className="p-3 pb-2">
            <Input
              placeholder="Search GIFs..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          </div>

          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="overflow-y-auto px-3 pb-2"
            style={{ maxHeight: '360px' }}
          >
            {gifs.length === 0 && !loading && (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                {query ? 'No GIFs found' : 'Loading...'}
              </div>
            )}

            <div className="grid grid-cols-2 gap-1.5">
              {gifs.map((gif) => (
                <button
                  key={gif.id}
                  type="button"
                  className="relative overflow-hidden rounded-md hover:opacity-80 transition-opacity cursor-pointer bg-muted"
                  style={{
                    aspectRatio: `${gif.images.fixed_width.width} / ${gif.images.fixed_width.height}`
                  }}
                  onClick={() => handleSelect(gif)}
                >
                  <img
                    src={gif.images.fixed_width.url}
                    alt={gif.title}
                    loading="lazy"
                    className="w-full h-full object-cover"
                  />
                </button>
              ))}
            </div>

            {loading && (
              <div className="flex justify-center py-4">
                <Spinner size="sm" />
              </div>
            )}
          </div>

          <div className="px-3 py-1.5 border-t text-[10px] text-muted-foreground text-center">
            Powered by GIPHY
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
});

export { GifPicker };

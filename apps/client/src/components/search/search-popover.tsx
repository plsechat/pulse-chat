import { PopoverPanelShell } from '@/components/chat-primitives/popover-panel-shell';
import { Button } from '@/components/ui/button';
import { setSelectedChannelId } from '@/features/server/channels/actions';
import { getTRPCClient } from '@/lib/trpc';
import type { TJoinedMessage } from '@pulse/shared';
import { Loader2, Search } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { SearchFilters, type TSearchFilters } from './search-filters';
import { SearchResult } from './search-result';

type TSearchPopoverProps = {
  onClose: () => void;
};

const SearchPopover = memo(({ onClose }: TSearchPopoverProps) => {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<TSearchFilters>({});
  const [results, setResults] = useState<TJoinedMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const performSearch = useCallback(
    async (searchQuery: string, searchFilters: TSearchFilters, cursor?: number) => {
      if (!searchQuery.trim()) {
        setResults([]);
        setSearched(false);
        setNextCursor(null);
        return;
      }

      setLoading(true);

      try {
        const trpc = getTRPCClient();
        if (!trpc) return;
        const result = await trpc.search.messages.query({
          query: searchQuery.trim(),
          channelId: searchFilters.channelId,
          userId: searchFilters.userId,
          hasFile: searchFilters.hasFile,
          hasLink: searchFilters.hasLink,
          cursor: cursor ?? undefined,
          limit: 25
        });

        if (cursor) {
          setResults((prev) => [...prev, ...result.messages]);
        } else {
          setResults(result.messages);
        }

        setNextCursor(result.nextCursor);
        setSearched(true);
      } catch {
        // Search failed silently
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const onQueryChange = useCallback(
    (value: string) => {
      setQuery(value);

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      debounceRef.current = setTimeout(() => {
        performSearch(value, filters);
      }, 300);
    },
    [filters, performSearch]
  );

  const onFiltersChange = useCallback(
    (newFilters: TSearchFilters) => {
      setFilters(newFilters);

      if (query.trim()) {
        performSearch(query, newFilters);
      }
    },
    [query, performSearch]
  );

  const onJump = useCallback(
    (channelId: number, _messageId: number) => {
      setSelectedChannelId(channelId);
      onClose();
    },
    [onClose]
  );

  const onLoadMore = useCallback(() => {
    if (nextCursor && !loading) {
      performSearch(query, filters, nextCursor);
    }
  }, [nextCursor, loading, query, filters, performSearch]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }

      if (e.key === 'Enter') {
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
        }

        performSearch(query, filters);
      }
    },
    [onClose, query, filters, performSearch]
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  // Cross-channel search needs a wider, taller popover than the
  // pinned-messages one. Keep the shell's animation + chrome so it
  // still reads as the same family of surfaces, just sized up.
  const customHeader = (
    <div className="flex items-center gap-2 flex-1 min-w-0">
      <Search className="w-4 h-4 text-muted-foreground shrink-0" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search messages..."
        className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
      />
      {loading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
    </div>
  );

  const showStartHint = !searched && !loading && results.length === 0;
  const showNoResults = searched && !loading && results.length === 0;

  return (
    <PopoverPanelShell
      customHeader={customHeader}
      onClose={onClose}
      className="w-[28rem] max-h-[32rem]"
      toolbar={
        <div className="p-2 border-b border-border/20">
          <SearchFilters filters={filters} onFiltersChange={onFiltersChange} />
        </div>
      }
      footer={
        nextCursor && !loading ? (
          <div className="p-2 text-center border-t border-border/20">
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              onClick={onLoadMore}
            >
              Load more results
            </Button>
          </div>
        ) : undefined
      }
    >
      {showStartHint && (
        <div className="p-6 text-center text-sm text-muted-foreground">
          <Search className="mx-auto mb-2 h-8 w-8 opacity-40" />
          <p>Start typing to search messages</p>
        </div>
      )}

      {showNoResults && (
        <div className="p-6 text-center text-sm text-muted-foreground">
          <Search className="mx-auto mb-2 h-8 w-8 opacity-40" />
          <p>No messages found</p>
          <p className="text-xs mt-1">Try a different search term</p>
        </div>
      )}

      {results.map((message) => (
        <SearchResult
          key={message.id}
          message={message}
          query={query}
          onJump={onJump}
        />
      ))}
    </PopoverPanelShell>
  );
});

export { SearchPopover };

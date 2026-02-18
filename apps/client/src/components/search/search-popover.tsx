import { setSelectedChannelId } from '@/features/server/channels/actions';
import { getTRPCClient } from '@/lib/trpc';
import type { TJoinedMessage } from '@pulse/shared';
import { Loader2, Search, X } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../ui/button';
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

  return (
    <div className="absolute right-0 top-full mt-1 z-50 w-[28rem] rounded-lg border border-border bg-popover shadow-lg flex flex-col max-h-[32rem]">
      {/* Header */}
      <div className="flex items-center gap-2 p-3 border-b border-border/30">
        <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
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
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={onClose}>
          <X className="w-3 h-3" />
        </Button>
      </div>

      {/* Filters */}
      <div className="p-2 border-b border-border/20">
        <SearchFilters filters={filters} onFiltersChange={onFiltersChange} />
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        {!searched && !loading && (
          <div className="p-6 text-center text-sm text-muted-foreground">
            <Search className="mx-auto mb-2 h-8 w-8 opacity-40" />
            <p>Start typing to search messages</p>
          </div>
        )}

        {searched && results.length === 0 && !loading && (
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

        {nextCursor && !loading && (
          <div className="p-2 text-center">
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              onClick={onLoadMore}
            >
              Load more results
            </Button>
          </div>
        )}
      </div>
    </div>
  );
});

export { SearchPopover };

import { serializer } from '@/components/channel-view/text/renderer/serializer';
import { UserAvatar } from '@/components/user-avatar';
import { useUserById } from '@/features/server/users/hooks';
import { getTRPCClient } from '@/lib/trpc';
import type { TJoinedDmMessage } from '@pulse/shared';
import { longDateTime } from '@/helpers/time-format';
import { format } from 'date-fns';
import parse from 'html-react-parser';
import { Loader2, Search, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

type TDmSearchPopoverProps = {
  dmChannelId: number;
  onClose: () => void;
};

const DmSearchResult = memo(
  ({ message, query: _query }: { message: TJoinedDmMessage; query: string }) => {
    const user = useUserById(message.userId);

    const messageHtml = useMemo(() => {
      return parse(message.content ?? '', {
        replace: (domNode) => serializer(domNode, () => {})
      });
    }, [message.content]);

    return (
      <div className="p-3 border-b border-border/30 last:border-b-0 hover:bg-secondary/30">
        <div className="flex items-center gap-2 mb-1">
          <UserAvatar userId={message.userId} className="h-5 w-5" />
          <span className="text-sm font-medium">
            {user?.name ?? 'Unknown'}
          </span>
          <span className="text-xs text-muted-foreground">
            {format(new Date(message.createdAt), longDateTime())}
          </span>
        </div>
        <div className="pl-7 text-sm msg-content">
          {message.content ? messageHtml : null}
        </div>
      </div>
    );
  }
);

const DmSearchPopover = memo(
  ({ dmChannelId, onClose }: TDmSearchPopoverProps) => {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<TJoinedDmMessage[]>([]);
    const [loading, setLoading] = useState(false);
    const [searched, setSearched] = useState(false);
    const [nextCursor, setNextCursor] = useState<number | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    useEffect(() => {
      inputRef.current?.focus();
    }, []);

    const performSearch = useCallback(
      async (searchQuery: string, cursor?: number) => {
        if (!searchQuery.trim()) {
          setResults([]);
          setSearched(false);
          setNextCursor(null);
          return;
        }

        setLoading(true);

        try {
          const trpc = getTRPCClient();
          const result = await trpc.dms.searchMessages.query({
            query: searchQuery.trim(),
            dmChannelId,
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
      [dmChannelId]
    );

    const onQueryChange = useCallback(
      (value: string) => {
        setQuery(value);

        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
        }

        debounceRef.current = setTimeout(() => {
          performSearch(value);
        }, 300);
      },
      [performSearch]
    );

    const onLoadMore = useCallback(() => {
      if (nextCursor && !loading) {
        performSearch(query, nextCursor);
      }
    }, [nextCursor, loading, query, performSearch]);

    const onKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
          onClose();
        }

        if (e.key === 'Enter') {
          if (debounceRef.current) {
            clearTimeout(debounceRef.current);
          }

          performSearch(query);
        }
      },
      [onClose, query, performSearch]
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
          {loading && (
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={onClose}
          >
            <X className="w-3 h-3" />
          </Button>
        </div>

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
            <DmSearchResult
              key={message.id}
              message={message}
              query={query}
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
  }
);

export { DmSearchPopover };

import { serializer } from '@/components/channel-view/text/renderer/serializer';
import { PopoverPanelShell } from '@/components/chat-primitives/popover-panel-shell';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/user-avatar';
import { useUserById } from '@/features/server/users/hooks';
import { longDateTime } from '@/helpers/time-format';
import { getHomeTRPCClient } from '@/lib/trpc';
import type { TJoinedDmMessage } from '@pulse/shared';
import { format } from 'date-fns';
import parse from 'html-react-parser';
import { Loader2, Search } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
          const trpc = getHomeTRPCClient();
          if (!trpc) {
            setLoading(false);
            return;
          }
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
        {loading && (
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        )}
      </div>
    );

    const showStartHint = !searched && !loading && results.length === 0;
    const showNoResults = searched && !loading && results.length === 0;

    return (
      <PopoverPanelShell
        customHeader={customHeader}
        onClose={onClose}
        className="w-[28rem] max-h-[32rem]"
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
          <DmSearchResult key={message.id} message={message} query={query} />
        ))}
      </PopoverPanelShell>
    );
  }
);

export { DmSearchPopover };

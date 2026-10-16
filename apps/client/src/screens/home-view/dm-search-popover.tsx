import { ChatMessageBody } from '@/components/chat-primitives/message-body';
import { PopoverPanelShell } from '@/components/chat-primitives/popover-panel-shell';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/user-avatar';
import { decryptDmMessages } from '@/features/dms/actions';
import { useDmChannels } from '@/features/dms/hooks';
import { dmMessagesSelector } from '@/features/dms/selectors';
import { useHomeUserById } from '@/features/server/users/hooks';
import type { IRootState } from '@/features/store';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { longDateTime } from '@/helpers/time-format';
import { getHomeTRPCClient } from '@/lib/trpc';
import type { TJoinedDmMessage } from '@pulse/server/types';
import { format } from 'date-fns';
import { Loader2, Lock, Search } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { toast } from 'sonner';
import { appendDmSearchHits, matchDmMessages } from './dm-search-match';

type TDmSearchPopoverProps = {
  dmChannelId: number;
  onClose: () => void;
};

/**
 * Encrypted conversations are searched on this device (see
 * dm-search-match.ts): one round walks the loaded window plus this many
 * older history pages (50 messages each, resolved through the plaintext
 * caches), and "Search older messages" continues from where it stopped.
 * 300 messages matches the live message-window cap.
 */
const LOCAL_PAGES_PER_ROUND = 6;

const DmSearchResult = memo(
  ({ message }: { message: TJoinedDmMessage }) => {
    // HOME-space id — see dm-pin-banner.
    const user = useHomeUserById(message.userId);

    return (
      <div className="p-3 border-b border-border/30 last:border-b-0 hover:bg-secondary/30">
        <div className="flex items-center gap-2 mb-1">
          <UserAvatar userId={message.userId} className="h-5 w-5" homeScope />
          <span className="text-sm font-medium">
            {user?.name ?? 'Unknown'}
          </span>
          <span className="text-xs text-muted-foreground">
            {format(new Date(message.createdAt), longDateTime())}
          </span>
        </div>
        <div className="pl-7 text-sm">
          {/* Shared sanitize/tokenize pipeline — never an HTML parse of
              raw content here (audit A8-16). */}
          <ChatMessageBody message={message} homeScope compact />
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
    // Monotonic token so a slow older search can't overwrite a newer one.
    const searchSeqRef = useRef(0);

    const dmChannels = useDmChannels();
    const isE2ee = useMemo(
      () => dmChannels.find((c) => c.id === dmChannelId)?.e2ee ?? false,
      [dmChannels, dmChannelId]
    );

    // The decrypted window this conversation currently shows; read
    // through a ref so an in-flight search sees the latest decrypts.
    const loadedMessages = useSelector((state: IRootState) =>
      dmMessagesSelector(state, dmChannelId)
    );
    const loadedRef = useRef(loadedMessages);
    loadedRef.current = loadedMessages;

    useEffect(() => {
      inputRef.current?.focus();
    }, []);

    /**
     * Encrypted DM: the server cannot see plaintext, so match on this
     * device. First round = the loaded window, then older pages from
     * below it; each page is resolved through `decryptDmMessages` (the
     * IDB plaintext caches first, the ratchet/chain where it still
     * can). A continuation (`cursor`) resumes paging from there.
     */
    const searchLocally = useCallback(
      async (searchQuery: string, cursor: number | undefined, seq: number) => {
        const trpc = getHomeTRPCClient();
        if (!trpc) return;

        let hits: TJoinedDmMessage[] = [];
        let pageCursor: number | null | undefined = cursor;
        if (cursor === undefined) {
          const loaded = loadedRef.current;
          hits = matchDmMessages(loaded, searchQuery);
          pageCursor = loaded[0]?.createdAt ?? undefined;
          setResults(hits);
          setSearched(true);
        }

        let pages = 0;
        while (pages < LOCAL_PAGES_PER_ROUND) {
          // Pages older than `pageCursor` (newest first); undefined means
          // the latest page — only when nothing is loaded at all.
          const page: { messages: TJoinedDmMessage[]; nextCursor: number | null } =
            await trpc.dms.getMessages.query({
              dmChannelId,
              cursor: pageCursor ?? undefined
            });
          const decrypted = await decryptDmMessages(page.messages);
          if (seq !== searchSeqRef.current) return;
          hits = appendDmSearchHits(hits, matchDmMessages(decrypted, searchQuery));
          setResults((prev) =>
            cursor === undefined ? hits : appendDmSearchHits(prev, hits)
          );
          setSearched(true);
          pages++;
          pageCursor = page.nextCursor;
          if (pageCursor == null) break;
        }

        setNextCursor(pageCursor ?? null);
      },
      [dmChannelId]
    );

    const performSearch = useCallback(
      async (searchQuery: string, cursor?: number) => {
        const seq = ++searchSeqRef.current;
        const trimmed = searchQuery.trim();
        if (!trimmed) {
          setResults([]);
          setSearched(false);
          setNextCursor(null);
          return;
        }

        setLoading(true);

        try {
          if (isE2ee) {
            await searchLocally(trimmed, cursor, seq);
            return;
          }

          const trpc = getHomeTRPCClient();
          if (!trpc) return;
          const result = await trpc.dms.searchMessages.query({
            query: trimmed,
            dmChannelId,
            cursor: cursor ?? undefined,
            limit: 25
          });
          if (seq !== searchSeqRef.current) return;

          if (cursor) {
            setResults((prev) => appendDmSearchHits(prev, result.messages));
          } else {
            setResults(result.messages);
          }

          setNextCursor(result.nextCursor);
          setSearched(true);
        } catch (err) {
          if (seq !== searchSeqRef.current) return;
          toast.error(getTrpcError(err, 'Search failed'));
        } finally {
          if (seq === searchSeqRef.current) setLoading(false);
        }
      },
      [dmChannelId, isE2ee, searchLocally]
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
          aria-label="Search messages"
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
        className="w-[min(28rem,calc(100vw-1rem))] max-h-[32rem]"
        footer={
          nextCursor && !loading ? (
            <div className="p-2 text-center border-t border-border/20">
              <Button
                variant="ghost"
                size="sm"
                className="text-xs"
                onClick={onLoadMore}
              >
                {isE2ee ? 'Search older messages' : 'Load more results'}
              </Button>
            </div>
          ) : undefined
        }
      >
        {isE2ee && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-muted-foreground border-b border-border/20 bg-muted/30">
            <Lock className="h-3 w-3 text-emerald-500 shrink-0" />
            <span>
              Encrypted conversation: searching messages loaded on this device
            </span>
          </div>
        )}

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
          <DmSearchResult key={message.id} message={message} />
        ))}
      </PopoverPanelShell>
    );
  }
);

export { DmSearchPopover };

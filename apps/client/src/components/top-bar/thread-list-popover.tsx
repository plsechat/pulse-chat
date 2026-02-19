import { Button } from '@/components/ui/button';
import { setActiveThreadId } from '@/features/server/channels/actions';
import { useThreadsByParentChannelId } from '@/features/server/channels/hooks';
import { getTRPCClient } from '@/lib/trpc';
import { Archive, MessageSquare } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import type { IRootState } from '@/features/store';

type TThreadListPopoverProps = {
  channelId: number;
  onClose: () => void;
};

type TThreadItem = {
  id: number;
  name: string;
  messageCount: number;
  lastMessageAt: number | null;
  archived: boolean;
  parentChannelId: number;
  createdAt: number;
};

const ThreadListPopover = memo(
  ({ channelId, onClose }: TThreadListPopoverProps) => {
    const localThreads = useThreadsByParentChannelId(channelId);
    const [serverThreads, setServerThreads] = useState<TThreadItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [showArchived, setShowArchived] = useState(false);
    const channels = useSelector((s: IRootState) => s.server.channels);
    const mounted = useRef(false);

    const fetchThreads = useCallback(async () => {
      const trpc = getTRPCClient();

      try {
        const threads = await trpc.threads.getAll.query({
          channelId,
          includeArchived: showArchived
        });

        setServerThreads(threads);
      } catch {
        // Fall back to local data
      } finally {
        setLoading(false);
      }
    }, [channelId, showArchived]);

    useEffect(() => {
      fetchThreads();
    }, [fetchThreads]);

    // Refetch when channels change (threads are channels)
    useEffect(() => {
      if (!mounted.current) {
        mounted.current = true;
        return;
      }
      fetchThreads();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [channels]);

    // Refetch on custom threads-changed event (from thread subscriptions)
    useEffect(() => {
      const handler = () => { fetchThreads(); };
      window.addEventListener('threads-changed', handler);
      return () => window.removeEventListener('threads-changed', handler);
    }, [fetchThreads]);

    const threads = serverThreads.length > 0 ? serverThreads : localThreads.map((t) => ({
      id: t.id,
      name: t.name,
      messageCount: 0,
      lastMessageAt: null,
      archived: t.archived,
      parentChannelId: channelId,
      createdAt: t.createdAt
    }));

    const onThreadClick = useCallback(
      (threadId: number) => {
        setActiveThreadId(threadId);
        onClose();
      },
      [onClose]
    );

    return (
      <div className="absolute right-0 top-full mt-1 w-72 bg-popover border border-border rounded-lg shadow-lg z-50 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
          <span className="text-sm font-medium">Threads</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setShowArchived(!showArchived)}
          >
            <Archive className="w-3 h-3 mr-1" />
            {showArchived ? 'Hide Archived' : 'Show Archived'}
          </Button>
        </div>
        <div className="max-h-64 overflow-y-auto">
          {loading ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              Loading...
            </div>
          ) : threads.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              No threads yet
            </div>
          ) : (
            threads.map((thread) => (
              <button
                key={thread.id}
                type="button"
                onClick={() => onThreadClick(thread.id)}
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-accent/50 transition-colors text-left"
              >
                <MessageSquare className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {thread.name}
                    {thread.archived && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        (archived)
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {thread.messageCount} message
                    {thread.messageCount !== 1 ? 's' : ''}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    );
  }
);

export { ThreadListPopover };

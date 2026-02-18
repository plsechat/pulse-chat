import { Button } from '@/components/ui/button';
import Spinner from '@/components/ui/spinner';
import { setActiveThreadId } from '@/features/server/channels/actions';
import { useCan } from '@/features/server/hooks';
import { getTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { Permission } from '@pulse/shared';
import { ArrowDownUp, Plus } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { CreateForumPostDialog } from './create-forum-post-dialog';
import { ForumPostCard } from './forum-post-card';

type TForumChannelProps = {
  channelId: number;
};

type TForumThread = {
  id: number;
  name: string;
  messageCount: number;
  lastMessageAt: number | null;
  archived: boolean;
  parentChannelId: number;
  createdAt: number;
  creatorId?: number;
  tags?: { id: number; name: string; color: string }[];
};

type TForumTag = {
  id: number;
  name: string;
  color: string;
};

const ForumChannel = memo(({ channelId }: TForumChannelProps) => {
  const [threads, setThreads] = useState<TForumThread[]>([]);
  const [tags, setTags] = useState<TForumTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [sortBy, setSortBy] = useState<'latest' | 'creation'>('latest');
  const [activeTagFilter, setActiveTagFilter] = useState<number | null>(null);
  const [showArchived, _setShowArchived] = useState(false);
  const can = useCan();

  const fetchData = useCallback(async () => {
    const trpc = getTRPCClient();

    try {
      const [threadsResult, tagsResult] = await Promise.all([
        trpc.threads.getAll.query({
          channelId,
          includeArchived: showArchived
        }),
        trpc.threads.getForumTags.query({ channelId })
      ]);

      setThreads(threadsResult);
      setTags(tagsResult);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [channelId, showArchived]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const sortedThreads = useMemo(() => {
    const filtered = activeTagFilter
      ? threads.filter((t) => t.tags?.some((tag) => tag.id === activeTagFilter))
      : threads;

    return [...filtered].sort((a, b) => {
      if (sortBy === 'latest') {
        const aTime = a.lastMessageAt ?? a.createdAt;
        const bTime = b.lastMessageAt ?? b.createdAt;
        return bTime - aTime;
      }

      return b.createdAt - a.createdAt;
    });
  }, [threads, sortBy, activeTagFilter]);

  const onPostClick = useCallback((threadId: number) => {
    setActiveThreadId(threadId);
  }, []);

  const onPostCreated = useCallback(() => {
    setShowCreateDialog(false);
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Spinner size="sm" />
      </div>
    );
  }

  return (
    <>
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/30">
          {can(Permission.SEND_MESSAGES) && (
            <Button
              size="sm"
              onClick={() => setShowCreateDialog(true)}
              className="gap-1"
            >
              <Plus className="w-4 h-4" />
              New Post
            </Button>
          )}

          <div className="flex items-center gap-1 ml-auto">
            {tags.length > 0 && (
              <div className="flex items-center gap-1 mr-2">
                <button
                  type="button"
                  onClick={() => setActiveTagFilter(null)}
                  className={cn(
                    'px-2 py-1 rounded text-xs transition-colors',
                    !activeTagFilter
                      ? 'bg-primary/20 text-primary'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  All
                </button>
                {tags.map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() =>
                      setActiveTagFilter(
                        activeTagFilter === tag.id ? null : tag.id
                      )
                    }
                    className="px-2 py-1 rounded text-xs font-medium transition-colors"
                    style={{
                      backgroundColor:
                        activeTagFilter === tag.id
                          ? `${tag.color}30`
                          : 'transparent',
                      color:
                        activeTagFilter === tag.id
                          ? tag.color
                          : 'var(--muted-foreground)'
                    }}
                  >
                    {tag.name}
                  </button>
                ))}
              </div>
            )}

            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 gap-1 text-xs"
              onClick={() =>
                setSortBy(sortBy === 'latest' ? 'creation' : 'latest')
              }
            >
              <ArrowDownUp className="w-3 h-3" />
              {sortBy === 'latest' ? 'Latest Activity' : 'Creation Date'}
            </Button>
          </div>
        </div>

        {/* Post list */}
        <div className="flex-1 overflow-y-auto p-4">
          {sortedThreads.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <p className="text-sm">No posts yet</p>
              {can(Permission.SEND_MESSAGES) && (
                <p className="text-xs mt-1">
                  Be the first to start a discussion
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-2 max-w-2xl mx-auto">
              {sortedThreads.map((thread) => (
                <ForumPostCard
                  key={thread.id}
                  thread={thread}
                  onClick={onPostClick}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {showCreateDialog && (
        <CreateForumPostDialog
          channelId={channelId}
          onClose={onPostCreated}
        />
      )}
    </>
  );
});

export { ForumChannel };

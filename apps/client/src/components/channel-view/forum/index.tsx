import { Button } from '@/components/ui/button';
import Spinner from '@/components/ui/spinner';
import {
  setActiveThreadId
} from '@/features/server/channels/actions';
import { useActiveThreadId } from '@/features/server/channels/hooks';
import { useCan } from '@/features/server/hooks';
import { useMessagesByChannelId } from '@/features/server/messages/hooks';
import { getTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { Permission } from '@pulse/shared';
import { ArrowDownUp, MessageSquareText, Search, Tags } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CreateForumPostDialog } from './create-forum-post-dialog';
import { EditPostTagsDialog } from './edit-post-tags-dialog';
import { ForumPostCard } from './forum-post-card';
import { ForumPostMenu } from './forum-post-context-menu';
import { ManageTagsDialog } from './manage-tags-dialog';

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
  creatorName?: string;
  creatorAvatarId?: number | null;
  contentPreview?: string;
  firstImage?: string;
  tags?: { id: number; name: string; color: string }[];
  reactions?: { emoji: string; count: number }[];
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
  const [showManageTags, setShowManageTags] = useState(false);
  const [editTagsInfo, setEditTagsInfo] = useState<{ threadId: number; currentTagIds: number[] } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const activeThreadId = useActiveThreadId();
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

      setThreads(threadsResult as TForumThread[]);
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

  // Listen for real-time thread updates (create/delete/tag changes)
  useEffect(() => {
    const handler = () => {
      fetchData();
    };
    window.addEventListener('threads-changed', handler);
    return () => window.removeEventListener('threads-changed', handler);
  }, [fetchData]);

  // Sync live reaction data from Redux for the active thread
  const activeMessages = useMessagesByChannelId(activeThreadId ?? 0);

  useEffect(() => {
    if (!activeThreadId || activeMessages.length === 0) return;

    const firstMsg = activeMessages[0];
    const reactionMap = new Map<string, number>();

    for (const r of firstMsg.reactions) {
      reactionMap.set(r.emoji, (reactionMap.get(r.emoji) ?? 0) + 1);
    }

    const liveReactions = [...reactionMap.entries()].map(([emoji, count]) => ({
      emoji,
      count
    }));

    setThreads((prev) =>
      prev.map((t) =>
        t.id === activeThreadId ? { ...t, reactions: liveReactions } : t
      )
    );
  }, [activeThreadId, activeMessages]);

  const sortedThreads = useMemo(() => {
    let filtered = activeTagFilter
      ? threads.filter((t) => t.tags?.some((tag) => tag.id === activeTagFilter))
      : threads;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.contentPreview?.toLowerCase().includes(q) ||
          t.creatorName?.toLowerCase().includes(q)
      );
    }

    return [...filtered].sort((a, b) => {
      if (sortBy === 'latest') {
        const aTime = a.lastMessageAt ?? a.createdAt;
        const bTime = b.lastMessageAt ?? b.createdAt;
        return bTime - aTime;
      }

      return b.createdAt - a.createdAt;
    });
  }, [threads, sortBy, activeTagFilter, searchQuery]);

  const onPostClick = useCallback((threadId: number) => {
    setActiveThreadId(threadId);
  }, []);

  const onPostCreated = useCallback(() => {
    setShowCreateDialog(false);
    fetchData();
  }, [fetchData]);

  const onManageTagsClose = useCallback(() => {
    setShowManageTags(false);
    fetchData();
  }, [fetchData]);

  const onEditTags = useCallback((threadId: number, currentTagIds: number[]) => {
    setEditTagsInfo({ threadId, currentTagIds });
  }, []);

  const onEditTagsClose = useCallback(() => {
    setEditTagsInfo(null);
    fetchData();
  }, [fetchData]);

  const onPostDeleted = useCallback(() => {
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
      <div
        className={cn(
          'flex flex-col overflow-hidden border-r border-border/30',
          activeThreadId ? 'w-[420px] flex-shrink-0' : 'flex-1'
        )}
      >
        {/* Search bar + New Post */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/30">
          <div className="flex-1 relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              ref={searchRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search posts..."
              className="w-full pl-8 pr-3 py-1.5 text-sm bg-muted/30 border border-border/50 rounded-md focus:outline-none focus:ring-1 focus:ring-primary/30"
            />
          </div>
          {can(Permission.SEND_MESSAGES) && (
            <Button
              size="sm"
              onClick={() => setShowCreateDialog(true)}
              className="gap-1 flex-shrink-0"
            >
              <MessageSquareText className="w-4 h-4" />
              New Post
            </Button>
          )}
        </div>

        {/* Sort & Tag filter bar */}
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border/30">
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

          {tags.length > 0 && (
            <div className="flex items-center gap-1 ml-auto">
              <button
                type="button"
                onClick={() => setActiveTagFilter(null)}
                className={cn(
                  'px-2 py-0.5 rounded text-xs transition-colors',
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
                  className="px-2 py-0.5 rounded text-xs font-medium transition-colors"
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

          {can(Permission.MANAGE_CHANNELS) && (
            <Button
              variant="ghost"
              size="sm"
              className={cn('h-7 px-2 gap-1 text-xs', !tags.length && 'ml-auto')}
              onClick={() => setShowManageTags(true)}
            >
              <Tags className="w-3 h-3" />
              Tags
            </Button>
          )}
        </div>

        {/* Post list */}
        <div className="flex-1 overflow-y-auto">
          {sortedThreads.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <p className="text-sm">
                {searchQuery.trim() ? 'No matching posts' : 'No posts yet'}
              </p>
              {!searchQuery.trim() && can(Permission.SEND_MESSAGES) && (
                <p className="text-xs mt-1">
                  Be the first to start a discussion
                </p>
              )}
            </div>
          ) : (
            <div className="flex flex-col">
              {sortedThreads.map((thread) => (
                <div key={thread.id} className="relative group">
                  <ForumPostCard
                    thread={thread}
                    isActive={activeThreadId === thread.id}
                    onClick={onPostClick}
                  />
                  <ForumPostMenu
                    threadId={thread.id}
                    threadName={thread.name}
                    creatorId={thread.creatorId}
                    currentTagIds={thread.tags?.map((t) => t.id) ?? []}
                    channelId={channelId}
                    onEditTags={onEditTags}
                    onPostDeleted={onPostDeleted}
                  />
                </div>
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

      {showManageTags && (
        <ManageTagsDialog
          channelId={channelId}
          onClose={onManageTagsClose}
        />
      )}

      {editTagsInfo && (
        <EditPostTagsDialog
          threadId={editTagsInfo.threadId}
          channelId={channelId}
          currentTagIds={editTagsInfo.currentTagIds}
          onClose={onEditTagsClose}
        />
      )}
    </>
  );
});

export { ForumChannel };

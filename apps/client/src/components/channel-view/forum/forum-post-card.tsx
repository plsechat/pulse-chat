import { UserAvatar } from '@/components/user-avatar';
import { getUrlFromServer } from '@/helpers/get-file-url';
import { cn } from '@/lib/utils';
import { Archive, MessageSquare } from 'lucide-react';
import { memo, useMemo } from 'react';

type TForumPostCardProps = {
  thread: {
    id: number;
    name: string;
    messageCount: number;
    lastMessageAt: number | null;
    archived: boolean;
    createdAt: number;
    creatorId?: number;
    creatorName?: string;
    creatorAvatarId?: number | null;
    contentPreview?: string;
    firstImage?: string;
    tags?: { id: number; name: string; color: string }[];
  };
  onClick: (threadId: number) => void;
};

const ForumPostCard = memo(({ thread, onClick }: TForumPostCardProps) => {
  const timeAgo = useMemo(() => {
    const ts = thread.lastMessageAt ?? thread.createdAt;
    const diff = Date.now() - ts;
    const minutes = Math.floor(diff / 60000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);

    if (hours < 24) return `${hours}h ago`;

    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }, [thread.lastMessageAt, thread.createdAt]);

  const thumbnailUrl = useMemo(() => {
    if (!thread.firstImage) return null;
    return `${getUrlFromServer()}/public/${thread.firstImage}`;
  }, [thread.firstImage]);

  // Subtract 1 for the original post message
  const replyCount = Math.max(0, thread.messageCount - 1);

  return (
    <button
      type="button"
      onClick={() => onClick(thread.id)}
      className={cn(
        'w-full text-left rounded-lg border border-border/50 hover:border-border hover:bg-accent/30 transition-all cursor-pointer overflow-hidden',
        thread.archived && 'opacity-60'
      )}
    >
      {/* Thumbnail image banner */}
      {thumbnailUrl && (
        <div className="h-40 w-full overflow-hidden bg-muted/20">
          <img
            src={thumbnailUrl}
            alt=""
            className="w-full h-full object-cover"
          />
        </div>
      )}

      <div className="p-3">
        {/* Title */}
        <div className="flex items-start gap-2">
          <h3 className="text-sm font-semibold leading-snug line-clamp-2">
            {thread.name}
          </h3>
          {thread.archived && (
            <Archive className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0 mt-0.5" />
          )}
        </div>

        {/* Content preview */}
        {thread.contentPreview && (
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
            {thread.contentPreview}
          </p>
        )}

        {/* Tags */}
        {thread.tags && thread.tags.length > 0 && (
          <div className="flex gap-1 mt-2 flex-wrap">
            {thread.tags.map((tag) => (
              <span
                key={tag.id}
                className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                style={{
                  backgroundColor: `${tag.color}20`,
                  color: tag.color
                }}
              >
                {tag.name}
              </span>
            ))}
          </div>
        )}

        {/* Footer: avatar, name, replies, time */}
        <div className="flex items-center gap-2 mt-2.5 text-xs text-muted-foreground">
          {thread.creatorId && (
            <div className="flex items-center gap-1.5">
              <UserAvatar
                userId={thread.creatorId}
                className="h-4 w-4"
                showStatusBadge={false}
              />
              <span className="font-medium text-foreground/80">
                {thread.creatorName ?? 'Unknown'}
              </span>
            </div>
          )}
          <span className="flex items-center gap-1">
            <MessageSquare className="w-3 h-3" />
            {replyCount}
          </span>
          <span>{timeAgo}</span>
        </div>
      </div>
    </button>
  );
});

export { ForumPostCard };

import { cn } from '@/lib/utils';
import { MessageSquare } from 'lucide-react';
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
  isActive?: boolean;
  onClick: (threadId: number) => void;
};

const ForumPostCard = memo(({ thread, isActive, onClick }: TForumPostCardProps) => {
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

  // Subtract 1 for the original post message
  const replyCount = Math.max(0, thread.messageCount - 1);

  return (
    <button
      type="button"
      onClick={() => onClick(thread.id)}
      className={cn(
        'w-full text-left px-3 py-2.5 border-b border-border/20 hover:bg-accent/30 transition-colors cursor-pointer',
        isActive && 'bg-accent/40',
        thread.archived && 'opacity-60'
      )}
    >
      {/* Title */}
      <h3 className="text-sm font-semibold truncate">{thread.name}</h3>

      {/* Username: content preview */}
      {(thread.creatorName || thread.contentPreview) && (
        <p className="text-xs mt-0.5 truncate">
          {thread.creatorName && (
            <span className="text-primary font-medium">
              {thread.creatorName}
            </span>
          )}
          {thread.creatorName && thread.contentPreview && (
            <span className="text-muted-foreground">: </span>
          )}
          {thread.contentPreview && (
            <span className="text-muted-foreground">
              {thread.contentPreview}
            </span>
          )}
        </p>
      )}

      {/* Footer: reply count + time */}
      <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <MessageSquare className="w-3 h-3" />
          {replyCount}
        </span>
        <span className="text-muted-foreground/60">&middot;</span>
        <span>{timeAgo}</span>
      </div>
    </button>
  );
});

export { ForumPostCard };

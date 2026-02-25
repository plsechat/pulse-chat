import {
  useMentionCount,
  useUnreadMessagesCount
} from '@/features/server/hooks';
import { cn } from '@/lib/utils';
import { gitHubEmojis } from '@tiptap/extension-emoji';
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
    reactions?: { emoji: string; count: number }[];
  };
  isActive?: boolean;
  onClick: (threadId: number) => void;
};

const resolveEmoji = (name: string): string => {
  const found = gitHubEmojis.find(
    (e) => e.name === name || e.shortcodes.includes(name)
  );
  return found?.emoji ?? `:${name}:`;
};

const ForumPostCard = memo(({ thread, isActive, onClick }: TForumPostCardProps) => {
  const unreadCount = useUnreadMessagesCount(thread.id);
  const mentionCount = useMentionCount(thread.id);
  const hasUnread = unreadCount > 0;
  const hasMentions = mentionCount > 0;

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

  const hasReactions = thread.reactions && thread.reactions.length > 0;

  return (
    <button
      type="button"
      onClick={() => onClick(thread.id)}
      className={cn(
        'w-full text-left px-3 py-2.5 border-b border-border/20 hover:bg-accent/30 transition-colors cursor-pointer',
        isActive && 'bg-accent/40',
        thread.archived && 'opacity-60',
        hasUnread && 'border-l-2 border-l-primary'
      )}
    >
      {/* Title + Tags */}
      <div className="flex items-center gap-2 pr-7">
        <h3 className="text-sm font-semibold truncate">{thread.name}</h3>
        {thread.tags && thread.tags.length > 0 && (
          <div className="flex items-center gap-1 shrink-0">
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
      </div>

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

      {/* Reactions */}
      {hasReactions && (
        <div className="flex items-center gap-1 mt-1.5 flex-wrap">
          {thread.reactions!.map((r) => (
            <span
              key={r.emoji}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-muted/40 text-xs"
            >
              <span className="text-sm">{resolveEmoji(r.emoji)}</span>
              <span className="text-muted-foreground">{r.count}</span>
            </span>
          ))}
        </div>
      )}

      {/* Footer: reply count + time + unread badge */}
      <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <MessageSquare className="w-3 h-3" />
          {replyCount}
        </span>
        <span className="text-muted-foreground/60">&middot;</span>
        <span>{timeAgo}</span>
        {hasUnread && (
          <div
            className={cn(
              'ml-auto flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium',
              hasMentions
                ? 'bg-destructive text-destructive-foreground'
                : 'bg-primary text-primary-foreground'
            )}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </div>
        )}
      </div>
    </button>
  );
});

export { ForumPostCard };

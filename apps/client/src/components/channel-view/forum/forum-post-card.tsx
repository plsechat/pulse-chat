import { useActiveInstanceDomain } from '@/features/app/hooks';
import {
  useMentionCount,
  useUnreadMessagesCount
} from '@/features/server/hooks';
import { reactionText } from '@/helpers/emoji-shortcode';
import { getPublicFileUrl } from '@/helpers/get-file-url';
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
    /** First image attached to the post; tokenized for private forums. */
    firstImage?: { name: string; _accessToken?: string };
    tags?: { id: number; name: string; color: string }[];
    reactions?: { emoji: string; count: number }[];
  };
  isActive?: boolean;
  onClick: (threadId: number) => void;
};

const resolveEmoji = (name: string): string => reactionText(name);

const ForumPostCard = memo(({ thread, isActive, onClick }: TForumPostCardProps) => {
  const unreadCount = useUnreadMessagesCount(thread.id);
  const mentionCount = useMentionCount(thread.id);
  const hasUnread = unreadCount > 0;
  const hasMentions = mentionCount > 0;
  // Files live on the instance that owns the forum (federated or home).
  const instanceDomain = useActiveInstanceDomain() ?? undefined;
  const thumbnailUrl = thread.firstImage
    ? getPublicFileUrl(
        thread.firstImage.name,
        instanceDomain,
        thread.firstImage._accessToken
      )
    : null;

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
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {/* Title + Tags */}
          <div className="flex items-center gap-2 pr-7">
            <h3 className="text-sm font-semibold truncate">{thread.name}</h3>
            {thread.archived && (
              <span className="shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider bg-muted text-muted-foreground">
                <Archive className="w-3 h-3" />
                Archived
              </span>
            )}
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
        </div>

        {/* First attached image, so an image post reads as one in the list */}
        {thumbnailUrl && (
          <img
            src={thumbnailUrl}
            alt=""
            loading="lazy"
            className="h-14 w-14 shrink-0 rounded-md object-cover border border-border/40 bg-muted/30"
          />
        )}
      </div>
    </button>
  );
});

export { ForumPostCard };

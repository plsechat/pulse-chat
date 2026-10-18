import { MessageErrorBoundary } from '@/components/chat-primitives/message-error-boundary';
import { Message } from '@/components/channel-view/text/message';
import { UserContextMenu } from '@/components/context-menus/user';
import { Tooltip } from '@/components/ui/tooltip';
import { UserAvatar } from '@/components/user-avatar';
import { UserPopover } from '@/components/user-popover';
import { useActiveThread } from '@/features/server/channels/hooks';
import { useUserDisplayRole } from '@/features/server/hooks';
import { useMessagesByChannelId } from '@/features/server/messages/hooks';
import { useUserById } from '@/features/server/users/hooks';
import { getDisplayName } from '@/helpers/get-display-name';
import { getNameStyleCss } from '@/helpers/name-style';
import { fullDateTime, groupTimestamp } from '@/helpers/time-format';
import { useNow } from '@/hooks/use-now';
import { useReadableRoleColor } from '@/hooks/use-readable-role-color';
import { cn } from '@/lib/utils';
import type { TJoinedMessage } from '@pulse/server/types';
import { format } from 'date-fns';
import { Archive } from 'lucide-react';
import { memo } from 'react';

type TForumPostBodyProps = {
  message: TJoinedMessage;
  onReply: (message: TJoinedMessage) => void;
};

/**
 * The opening message of a forum post, rendered as the post itself:
 * title, author line, then the body (content + attachment gallery +
 * reactions) — not a chat row with an "OP" badge. The body is the real
 * `Message` so edit, delete, react, pin and the context menu keep
 * working on it.
 */
const ForumPostBody = memo(({ message, onReply }: TForumPostBodyProps) => {
  const thread = useActiveThread();
  const user = useUserById(message.userId);
  const displayRole = useUserDisplayRole(message.userId);
  const nameColor = useReadableRoleColor(displayRole?.color);
  const nameCss = getNameStyleCss(user?.nameStyle);
  const now = useNow();
  const date = new Date(message.createdAt);
  const hasReplies = useMessagesByChannelId(message.channelId).length > 1;

  return (
    <>
      <div className="mx-3 md:mx-4 mt-3 mb-2 rounded-xl border border-border/40 bg-muted/15 overflow-hidden">
        <div className="px-5 pt-4 pb-3">
          <div className="flex items-start gap-2">
            <h1 className="text-xl font-bold leading-snug break-words min-w-0 flex-1">
              {thread?.name}
            </h1>
            {thread?.archived && (
              <span className="shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider bg-muted text-muted-foreground">
                <Archive className="w-3 h-3" />
                Archived
              </span>
            )}
          </div>
          {user && (
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <UserContextMenu userId={user.id}>
                <UserAvatar
                  userId={user.id}
                  className="squircle h-6 w-6"
                  showUserPopover
                />
              </UserContextMenu>
              <UserContextMenu userId={user.id}>
                <UserPopover userId={user.id}>
                  <span
                    className={cn(
                      'font-semibold text-foreground hover:underline cursor-pointer',
                      nameCss?.className
                    )}
                    style={
                      nameCss?.style ??
                      (nameColor ? { color: nameColor } : undefined)
                    }
                  >
                    {getDisplayName(user)}
                  </span>
                </UserPopover>
              </UserContextMenu>
              <span className="text-muted-foreground/60">&middot;</span>
              <Tooltip content={format(date, fullDateTime())}>
                <span className="cursor-default">
                  {groupTimestamp(date, new Date(now))}
                </span>
              </Tooltip>
            </div>
          )}
        </div>
  
        {/* `Message` lays itself out for the 64px avatar gutter of a chat
            group (negative left margin + matching padding). The wrapper
            cancels that so the text lines up with the title; the hover
            pill then overshoots the card's padding and is clipped by it. */}
        <div className="border-t border-border/30 px-5 pt-3 pb-4">
          <div className="relative -ml-11 pl-11 -mr-5 pr-11">
            <MessageErrorBoundary messageId={message.id}>
              <Message
                message={message}
                onReply={() => onReply(message)}
                isFirstInGroup
              />
            </MessageErrorBoundary>
          </div>
        </div>
      </div>

      {/* Everything after the post is a reply; label the boundary once
          there is at least one (the store holds the post + replies). */}
      {hasReplies && (
        <div className="mx-4 mt-3 mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 select-none">
          <span className="h-px flex-1 bg-border/40" />
          Replies
          <span className="h-px flex-1 bg-border/40" />
        </div>
      )}
    </>
  );
});

export { ForumPostBody };

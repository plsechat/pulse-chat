import { useCan } from '@/features/server/hooks';
import { useIsOwnUser, useUserById } from '@/features/server/users/hooks';
import type { IRootState } from '@/features/store';
import { cn } from '@/lib/utils';
import { Permission, type TJoinedMessage } from '@pulse/shared';
import { Pin, Reply } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { MessageActions } from './message-actions';
import { MessageEditInline } from './message-edit-inline';
import { MessageRenderer } from './renderer';
import { ThreadIndicator } from './thread-indicator';

type TMessageProps = {
  message: TJoinedMessage;
  onReply: () => void;
};

const ReplyPreview = memo(
  ({ replyTo }: { replyTo: { userId: number; content: string | null } }) => {
    const user = useUserById(replyTo.userId);
    const truncated = replyTo.content
      ? replyTo.content.replace(/<[^>]*>/g, '').slice(0, 100)
      : 'Message deleted';

    return (
      <div className="flex items-center gap-1 text-xs text-muted-foreground mb-0.5 pl-1">
        <Reply className="h-3 w-3 rotate-180" />
        <span className="font-semibold">{user?.name ?? 'Unknown'}</span>
        <span className="truncate max-w-[300px]">{truncated}</span>
      </div>
    );
  }
);

const Message = memo(({ message, onReply }: TMessageProps) => {
  const [isEditing, setIsEditing] = useState(false);
  const isFromOwnUser = useIsOwnUser(message.userId);
  const can = useCan();
  const highlightedId = useSelector(
    (s: IRootState) => s.server.highlightedMessageId
  );
  const isHighlighted = highlightedId === message.id;

  const canEdit = isFromOwnUser;
  const canDelete = useMemo(
    () => can(Permission.MANAGE_MESSAGES) || isFromOwnUser,
    [can, isFromOwnUser]
  );

  return (
    <div
      id={`msg-${message.id}`}
      className={cn(
        'min-w-0 flex-1 relative group leading-[1.375rem] hover:bg-foreground/[0.02] rounded',
        isHighlighted && 'animate-msg-highlight rounded'
      )}
    >
      {message.pinned && (
        <div className="flex items-center gap-1 text-xs text-yellow-500 mb-0.5 pl-1">
          <Pin className="w-3 h-3" />
          <span>Pinned</span>
        </div>
      )}
      {message.replyTo && <ReplyPreview replyTo={message.replyTo} />}
      {!isEditing ? (
        <>
          <MessageRenderer message={message} />
          {message.threadId && (
            <ThreadIndicator threadId={message.threadId} />
          )}
          <MessageActions
            onEdit={() => setIsEditing(true)}
            onReply={onReply}
            canEdit={canEdit}
            canDelete={canDelete}
            messageId={message.id}
            editable={message.editable ?? false}
            pinned={message.pinned ?? false}
            hasThread={!!message.threadId}
          />
        </>
      ) : (
        <MessageEditInline
          message={message}
          onBlur={() => setIsEditing(false)}
        />
      )}
    </div>
  );
});

export { Message };

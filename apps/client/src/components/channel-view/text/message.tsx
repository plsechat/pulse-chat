import { useCan } from '@/features/server/hooks';
import { setHighlightedMessageId } from '@/features/server/channels/actions';
import { useIsOwnUser, useUserById } from '@/features/server/users/hooks';
import type { IRootState } from '@/features/store';
import { getDisplayName } from '@/helpers/get-display-name';
import { cn } from '@/lib/utils';
import { Permission, type TJoinedMessage } from '@pulse/shared';
import { Pin, Reply } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { MessageActions } from './message-actions';
import { MessageContextMenu } from './message-context-menu';
import { MessageEditInline } from './message-edit-inline';
import { MessageRenderer } from './renderer';
import { useSelection } from './selection-context';
import { ThreadIndicator } from './thread-indicator';

type TMessageProps = {
  message: TJoinedMessage;
  onReply: () => void;
};

const ReplyPreview = memo(
  ({ replyTo }: { replyTo: { id: number; userId: number; content: string | null } }) => {
    const user = useUserById(replyTo.userId);
    const truncated = replyTo.content
      ? replyTo.content.replace(/<[^>]*>/g, '').slice(0, 100)
      : 'Message deleted';

    const scrollToOriginal = useCallback(() => {
      setHighlightedMessageId(replyTo.id);
      requestAnimationFrame(() => {
        const el = document.getElementById(`msg-${replyTo.id}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
      setTimeout(() => setHighlightedMessageId(undefined), 2500);
    }, [replyTo.id]);

    return (
      <button
        type="button"
        onClick={scrollToOriginal}
        className="flex items-center gap-1 text-xs text-muted-foreground mb-0.5 pl-1 hover:text-foreground transition-colors cursor-pointer"
      >
        <Reply className="h-3 w-3 rotate-180 shrink-0" />
        <span className="font-semibold shrink-0">{getDisplayName(user)}</span>
        <span className="truncate max-w-[300px]">{truncated}</span>
      </button>
    );
  }
);

const Message = memo(({ message, onReply }: TMessageProps) => {
  const [isEditing, setIsEditing] = useState(false);
  const isFromOwnUser = useIsOwnUser(message.userId);
  const can = useCan();
  const { selectionMode, selectedIds, handleSelect } = useSelection();
  const highlightedId = useSelector(
    (s: IRootState) => s.server.highlightedMessageId
  );
  const isHighlighted = highlightedId === message.id;
  const isSelected = selectedIds.has(message.id);

  const canEdit = isFromOwnUser;
  const canDelete = useMemo(
    () => can(Permission.MANAGE_MESSAGES) || isFromOwnUser,
    [can, isFromOwnUser]
  );

  const onSelectionClick = useCallback(
    (e: React.MouseEvent) => {
      if (!selectionMode) return;
      handleSelect(message.id, {
        shift: e.shiftKey,
        ctrl: e.ctrlKey || e.metaKey
      });
    },
    [selectionMode, handleSelect, message.id]
  );

  return (
    <MessageContextMenu
      messageId={message.id}
      messageContent={message.content}
      channelId={message.channelId}
      onEdit={() => setIsEditing(true)}
      onReply={onReply}
      canEdit={canEdit}
      canDelete={canDelete}
      editable={message.editable ?? false}
      pinned={message.pinned ?? false}
      hasThread={!!message.threadId}
    >
      <div
        id={`msg-${message.id}`}
        className={cn(
          'min-w-0 flex-1 relative group leading-[1.375rem] hover:bg-foreground/[0.02] rounded',
          isHighlighted && 'animate-msg-highlight rounded',
          selectionMode && 'flex items-start gap-2 cursor-pointer',
          isSelected && 'bg-primary/10'
        )}
        onClick={selectionMode ? onSelectionClick : undefined}
      >
        {selectionMode && (
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => handleSelect(message.id, {})}
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 h-4 w-4 mt-1 ml-1 accent-primary cursor-pointer"
          />
        )}
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
    </MessageContextMenu>
  );
});

export { Message };

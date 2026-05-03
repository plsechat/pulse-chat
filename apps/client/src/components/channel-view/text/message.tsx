import { useCan } from '@/features/server/hooks';
import { useChannelById } from '@/features/server/channels/hooks';
import { useScrollToMessage } from '@/hooks/use-scroll-to-message';
import { useIsOwnUser, useUserById } from '@/features/server/users/hooks';
import type { IRootState } from '@/features/store';
import { getDisplayName } from '@/helpers/get-display-name';
import { cn } from '@/lib/utils';
import { Permission, type TJoinedMessage } from '@pulse/shared';
import { Pin } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { MessageActions } from './message-actions';
import { MessageContextMenu } from './message-context-menu';
import { MessageEditInline } from './message-edit-inline';
import { MessageRenderer } from './renderer';
import { ReplyContentPreview } from './reply-content-preview';
import { useSelection } from './selection-context';
import { ThreadIndicator } from './thread-indicator';

type TMessageProps = {
  message: TJoinedMessage;
  onReply: () => void;
};

const ReplyPreview = memo(
  ({
    replyTo
  }: {
    replyTo: {
      id: number;
      userId: number;
      content: string | null;
      hasFiles?: boolean;
    };
  }) => {
    const user = useUserById(replyTo.userId);

    const scrollToTarget = useScrollToMessage();
    const scrollToOriginal = useCallback(
      () => scrollToTarget(replyTo.id),
      [scrollToTarget, replyTo.id]
    );

    // The vertical primary-color bar replaces the previous reply-arrow
    // icon. The bar reads as "this is quoted material" without needing
    // an icon explaining it — closer to how Slack/Notion treat replies.
    // `self-stretch` lets the bar match the line height even when the
    // username + preview wrap on narrow widths.
    return (
      <button
        type="button"
        onClick={scrollToOriginal}
        className="group flex items-center gap-2 text-xs mb-0.5 cursor-pointer text-left"
      >
        <span className="w-[2px] h-3.5 self-stretch rounded-full bg-primary/40 group-hover:bg-primary/70 shrink-0 transition-colors" />
        <span className="font-semibold text-muted-foreground/90 group-hover:text-foreground transition-colors shrink-0">
          {getDisplayName(user)}
        </span>
        <span className="truncate text-muted-foreground/70 max-w-[300px]">
          {replyTo.content ? (
            <ReplyContentPreview content={replyTo.content} />
          ) : replyTo.hasFiles ? (
            'Attachment'
          ) : (
            'Message deleted'
          )}
        </span>
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

  // Treat messages inside a forum post (THREAD with FORUM parent) as
  // already-threaded for menu purposes — Pulse doesn't support nested
  // threads inside forum posts, so we hide the Create Thread affordance
  // in both the right-click menu and the hover action bar.
  const messageChannel = useChannelById(message.channelId);
  const isInsideForumPost =
    messageChannel?.type === 'THREAD' && !!messageChannel.parentChannelId;
  const hideCreateThread = !!message.threadId || isInsideForumPost;

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
      hasThread={hideCreateThread}
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
              hasThread={hideCreateThread}
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

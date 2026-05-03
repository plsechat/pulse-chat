import { MessageActions } from '@/components/chat-primitives/message-actions';
import { ReplyPreview } from '@/components/chat-primitives/reply-preview';
import type { TEmojiItem } from '@/components/tiptap-input/types';
import { requestConfirmation } from '@/features/dialogs/actions';
import { setActiveThreadId } from '@/features/server/channels/actions';
import { useChannelById } from '@/features/server/channels/hooks';
import { useCan } from '@/features/server/hooks';
import { useIsOwnUser } from '@/features/server/users/hooks';
import type { IRootState } from '@/features/store';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { useScrollToMessage } from '@/hooks/use-scroll-to-message';
import { getTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { Permission, type TJoinedMessage } from '@pulse/shared';
import { Pin } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { toast } from 'sonner';
import { MessageContextMenu } from './message-context-menu';
import { MessageEditInline } from './message-edit-inline';
import { MessageRenderer } from './renderer';
import { useSelection } from './selection-context';
import { ThreadIndicator } from './thread-indicator';

type TMessageProps = {
  message: TJoinedMessage;
  onReply: () => void;
};

const Message = memo(({ message, onReply }: TMessageProps) => {
  const [isEditing, setIsEditing] = useState(false);
  const [creatingThread, setCreatingThread] = useState(false);
  const isFromOwnUser = useIsOwnUser(message.userId);
  const scrollToMessage = useScrollToMessage();
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
  const canPin = useMemo(() => can(Permission.PIN_MESSAGES), [can]);
  const canReact = useMemo(() => can(Permission.REACT_TO_MESSAGES), [can]);
  const canCreateThreadPerm = useMemo(
    () => can(Permission.SEND_MESSAGES),
    [can]
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

  const onEdit = useCallback(() => setIsEditing(true), []);

  const onDelete = useCallback(async () => {
    const choice = await requestConfirmation({
      title: 'Delete Message',
      message:
        'Are you sure you want to delete this message? This action is irreversible.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel'
    });
    if (!choice) return;
    const trpc = getTRPCClient();
    if (!trpc) return;
    try {
      await trpc.messages.delete.mutate({ messageId: message.id });
      toast.success('Message deleted');
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to delete message'));
    }
  }, [message.id]);

  const onTogglePin = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) return;
    try {
      if (message.pinned) {
        await trpc.messages.unpin.mutate({ messageId: message.id });
        toast.success('Message unpinned');
      } else {
        await trpc.messages.pin.mutate({ messageId: message.id });
        toast.success('Message pinned');
      }
    } catch {
      toast.error(
        message.pinned ? 'Failed to unpin message' : 'Failed to pin message'
      );
    }
  }, [message.id, message.pinned]);

  const onCreateThread = useCallback(async () => {
    if (creatingThread) return;
    setCreatingThread(true);
    const trpc = getTRPCClient();
    if (!trpc) {
      setCreatingThread(false);
      return;
    }
    try {
      const result = await trpc.threads.create.mutate({
        messageId: message.id,
        name: 'Thread'
      });
      setActiveThreadId(result.threadId);
      toast.success('Thread created');
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to create thread'));
    } finally {
      setCreatingThread(false);
    }
  }, [message.id, creatingThread]);

  const onEmojiReact = useCallback(
    async (emoji: TEmojiItem) => {
      const trpc = getTRPCClient();
      if (!trpc) return;
      try {
        await trpc.messages.toggleReaction.mutate({
          messageId: message.id,
          emoji: emoji.name
        });
      } catch (error) {
        toast.error('Failed to add reaction');
        console.error('Error adding reaction:', error);
      }
    },
    [message.id]
  );

  return (
    <MessageContextMenu
      messageId={message.id}
      messageContent={message.content}
      channelId={message.channelId}
      onEdit={onEdit}
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
        {message.replyTo && (
          <ReplyPreview replyTo={message.replyTo} onJumpTo={scrollToMessage} />
        )}
        {!isEditing ? (
          <>
            <MessageRenderer message={message} />
            {message.threadId && (
              <ThreadIndicator threadId={message.threadId} />
            )}
            <MessageActions
              pinned={message.pinned ?? false}
              editable={message.editable ?? false}
              hasThread={hideCreateThread}
              canEdit={canEdit}
              canDelete={canDelete}
              canPin={canPin}
              canReact={canReact}
              canCreateThread={canCreateThreadPerm}
              onEdit={onEdit}
              onDelete={onDelete}
              onReply={onReply}
              onTogglePin={onTogglePin}
              onCreateThread={onCreateThread}
              onEmojiReact={onEmojiReact}
              creatingThread={creatingThread}
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

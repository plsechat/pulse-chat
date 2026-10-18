import { ForwardedFromHeader } from '@/components/chat-primitives/forwarded-from-header';
import { MessageActions } from '@/components/chat-primitives/message-actions';
import { MessageTombstone } from '@/components/chat-primitives/message-tombstone';
import { PollCard } from '@/components/chat-primitives/poll-card';
import { ReplyPreview } from '@/components/chat-primitives/reply-preview';
import { WatchCard } from '@/components/chat-primitives/watch-card';
import type { TEmojiItem } from '@/components/tiptap-input/types';
import { requestConfirmation } from '@/features/dialogs/actions';
import { setActiveThreadId } from '@/features/server/channels/actions';
import { useChannelById } from '@/features/server/channels/hooks';
import { useCan, usePreviewMode } from '@/features/server/hooks';
import { isTombstone, tombstoneAudit } from '@/features/tombstone';
import {
  useIsOwnUser,
  useOwnUserId,
  useUserById
} from '@/features/server/users/hooks';
import type { IRootState } from '@/features/store';
import { getDisplayName } from '@/helpers/get-display-name';
import { watchCardOf } from '@/features/server/voice/watch-together';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { timeOnly } from '@/helpers/time-format';
import { useScrollToMessage } from '@/hooks/use-scroll-to-message';
import { getTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import type { TJoinedMessage } from '@pulse/server/types';
import { Permission } from '@pulse/shared';
import { format } from 'date-fns';
import { Pin } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { toast } from 'sonner';
import { handleRowTap, useActiveMessageRow } from './active-message-store';
import { MessageContextMenu } from './message-context-menu';
import { MessageEditInline } from './message-edit-inline';
import { MessageRenderer } from './renderer';
import { useSelection } from './selection-context';
import { ThreadIndicator } from './thread-indicator';

type TMessageProps = {
  message: TJoinedMessage;
  onReply: () => void;
  /** Compact appearance-mode: narrower gutter, so a narrower hover pill. */
  compact?: boolean;
  /**
   * First row of a same-author group renders the full header; later rows
   * get a hover-revealed gutter timestamp instead.
   */
  isFirstInGroup?: boolean;
};

const Message = memo(
  ({
    message,
    onReply,
    compact = false,
    isFirstInGroup = true
  }: TMessageProps) => {
    const ownUserId = useOwnUserId();
    const mentionsMe =
      ownUserId !== undefined &&
      Array.isArray(message.mentionedUserIds) &&
      message.mentionedUserIds.includes(ownUserId);
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
    const previewMode = usePreviewMode();
    // Touch: the tapped row shows its toolbar in flow (active-message-store).
    const rowKey = `msg-${message.id}`;
    const actionsOpen = useActiveMessageRow(rowKey);

    // A deleted message keeps its row as a tombstone: "Message deleted"
    // in place, with the deleter and time for MANAGE_MESSAGES holders
    // (features/tombstone.ts). -1 is never a user id, so a tombstone
    // without a deleter resolves to nothing.
    const tombstone = isTombstone(message);
    const canSeeAudit = can(Permission.MANAGE_MESSAGES);
    const deleter = useUserById(message.deletedBy ?? -1);
    const audit = tombstoneAudit(
      message,
      canSeeAudit,
      deleter ? getDisplayName(deleter) : null
    );

    // In preview everything is read-only — even a message the previewer
    // authored before leaving the server can't be edited/deleted.
    const canEdit = isFromOwnUser && !previewMode;
    const canDelete = useMemo(
      () => !previewMode && (can(Permission.MANAGE_MESSAGES) || isFromOwnUser),
      [can, isFromOwnUser, previewMode]
    );
    const canPin = useMemo(() => can(Permission.PIN_MESSAGES), [can]);
    // A watch-together session posted into this channel renders as its
    // card; the message text is only the fallback for search.
    const watchCard = useMemo(() => watchCardOf(message.metadata), [message.metadata]);
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

    if (tombstone) {
      // Same anchor id and gutter as a live row (jump links and reply
      // targets still land here); no actions, no reactions, no
      // selection — only the thread it may be the root of.
      return (
        <MessageContextMenu
          messageId={message.id}
          messageContent={null}
          channelId={message.channelId}
          onEdit={onEdit}
          onReply={onReply}
          canEdit={false}
          canDelete={false}
          editable={false}
          pinned={false}
          hasThread
          tombstone
        >
          <div
            id={`msg-${message.id}`}
            className={cn(
              'min-w-0 flex-1 relative group leading-[1.375rem] rounded-lg -mr-10 pr-4',
              compact ? '-ml-[32px] pl-[32px]' : '-ml-[64px] pl-[64px]',
              isHighlighted && 'animate-msg-highlight'
            )}
          >
            {!isFirstInGroup && !compact && (
              <time className="absolute left-0 top-0 w-[56px] pr-2 text-right text-[10px] leading-[1.375rem] text-muted-foreground/60 opacity-0 group-hover-or-active:opacity-100 transition-opacity duration-100 select-none">
                {format(new Date(message.createdAt), timeOnly())}
              </time>
            )}
            <MessageTombstone audit={audit} />
            {message.threadId && (
              <ThreadIndicator threadId={message.threadId} />
            )}
          </div>
        </MessageContextMenu>
      );
    }

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
            // Inset hover pill spanning the whole row incl. the avatar
            // gutter: pull left/right past the group's padding, then pad
            // the content back so text stays on-column.
            'min-w-0 flex-1 relative group leading-[1.375rem] rounded-lg -mr-10 pr-4 transition-colors duration-100 hover:bg-foreground/[0.035]',
            compact ? '-ml-[32px] pl-[32px]' : '-ml-[64px] pl-[64px]',
            isHighlighted && 'animate-msg-highlight',
            selectionMode && 'flex items-start gap-2 cursor-pointer',
            isSelected && 'bg-primary/10',
            mentionsMe && 'mention-row'
          )}
          data-actions-open={actionsOpen || undefined}
          onClick={(e) => {
            if (selectionMode) {
              onSelectionClick(e);
              return;
            }
            handleRowTap(e, rowKey);
          }}
        >
          {!isFirstInGroup && !compact && (
            <time className="absolute left-0 top-0 w-[56px] pr-2 text-right text-[10px] leading-[1.375rem] text-muted-foreground/60 opacity-0 group-hover-or-active:opacity-100 transition-opacity duration-100 select-none">
              {format(new Date(message.createdAt), timeOnly())}
            </time>
          )}
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
          <ForwardedFromHeader
            forwardedFromUserId={message.forwardedFromUserId}
            forwardedFromName={message.forwardedFromName}
          />
          {message.replyTo && (
            <ReplyPreview
              replyTo={message.replyTo}
              onJumpTo={scrollToMessage}
            />
          )}
          {!isEditing ? (
            <>
              {message.type === 'poll' ? (
                <PollCard messageId={message.id} question={message.content} />
              ) : watchCard ? (
                <WatchCard
                  channelId={message.channelId}
                  messageId={message.id}
                  card={watchCard}
                  date={new Date(message.createdAt)}
                />
              ) : (
                <MessageRenderer message={message} />
              )}
              {message.threadId && (
                <ThreadIndicator threadId={message.threadId} />
              )}
              {/* Every hover action mutates (or feeds the composer) — none
                apply to a read-only preview */}
              {!previewMode && (
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
              )}
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
  }
);

export { Message };

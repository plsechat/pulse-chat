import { EmojiPicker } from '@/components/emoji-picker';
import type { TEmojiItem } from '@/components/tiptap-input/types';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu';
import { useCan } from '@/features/server/hooks';
import { setActiveThreadId } from '@/features/server/channels/actions';
import { requestConfirmation, requestTextInput } from '@/features/dialogs/actions';
import { useMessagesByChannelId } from '@/features/server/messages/hooks';
import { getTRPCClient } from '@/lib/trpc';
import { Permission } from '@pulse/shared';
import {
  ArrowDown,
  ArrowUp,
  ClipboardCopy,
  Copy,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Reply,
  Smile,
  Trash
} from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { toast } from 'sonner';

type TMessageContextMenuProps = {
  children: React.ReactNode;
  messageId: number;
  messageContent: string | null;
  channelId?: number;
  onEdit: () => void;
  onReply: () => void;
  canEdit: boolean;
  canDelete: boolean;
  editable: boolean;
  pinned: boolean;
  hasThread: boolean;
};

const MessageContextMenu = memo(
  ({
    children,
    messageId,
    messageContent,
    channelId,
    onEdit,
    onReply,
    canEdit,
    canDelete,
    editable,
    pinned,
    hasThread
  }: TMessageContextMenuProps) => {
    const can = useCan();
    const [creatingThread, setCreatingThread] = useState(false);
    const channelMessages = useMessagesByChannelId(channelId ?? -1);

    const onDeleteClick = useCallback(async () => {
      const choice = await requestConfirmation({
        title: 'Delete Message',
        message:
          'Are you sure you want to delete this message? This action is irreversible.',
        confirmLabel: 'Delete',
        cancelLabel: 'Cancel'
      });

      if (!choice) return;

      const trpc = getTRPCClient();

      try {
        await trpc.messages.delete.mutate({ messageId });
        toast.success('Message deleted');
      } catch {
        toast.error('Failed to delete message');
      }
    }, [messageId]);

    const onPinToggle = useCallback(async () => {
      const trpc = getTRPCClient();

      try {
        if (pinned) {
          await trpc.messages.unpin.mutate({ messageId });
          toast.success('Message unpinned');
        } else {
          await trpc.messages.pin.mutate({ messageId });
          toast.success('Message pinned');
        }
      } catch {
        toast.error(pinned ? 'Failed to unpin message' : 'Failed to pin message');
      }
    }, [messageId, pinned]);

    const onCreateThread = useCallback(async () => {
      if (creatingThread) return;

      setCreatingThread(true);

      const trpc = getTRPCClient();

      try {
        const result = await trpc.threads.create.mutate({
          messageId,
          name: 'Thread'
        });

        setActiveThreadId(result.threadId);
        toast.success('Thread created');
      } catch {
        toast.error('Failed to create thread');
      } finally {
        setCreatingThread(false);
      }
    }, [messageId, creatingThread]);

    const onEmojiSelect = useCallback(
      async (emoji: TEmojiItem) => {
        const trpc = getTRPCClient();

        try {
          await trpc.messages.toggleReaction.mutate({
            messageId,
            emoji: emoji.name
          });
        } catch {
          toast.error('Failed to add reaction');
        }
      },
      [messageId]
    );

    const onCopyText = useCallback(() => {
      if (!messageContent) return;
      const plainText = messageContent.replace(/<[^>]*>/g, '');
      navigator.clipboard.writeText(plainText);
      toast.success('Copied to clipboard');
    }, [messageContent]);

    const onBulkDelete = useCallback(
      async (direction: 'above' | 'below') => {
        const countStr = await requestTextInput({
          title: `Delete Messages ${direction === 'above' ? 'Above' : 'Below'}`,
          message: `How many messages ${direction} this one do you want to delete?`,
          confirmLabel: 'Delete',
          cancelLabel: 'Cancel'
        });

        if (!countStr) return;
        const count = parseInt(countStr, 10);
        if (isNaN(count) || count <= 0) {
          toast.error('Please enter a valid positive number');
          return;
        }

        const idx = channelMessages.findIndex((m) => m.id === messageId);
        if (idx === -1) return;

        let idsToDelete: number[];
        if (direction === 'above') {
          const start = Math.max(0, idx - count);
          idsToDelete = channelMessages.slice(start, idx).map((m) => m.id);
        } else {
          idsToDelete = channelMessages
            .slice(idx + 1, idx + 1 + count)
            .map((m) => m.id);
        }

        if (idsToDelete.length === 0) {
          toast.error(`No messages ${direction} to delete`);
          return;
        }

        // Cap at 100 per server limit
        if (idsToDelete.length > 100) {
          idsToDelete = idsToDelete.slice(0, 100);
        }

        const choice = await requestConfirmation({
          title: 'Confirm Bulk Delete',
          message: `Are you sure you want to delete ${idsToDelete.length} message(s)? This cannot be undone.`,
          confirmLabel: `Delete ${idsToDelete.length}`,
          cancelLabel: 'Cancel'
        });

        if (!choice) return;

        const trpc = getTRPCClient();

        try {
          const result = await trpc.messages.bulkDelete.mutate({
            messageIds: idsToDelete
          });
          toast.success(`Deleted ${result.deletedCount} messages`);
        } catch {
          toast.error('Failed to delete messages');
        }
      },
      [messageId, channelMessages]
    );

    const onCopyMessageLink = useCallback(() => {
      const link = channelId
        ? `${channelId}/${messageId}`
        : String(messageId);
      navigator.clipboard.writeText(link);
      toast.success('Message link copied');
    }, [channelId, messageId]);

    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem onClick={onReply}>
            <Reply className="h-4 w-4" />
            Reply
          </ContextMenuItem>

          {canEdit && editable && (
            <ContextMenuItem onClick={onEdit}>
              <Pencil className="h-4 w-4" />
              Edit Message
            </ContextMenuItem>
          )}

          {can(Permission.PIN_MESSAGES) && (
            <ContextMenuItem onClick={onPinToggle}>
              {pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
              {pinned ? 'Unpin Message' : 'Pin Message'}
            </ContextMenuItem>
          )}

          {!hasThread && can(Permission.SEND_MESSAGES) && (
            <ContextMenuItem onClick={onCreateThread} disabled={creatingThread}>
              <MessageSquare className="h-4 w-4" />
              Create Thread
            </ContextMenuItem>
          )}

          {can(Permission.REACT_TO_MESSAGES) && (
            <EmojiPicker onEmojiSelect={onEmojiSelect}>
              <ContextMenuItem onSelect={(e) => e.preventDefault()}>
                <Smile className="h-4 w-4" />
                Add Reaction
              </ContextMenuItem>
            </EmojiPicker>
          )}

          <ContextMenuSeparator />

          <ContextMenuItem onClick={onCopyText} disabled={!messageContent}>
            <Copy className="h-4 w-4" />
            Copy Text
          </ContextMenuItem>

          <ContextMenuItem onClick={onCopyMessageLink}>
            <ClipboardCopy className="h-4 w-4" />
            Copy Message ID
          </ContextMenuItem>

          {canDelete && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={onDeleteClick} variant="destructive">
                <Trash className="h-4 w-4" />
                Delete Message
              </ContextMenuItem>
            </>
          )}

          {can(Permission.MANAGE_MESSAGES) && channelId && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => onBulkDelete('above')}
                variant="destructive"
              >
                <ArrowUp className="h-4 w-4" />
                Delete Messages Above...
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => onBulkDelete('below')}
                variant="destructive"
              >
                <ArrowDown className="h-4 w-4" />
                Delete Messages Below...
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    );
  }
);

export { MessageContextMenu };

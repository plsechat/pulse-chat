import { EmojiPicker } from '@/components/emoji-picker';
import { Protect } from '@/components/protect';
import type { TEmojiItem } from '@/components/tiptap-input/types';
import { IconButton } from '@/components/ui/icon-button';
import { requestConfirmation } from '@/features/dialogs/actions';
import { getTRPCClient } from '@/lib/trpc';
import { setActiveThreadId } from '@/features/server/channels/actions';
import { Permission } from '@pulse/shared';
import { MessageSquare, Pencil, Pin, PinOff, Reply, Smile, Trash } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { toast } from 'sonner';

type TMessageActionsProps = {
  messageId: number;
  onEdit: () => void;
  onReply: () => void;
  canManage: boolean;
  editable: boolean;
  pinned: boolean;
  hasThread: boolean;
};

const MessageActions = memo(
  ({ onEdit, onReply, messageId, canManage, editable, pinned, hasThread }: TMessageActionsProps) => {
    const [creatingThread, setCreatingThread] = useState(false);
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
          name: `Thread`
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
        } catch (error) {
          toast.error('Failed to add reaction');

          console.error('Error adding reaction:', error);
        }
      },
      [messageId]
    );

    return (
      <div className="gap-0.5 absolute right-0 -top-6 z-10 hidden group-hover:flex [&:has([data-state=open])]:flex items-center rounded-md shadow-md border border-border p-0.5 animate-in fade-in-0 slide-in-from-bottom-1 duration-150 h-8">
        {canManage && (
          <>
            <IconButton
              size="sm"
              variant="ghost"
              icon={Pencil}
              onClick={onEdit}
              disabled={!editable}
              title="Edit Message"
            />

            <IconButton
              size="sm"
              variant="ghost"
              icon={Trash}
              onClick={onDeleteClick}
              title="Delete Message"
            />
          </>
        )}
        <Protect permission={Permission.PIN_MESSAGES}>
          <IconButton
            size="sm"
            variant="ghost"
            icon={pinned ? PinOff : Pin}
            onClick={onPinToggle}
            title={pinned ? 'Unpin Message' : 'Pin Message'}
          />
        </Protect>
        <IconButton
          size="sm"
          variant="ghost"
          icon={Reply}
          onClick={onReply}
          title="Reply"
        />
        {!hasThread && (
          <Protect permission={Permission.SEND_MESSAGES}>
            <IconButton
              size="sm"
              variant="ghost"
              icon={MessageSquare}
              onClick={onCreateThread}
              disabled={creatingThread}
              title="Create Thread"
            />
          </Protect>
        )}
        <Protect permission={Permission.REACT_TO_MESSAGES}>
          <EmojiPicker onEmojiSelect={onEmojiSelect}>
            <IconButton
              size="sm"
              variant="ghost"
              icon={Smile}
              title="Add Reaction"
            />
          </EmojiPicker>
        </Protect>
      </div>
    );
  }
);

export { MessageActions };

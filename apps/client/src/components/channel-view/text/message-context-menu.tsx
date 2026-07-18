import { EmojiPickerPanel } from '@/components/emoji-picker';
import type { TEmojiItem } from '@/components/tiptap-input/types';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu';
import {
  Popover,
  PopoverAnchor,
  PopoverContent
} from '@/components/ui/popover';
import { useCan } from '@/features/server/hooks';
import { setActiveThreadId } from '@/features/server/channels/actions';
import { requestConfirmation } from '@/features/dialogs/actions';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import { Permission } from '@pulse/shared';
import {
  CheckSquare,
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
import { stripToPlainText } from '@/helpers/strip-to-plain-text';
import { memo, useCallback, useState } from 'react';
import { toast } from 'sonner';
import { useSelection } from './selection-context';

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
    const { selectionMode, enterSelectionMode } = useSelection();
    const [creatingThread, setCreatingThread] = useState(false);
    const [reactionPickerOpen, setReactionPickerOpen] = useState(false);

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
      if (!trpc) return;

      try {
        await trpc.messages.delete.mutate({ messageId });
        toast.success('Message deleted');
      } catch (err) {
        toast.error(getTrpcError(err, 'Failed to delete message'));
      }
    }, [messageId]);

    const onPinToggle = useCallback(async () => {
      const trpc = getTRPCClient();
      if (!trpc) return;

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
      if (!trpc) {
        setCreatingThread(false);
        return;
      }

      try {
        const result = await trpc.threads.create.mutate({
          messageId,
          name: 'Thread'
        });

        setActiveThreadId(result.threadId);
        toast.success('Thread created');
      } catch (err) {
        toast.error(getTrpcError(err, 'Failed to create thread'));
      } finally {
        setCreatingThread(false);
      }
    }, [messageId, creatingThread]);

    const onEmojiSelect = useCallback(
      async (emoji: TEmojiItem) => {
        setReactionPickerOpen(false);

        const trpc = getTRPCClient();
        if (!trpc) return;

        try {
          await trpc.messages.toggleReaction.mutate({
            messageId,
            emoji: emoji.name
          });
        } catch (err) {
          toast.error(getTrpcError(err, 'Failed to add reaction'));
        }
      },
      [messageId]
    );

    const onCopyText = useCallback(() => {
      if (!messageContent) return;
      const plainText = stripToPlainText(messageContent);
      navigator.clipboard.writeText(plainText);
      toast.success('Copied to clipboard');
    }, [messageContent]);

    const onCopyMessageLink = useCallback(() => {
      // Emits the deep-link token (`<#msg:channelId/messageId>`) that the
      // renderer recognizes. Pasting it produces a clickable badge that
      // jumps to the message via the existing scroll-to-message pulse.
      // Falls back to a bare `messageId` when channelId is unknown
      // (vanishingly rare — only legacy code paths drop the channel).
      const link = channelId
        ? `<#msg:${channelId}/${messageId}>`
        : String(messageId);
      navigator.clipboard.writeText(link);
      toast.success('Message link copied');
    }, [channelId, messageId]);

    return (
      // The reaction picker lives in its OWN Popover that WRAPS the context
      // menu, anchored to the message row. Nesting the picker's Popover
      // inside ContextMenuContent (the previous approach) let the menu's
      // dismiss layer tear the picker down the moment emoji-mart's autoFocus
      // pulled focus into the portaled panel — the "hover makes it vanish"
      // bug. Decoupling them: "Add Reaction" closes the menu and opens this
      // independent, state-controlled Popover.
      <Popover open={reactionPickerOpen} onOpenChange={setReactionPickerOpen}>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <PopoverAnchor asChild>{children}</PopoverAnchor>
          </ContextMenuTrigger>
          <ContextMenuContent
            className="w-52"
            // When "Add Reaction" opened the picker, don't let the closing
            // menu restore focus to the trigger — that focus yank is a
            // focus-outside event for the picker Popover.
            onCloseAutoFocus={(e) => {
              if (reactionPickerOpen) e.preventDefault();
            }}
          >
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
            <ContextMenuItem onClick={() => setReactionPickerOpen(true)}>
              <Smile className="h-4 w-4" />
              Add Reaction
            </ContextMenuItem>
          )}

          <ContextMenuSeparator />

          <ContextMenuItem onClick={onCopyText} disabled={!messageContent}>
            <Copy className="h-4 w-4" />
            Copy Text
          </ContextMenuItem>

          <ContextMenuItem onClick={onCopyMessageLink}>
            <ClipboardCopy className="h-4 w-4" />
            Copy Message Link
          </ContextMenuItem>

          {!selectionMode && can(Permission.MANAGE_MESSAGES) && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={enterSelectionMode}>
                <CheckSquare className="h-4 w-4" />
                Select Messages
              </ContextMenuItem>
            </>
          )}

          {canDelete && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={onDeleteClick} variant="destructive">
                <Trash className="h-4 w-4" />
                Delete Message
              </ContextMenuItem>
            </>
          )}

          </ContextMenuContent>
        </ContextMenu>

        <PopoverContent
          className="w-auto p-0 border-none shadow-none bg-transparent data-[state=closed]:duration-0"
          align="start"
          sideOffset={8}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          // The context menu that opened this picker is still mid-exit-
          // animation with a TRAPPED FocusScope: the instant emoji-mart
          // autofocuses, the dying menu steals focus back (then its unmount
          // refocuses the trigger). A non-modal Popover dismisses on ANY
          // focus landing outside it, so either steal closed the picker
          // instantly. Ignore focus movement entirely — only pointer-down
          // outside, Escape, or picking an emoji closes it.
          onFocusOutside={(e) => e.preventDefault()}
        >
          <EmojiPickerPanel onEmojiSelect={onEmojiSelect} />
        </PopoverContent>
      </Popover>
    );
  }
);

export { MessageContextMenu };

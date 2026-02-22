import { ServerScreen } from '@/components/server-screens/screens';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu';
import {
  requestConfirmation,
  requestTextInput
} from '@/features/dialogs/actions';
import { openServerScreen } from '@/features/server-screens/actions';
import { useChannelById } from '@/features/server/channels/hooks';
import { useCan } from '@/features/server/hooks';
import { getTRPCClient } from '@/lib/trpc';
import { Permission } from '@pulse/shared';
import { memo, useCallback } from 'react';
import { toast } from 'sonner';

type TChannelContextMenuProps = {
  children: React.ReactNode;
  channelId: number;
};

const ChannelContextMenu = memo(
  ({ children, channelId }: TChannelContextMenuProps) => {
    const can = useCan();
    const channel = useChannelById(channelId);

    const onDeleteClick = useCallback(async () => {
      const choice = await requestConfirmation({
        title: 'Delete Channel',
        message:
          'Are you sure you want to delete this channel? This action cannot be undone.',
        confirmLabel: 'Delete',
        cancelLabel: 'Cancel'
      });

      if (!choice) return;

      const trpc = getTRPCClient();

      try {
        await trpc.channels.delete.mutate({ channelId });
        toast.success('Channel deleted');
      } catch {
        toast.error('Failed to delete channel');
      }
    }, [channelId]);

    const onEditClick = useCallback(() => {
      openServerScreen(ServerScreen.CHANNEL_SETTINGS, { channelId });
    }, [channelId]);

    const onPurgeClick = useCallback(async () => {
      if (!channel) return;

      const enteredName = await requestTextInput({
        title: 'Purge All Messages',
        message: `This will permanently delete ALL messages in #${channel.name}. To confirm, type: ${channel.name}`,
        confirmLabel: 'Purge',
        cancelLabel: 'Cancel'
      });

      if (!enteredName) return;

      if (enteredName !== channel.name) {
        toast.error('Channel name does not match');
        return;
      }

      const trpc = getTRPCClient();

      try {
        await trpc.messages.purge.mutate({
          channelId,
          confirmChannelName: enteredName
        });
        toast.success('All messages purged');
      } catch {
        toast.error('Failed to purge messages');
      }
    }, [channelId, channel]);

    const canManageChannels = can(Permission.MANAGE_CHANNELS);
    const canManageMessages = can(Permission.MANAGE_MESSAGES);

    if (!canManageChannels && !canManageMessages) {
      return <>{children}</>;
    }

    return (
      <ContextMenu>
        <ContextMenuTrigger>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          {canManageChannels && (
            <>
              <ContextMenuItem onClick={onEditClick}>Edit</ContextMenuItem>
              <ContextMenuItem variant="destructive" onClick={onDeleteClick}>
                Delete
              </ContextMenuItem>
            </>
          )}
          {canManageMessages && (
            <>
              {canManageChannels && <ContextMenuSeparator />}
              <ContextMenuItem variant="destructive" onClick={onPurgeClick}>
                Purge Messages
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    );
  }
);

export { ChannelContextMenu };

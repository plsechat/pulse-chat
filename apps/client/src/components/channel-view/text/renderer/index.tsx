import { ChatMessageBody } from '@/components/chat-primitives/message-body';
import { useActiveInstanceDomain } from '@/features/app/hooks';
import { requestConfirmation } from '@/features/dialogs/actions';
import { useOwnUserId } from '@/features/server/users/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import type { TJoinedMessage } from '@pulse/shared';
import { memo, useCallback } from 'react';
import { toast } from 'sonner';

type TMessageRendererProps = {
  message: TJoinedMessage;
};

/**
 * Channel-side adapter over the shared ChatMessageBody: supplies the
 * AMBIENT instance domain (federated file URLs), the ambient
 * file-delete mutation for own messages, and leaves reactions on their
 * ambient default. The body itself is shared with the DM stack.
 */
const MessageRenderer = memo(({ message }: TMessageRendererProps) => {
  const ownUserId = useOwnUserId();
  const instanceDomain = useActiveInstanceDomain() ?? undefined;
  const isOwnMessage = message.userId === ownUserId;

  const onRemoveFile = useCallback(async (fileId: number) => {
    if (!fileId) return;

    const choice = await requestConfirmation({
      title: 'Delete file',
      message: 'Are you sure you want to delete this file?',
      confirmLabel: 'Delete'
    });

    if (!choice) return;

    const trpc = getTRPCClient();
    if (!trpc) return;

    try {
      await trpc.files.delete.mutate({ fileId });
      toast.success('File deleted');
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to delete file'));
    }
  }, []);

  return (
    <ChatMessageBody
      message={message}
      instanceDomain={instanceDomain}
      onRemoveFile={isOwnMessage ? onRemoveFile : undefined}
    />
  );
});

export { MessageRenderer };

import { InlineMessageEditor } from '@/components/chat-primitives/inline-message-editor';
import { useOwnUserId } from '@/features/server/users/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { isTokenContentEmpty } from '@/helpers/strip-to-plain-text';
import { tiptapHtmlToTokens } from '@/lib/converters/tiptap-to-tokens';
import { encryptChannelMessage } from '@/lib/e2ee';
import { getTRPCClient } from '@/lib/trpc';
import type { TMessage } from '@pulse/shared';
import { memo, useCallback } from 'react';
import { toast } from 'sonner';

type TMessageEditInlineProps = {
  message: TMessage;
  onBlur: () => void;
};

/**
 * Channel-side adapter: owns the channel save (E2EE encrypt +
 * messages.edit, empty content deletes) and delegates the editor
 * chrome to the shared InlineMessageEditor.
 */
const MessageEditInline = memo(
  ({ message, onBlur }: TMessageEditInlineProps) => {
    const ownUserId = useOwnUserId();

    const onSubmit = useCallback(
      async (newValue: string) => {
        if (!newValue) {
          onBlur();
          return;
        }

        const trpc = getTRPCClient();
        if (!trpc) {
          onBlur();
          return;
        }

        try {
          const content = tiptapHtmlToTokens(newValue);

          if (isTokenContentEmpty(content)) {
            await trpc.messages.delete.mutate({ messageId: message.id });
            toast.success('Message deleted');
            onBlur();
            return;
          }

          if (message.e2ee && ownUserId) {
            const encryptedContent = await encryptChannelMessage(
              message.channelId,
              ownUserId,
              { content }
            );
            await trpc.messages.edit.mutate({
              messageId: message.id,
              content: encryptedContent
            });
          } else {
            await trpc.messages.edit.mutate({
              messageId: message.id,
              content
            });
          }
          toast.success('Message edited');
        } catch (err) {
          toast.error(getTrpcError(err, 'Failed to edit message'));
        } finally {
          onBlur();
        }
      },
      [message.id, message.e2ee, message.channelId, ownUserId, onBlur]
    );

    return (
      <InlineMessageEditor
        content={message.content}
        autoFocus
        onSubmit={onSubmit}
        onCancel={onBlur}
      />
    );
  }
);

export { MessageEditInline };

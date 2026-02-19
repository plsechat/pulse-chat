import { TiptapInput } from '@/components/tiptap-input';
import { AutoFocus } from '@/components/ui/auto-focus';
import { useOwnUserId } from '@/features/server/users/hooks';
import { encryptChannelMessage } from '@/lib/e2ee';
import { getTRPCClient } from '@/lib/trpc';
import type { TMessage } from '@pulse/shared';
import { memo, useCallback, useState } from 'react';
import { toast } from 'sonner';
import { preprocessMarkdown } from './renderer/markdown-preprocessor';

type TMessageEditInlineProps = {
  message: TMessage;
  onBlur: () => void;
};

const MessageEditInline = memo(
  ({ message, onBlur }: TMessageEditInlineProps) => {
    const [value, setValue] = useState<string>(message.content ?? '');
    const ownUserId = useOwnUserId();

    const onSubmit = useCallback(
      async (newValue: string | undefined) => {
        if (!newValue) {
          onBlur();
          return;
        }

        const trpc = getTRPCClient();

        try {
          const content = preprocessMarkdown(newValue);

          if (message.e2ee && ownUserId) {
            const encryptedContent = await encryptChannelMessage(
              message.channelId,
              ownUserId,
              { content }
            );
            await trpc.messages.edit.mutate({
              messageId: message.id,
              encryptedContent
            });
          } else {
            await trpc.messages.edit.mutate({
              messageId: message.id,
              content
            });
          }
          toast.success('Message edited');
        } catch {
          toast.error('Failed to edit message');
        } finally {
          onBlur();
        }
      },
      [message.id, message.e2ee, message.channelId, ownUserId, onBlur]
    );

    return (
      <div className="flex flex-col gap-2">
        <AutoFocus>
          <TiptapInput
            value={value}
            onChange={setValue}
            onSubmit={() => onSubmit(value)}
            onCancel={onBlur}
          />
        </AutoFocus>
        <span className="text-xs text-primary/60">
          Press Enter to save, Esc to cancel
        </span>
      </div>
    );
  }
);

export { MessageEditInline };

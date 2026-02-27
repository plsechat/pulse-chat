import { TiptapInput } from '@/components/tiptap-input';
import { AutoFocus } from '@/components/ui/auto-focus';
import { useOwnUserId } from '@/features/server/users/hooks';
import { isTokenContentEmpty } from '@/helpers/strip-to-plain-text';
import { encryptChannelMessage } from '@/lib/e2ee';
import { isLegacyHtml } from '@/lib/converters/token-content-renderer';
import { tiptapHtmlToTokens } from '@/lib/converters/tiptap-to-tokens';
import { tokensToTiptapHtml } from '@/lib/converters/tokens-to-tiptap';
import { useTokenToTiptapContext } from '@/lib/converters/use-token-context';
import { getTRPCClient } from '@/lib/trpc';
import type { TMessage } from '@pulse/shared';
import { memo, useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

type TMessageEditInlineProps = {
  message: TMessage;
  onBlur: () => void;
};

const MessageEditInline = memo(
  ({ message, onBlur }: TMessageEditInlineProps) => {
    const ctx = useTokenToTiptapContext();

    const initialValue = useMemo(() => {
      const raw = message.content ?? '';
      if (isLegacyHtml(raw) || !raw) return raw;
      return tokensToTiptapHtml(raw, ctx);
    }, [message.content, ctx]);

    const [value, setValue] = useState<string>(initialValue);
    const ownUserId = useOwnUserId();

    const onSubmit = useCallback(
      async (newValue: string | undefined) => {
        if (!newValue) {
          onBlur();
          return;
        }

        const trpc = getTRPCClient();

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

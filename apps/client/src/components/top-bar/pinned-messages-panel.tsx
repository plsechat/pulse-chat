import { MessageRenderer } from '@/components/channel-view/text/renderer';
import { PopoverPanelShell } from '@/components/chat-primitives/popover-panel-shell';
import { Protect } from '@/components/protect';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/user-avatar';
import { decryptChannelMessages } from '@/features/server/messages/decrypt';
import { useUserById } from '@/features/server/users/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { longDateTime } from '@/helpers/time-format';
import { getTRPCClient } from '@/lib/trpc';
import { Permission, type TJoinedMessage } from '@pulse/shared';
import { format } from 'date-fns';
import { Pin, PinOff } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

type TPinnedMessagesPanelProps = {
  channelId: number;
  onClose: () => void;
};

const PinnedMessageItem = memo(
  ({
    message,
    onUnpin
  }: {
    message: TJoinedMessage;
    onUnpin: (messageId: number) => void;
  }) => {
    const user = useUserById(message.userId);

    return (
      <div className="p-3 border-b border-border/30 last:border-b-0 hover:bg-secondary/30 overflow-hidden">
        <div className="flex items-center gap-2 mb-1 min-w-0">
          <UserAvatar userId={message.userId} className="h-5 w-5 shrink-0" />
          <span className="text-sm font-medium truncate">
            {user?.name ?? 'Unknown'}
          </span>
          <span className="text-xs text-muted-foreground shrink-0">
            {format(new Date(message.createdAt), longDateTime())}
          </span>
        </div>
        {/*
          The renderer fans out attached images, link-preview embeds and
          YouTube thumbnails at full source width; the parent panel is
          fixed at w-96, so without these constraints a wide image
          overflowed horizontally and the panel grew its own scrollbar
          along the X axis. Constrain everything inside the renderer to
          the panel's width and force images to scale.
        */}
        <div className="pl-7 text-sm min-w-0 max-w-full overflow-x-hidden [&_img]:max-w-full [&_img]:h-auto [&_video]:max-w-full">
          <MessageRenderer message={message} />
        </div>
        <div className="flex justify-end mt-1">
          <Protect permission={Permission.PIN_MESSAGES}>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onUnpin(message.id)}
            >
              <PinOff className="w-3 h-3 mr-1" />
              Unpin
            </Button>
          </Protect>
        </div>
      </div>
    );
  }
);

const PinnedMessagesPanel = memo(
  ({ channelId, onClose }: TPinnedMessagesPanelProps) => {
    const [pinnedMessages, setPinnedMessages] = useState<TJoinedMessage[]>([]);
    const [loading, setLoading] = useState(true);

    const fetchPinned = useCallback(async () => {
      setLoading(true);

      try {
        const trpc = getTRPCClient();
        if (!trpc) return;
        const messages = await trpc.messages.getPinned.query({ channelId });
        // Run pinned messages through the same decrypt path as history
        // and live messages so E2EE pins render as plaintext, not as
        // raw sender-key ciphertext.
        const decrypted = await decryptChannelMessages(messages);
        setPinnedMessages(decrypted);
      } catch (err) {
        toast.error(getTrpcError(err, 'Failed to load pinned messages'));
      } finally {
        setLoading(false);
      }
    }, [channelId]);

    useEffect(() => {
      fetchPinned();
    }, [fetchPinned]);

    // Re-fetch when pin/unpin events arrive for this channel
    useEffect(() => {
      const handler = (e: Event) => {
        const detail = (e as CustomEvent).detail;
        if (detail?.channelId === channelId) {
          fetchPinned();
        }
      };

      window.addEventListener('pinned-messages-changed', handler);
      return () =>
        window.removeEventListener('pinned-messages-changed', handler);
    }, [channelId, fetchPinned]);

    const onUnpin = useCallback(
      async (messageId: number) => {
        const trpc = getTRPCClient();
        if (!trpc) return;

        try {
          await trpc.messages.unpin.mutate({ messageId });
          setPinnedMessages((prev) => prev.filter((m) => m.id !== messageId));
          toast.success('Message unpinned');
        } catch (err) {
          toast.error(getTrpcError(err, 'Failed to unpin message'));
        }
      },
      []
    );

    return (
      <PopoverPanelShell
        icon={Pin}
        title="Pinned Messages"
        onClose={onClose}
        loading={loading}
        empty={!loading && pinnedMessages.length === 0}
        emptyMessage="No pinned messages in this channel."
      >
        {pinnedMessages.map((message) => (
          <PinnedMessageItem
            key={message.id}
            message={message}
            onUnpin={onUnpin}
          />
        ))}
      </PopoverPanelShell>
    );
  }
);

export { PinnedMessagesPanel };

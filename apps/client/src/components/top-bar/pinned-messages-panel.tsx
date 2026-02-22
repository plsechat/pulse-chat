import { Protect } from '@/components/protect';
import { MessageRenderer } from '@/components/channel-view/text/renderer';
import { UserAvatar } from '@/components/user-avatar';
import { useUserById } from '@/features/server/users/hooks';
import { getTRPCClient } from '@/lib/trpc';
import { Permission, type TJoinedMessage } from '@pulse/shared';
import { longDateTime } from '@/helpers/time-format';
import { format } from 'date-fns';
import { Pin, PinOff, X } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../ui/button';

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
      <div className="p-3 border-b border-border/30 last:border-b-0 hover:bg-secondary/30">
        <div className="flex items-center gap-2 mb-1">
          <UserAvatar userId={message.userId} className="h-5 w-5" />
          <span className="text-sm font-medium">{user?.name ?? 'Unknown'}</span>
          <span className="text-xs text-muted-foreground">
            {format(new Date(message.createdAt), longDateTime())}
          </span>
        </div>
        <div className="pl-7 text-sm">
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
        const messages = await trpc.messages.getPinned.query({ channelId });

        setPinnedMessages(messages);
      } catch {
        toast.error('Failed to load pinned messages');
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

        try {
          await trpc.messages.unpin.mutate({ messageId });
          setPinnedMessages((prev) => prev.filter((m) => m.id !== messageId));
          toast.success('Message unpinned');
        } catch {
          toast.error('Failed to unpin message');
        }
      },
      []
    );

    return (
      <div className="absolute right-0 top-full mt-1 z-50 w-96 max-h-96 overflow-y-auto rounded-lg border border-border bg-popover shadow-lg">
        <div className="flex items-center justify-between p-3 border-b border-border/30 sticky top-0 bg-popover z-10">
          <div className="flex items-center gap-2">
            <Pin className="w-4 h-4" />
            <span className="text-sm font-medium">Pinned Messages</span>
          </div>
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={onClose}>
            <X className="w-3 h-3" />
          </Button>
        </div>
        {loading ? (
          <div className="p-4 text-center text-sm text-muted-foreground">
            Loading...
          </div>
        ) : pinnedMessages.length === 0 ? (
          <div className="p-4 text-center text-sm text-muted-foreground">
            No pinned messages in this channel.
          </div>
        ) : (
          pinnedMessages.map((message) => (
            <PinnedMessageItem
              key={message.id}
              message={message}
              onUnpin={onUnpin}
            />
          ))
        )}
      </div>
    );
  }
);

export { PinnedMessagesPanel };

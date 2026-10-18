import { ChatMessageBody } from '@/components/chat-primitives/message-body';
import { PopoverPanelShell } from '@/components/chat-primitives/popover-panel-shell';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/user-avatar';
import { useActiveInstanceDomain } from '@/features/app/hooks';
import { requestConfirmation } from '@/features/dialogs/actions';
import { useCan } from '@/features/server/hooks';
import { useOwnUserId, useUserById } from '@/features/server/users/hooks';
import { getDisplayName } from '@/helpers/get-display-name';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { longDateTime } from '@/helpers/time-format';
import { onAppEvent } from '@/lib/events';
import { getTRPCClient } from '@/lib/trpc';
import type { TScheduledPostView } from '@pulse/server/types';
import { Permission } from '@pulse/shared';
import { format } from 'date-fns';
import { Clock, Paperclip, X } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

type TScheduledPostsPopoverProps = {
  channelId: number;
  onClose: () => void;
};

const ScheduledRow = memo(
  ({
    post,
    canCancel,
    onCancel,
    instanceDomain
  }: {
    post: TScheduledPostView;
    canCancel: boolean;
    onCancel: (post: TScheduledPostView) => void;
    instanceDomain?: string;
  }) => {
    const author = useUserById(post.userId);

    return (
      <li className="border-b border-border/30 p-3 last:border-b-0">
        <div className="flex items-center gap-2 min-w-0">
          <UserAvatar userId={post.userId} className="h-5 w-5 shrink-0" showStatusBadge={false} />
          <span className="truncate text-sm font-medium">{getDisplayName(author)}</span>
          <time
            dateTime={new Date(post.sendAt).toISOString()}
            className="ml-auto shrink-0 text-xs text-muted-foreground"
          >
            {format(new Date(post.sendAt), longDateTime())}
          </time>
          {canCancel && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 shrink-0 p-0"
              onClick={() => onCancel(post)}
              aria-label={`Cancel scheduled message for ${format(new Date(post.sendAt), longDateTime())}`}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
        <div className="mt-1 pl-7 text-sm text-muted-foreground min-w-0 max-w-full overflow-x-hidden [&_img]:max-w-full">
          {post.content ? (
            <ChatMessageBody
              compact
              message={{
                id: post.id,
                content: post.content,
                e2ee: false,
                edited: false,
                updatedAt: null,
                files: [],
                metadata: null,
                reactions: []
              }}
              instanceDomain={instanceDomain}
            />
          ) : null}
          {post.files.length > 0 && (
            <span className="mt-1 flex items-center gap-1 text-xs">
              <Paperclip className="h-3 w-3" aria-hidden="true" />
              {post.files.length} attachment{post.files.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </li>
    );
  }
);

/**
 * The channel's pending scheduled messages: the viewer's own, or every
 * member's for a MANAGE_MESSAGES holder. Refetched on the server's
 * SCHEDULED_POST_UPDATE ping (create, send, cancel).
 */
const ScheduledPostsPopover = memo(({ channelId, onClose }: TScheduledPostsPopoverProps) => {
  const [posts, setPosts] = useState<TScheduledPostView[]>([]);
  const [loading, setLoading] = useState(true);
  const ownUserId = useOwnUserId();
  const can = useCan();
  const canManage = can(Permission.MANAGE_MESSAGES);
  const instanceDomain = useActiveInstanceDomain() ?? undefined;

  const fetchPosts = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) {
      setLoading(false);
      return;
    }
    try {
      setPosts(await trpc.scheduled.list.query({ channelId }));
    } catch (err) {
      toast.error(getTrpcError(err, 'Could not load scheduled messages'));
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    void fetchPosts();
  }, [fetchPosts]);

  useEffect(
    () =>
      onAppEvent('scheduled-posts-changed', (payload) => {
        if (payload.channelId === channelId) void fetchPosts();
      }),
    [channelId, fetchPosts]
  );

  const onCancel = useCallback(async (post: TScheduledPostView) => {
    const choice = await requestConfirmation({
      title: 'Cancel scheduled message',
      message: 'The message will not be sent. Its attachments are deleted.',
      confirmLabel: 'Cancel message',
      cancelLabel: 'Keep'
    });
    if (!choice) return;
    const trpc = getTRPCClient();
    if (!trpc) return;
    try {
      await trpc.scheduled.cancel.mutate({ scheduledPostId: post.id });
      setPosts((prev) => prev.filter((p) => p.id !== post.id));
      toast.success('Scheduled message cancelled');
    } catch (err) {
      toast.error(getTrpcError(err, 'Could not cancel the message'));
    }
  }, []);

  return (
    <PopoverPanelShell
      icon={Clock}
      title="Scheduled"
      onClose={onClose}
      loading={loading}
      empty={posts.length === 0}
      emptyMessage="Nothing scheduled. Write a message and pick Schedule from the + menu."
    >
      <ul aria-label="Scheduled messages">
        {posts.map((post) => (
          <ScheduledRow
            key={post.id}
            post={post}
            canCancel={canManage || post.userId === ownUserId}
            onCancel={onCancel}
            instanceDomain={instanceDomain}
          />
        ))}
      </ul>
    </PopoverPanelShell>
  );
});

export { ScheduledPostsPopover };

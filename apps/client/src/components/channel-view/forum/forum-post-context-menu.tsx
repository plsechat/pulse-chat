import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu';
import { requestConfirmation } from '@/features/dialogs/actions';
import { useCan } from '@/features/server/hooks';
import { setActiveThreadId } from '@/features/server/channels/actions';
import { useOwnUserId } from '@/features/server/users/hooks';
import { getTRPCClient } from '@/lib/trpc';
import { Permission } from '@pulse/shared';
import {
  Bell,
  BellOff,
  ClipboardCopy,
  ExternalLink,
  Tags,
  Trash
} from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

type TForumPostContextMenuProps = {
  children: React.ReactNode;
  threadId: number;
  threadName: string;
  creatorId?: number;
  currentTagIds: number[];
  channelId: number;
  onEditTags: (threadId: number, currentTagIds: number[]) => void;
  onPostDeleted: () => void;
};

const ForumPostContextMenu = memo(
  ({
    children,
    threadId,
    threadName,
    creatorId,
    currentTagIds,
    channelId,
    onEditTags,
    onPostDeleted
  }: TForumPostContextMenuProps) => {
    const can = useCan();
    const ownUserId = useOwnUserId();
    const [following, setFollowing] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);

    const isCreator = creatorId === ownUserId;
    const canEditTags = isCreator || can(Permission.MANAGE_CHANNELS);
    const canDelete = can(Permission.MANAGE_CHANNELS);

    // Fetch follow status when menu opens
    useEffect(() => {
      if (!menuOpen) return;

      const trpc = getTRPCClient();
      trpc.threads.getFollowStatus
        .query({ threadId })
        .then((result) => setFollowing(result.following))
        .catch(() => {});
    }, [menuOpen, threadId]);

    const onOpenPost = useCallback(() => {
      setActiveThreadId(threadId);
    }, [threadId]);

    const onToggleFollow = useCallback(async () => {
      const trpc = getTRPCClient();
      const newState = !following;

      try {
        await trpc.threads.followThread.mutate({
          threadId,
          follow: newState
        });
        setFollowing(newState);
        toast.success(newState ? 'Following post' : 'Unfollowed post');
      } catch {
        toast.error('Failed to update follow status');
      }
    }, [threadId, following]);

    const onCopyLink = useCallback(() => {
      navigator.clipboard.writeText(`${channelId}/${threadId}`);
      toast.success('Link copied');
    }, [channelId, threadId]);

    const onDelete = useCallback(async () => {
      const choice = await requestConfirmation({
        title: 'Delete Post',
        message: `Are you sure you want to delete "${threadName}"? This will permanently remove the post and all its replies.`,
        confirmLabel: 'Delete',
        cancelLabel: 'Cancel'
      });

      if (!choice) return;

      const trpc = getTRPCClient();

      try {
        await trpc.threads.deleteForumPost.mutate({ threadId });
        toast.success('Post deleted');
        onPostDeleted();
      } catch {
        toast.error('Failed to delete post');
      }
    }, [threadId, threadName, onPostDeleted]);

    return (
      <ContextMenu onOpenChange={setMenuOpen}>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuItem onClick={onOpenPost}>
            <ExternalLink className="h-4 w-4" />
            Open Post
          </ContextMenuItem>

          <ContextMenuItem onClick={onToggleFollow}>
            {following ? (
              <BellOff className="h-4 w-4" />
            ) : (
              <Bell className="h-4 w-4" />
            )}
            {following ? 'Unfollow Post' : 'Follow Post'}
          </ContextMenuItem>

          {canEditTags && (
            <ContextMenuItem onClick={() => onEditTags(threadId, currentTagIds)}>
              <Tags className="h-4 w-4" />
              Edit Tags
            </ContextMenuItem>
          )}

          <ContextMenuSeparator />

          <ContextMenuItem onClick={onCopyLink}>
            <ClipboardCopy className="h-4 w-4" />
            Copy Link
          </ContextMenuItem>

          {canDelete && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={onDelete} variant="destructive">
                <Trash className="h-4 w-4" />
                Delete Post
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    );
  }
);

export { ForumPostContextMenu };

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
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
  Ellipsis,
  ExternalLink,
  Tags,
  Trash
} from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

type TForumPostMenuProps = {
  threadId: number;
  threadName: string;
  creatorId?: number;
  currentTagIds: number[];
  channelId: number;
  onEditTags: (threadId: number, currentTagIds: number[]) => void;
  onPostDeleted: () => void;
};

const ForumPostMenu = memo(
  ({
    threadId,
    threadName,
    creatorId,
    currentTagIds,
    channelId,
    onEditTags,
    onPostDeleted
  }: TForumPostMenuProps) => {
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
      <DropdownMenu onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="absolute top-2 right-2 h-6 w-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => e.stopPropagation()}
          >
            <Ellipsis className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-48" align="end">
          <DropdownMenuItem onClick={onOpenPost}>
            <ExternalLink className="h-4 w-4" />
            Open Post
          </DropdownMenuItem>

          <DropdownMenuItem onClick={onToggleFollow}>
            {following ? (
              <BellOff className="h-4 w-4" />
            ) : (
              <Bell className="h-4 w-4" />
            )}
            {following ? 'Unfollow Post' : 'Follow Post'}
          </DropdownMenuItem>

          {canEditTags && (
            <DropdownMenuItem onClick={() => onEditTags(threadId, currentTagIds)}>
              <Tags className="h-4 w-4" />
              Edit Tags
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          <DropdownMenuItem onClick={onCopyLink}>
            <ClipboardCopy className="h-4 w-4" />
            Copy Link
          </DropdownMenuItem>

          {canDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onDelete} variant="destructive">
                <Trash className="h-4 w-4" />
                Delete Post
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
);

export { ForumPostMenu };

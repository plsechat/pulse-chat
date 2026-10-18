import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu';
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
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import { Permission } from '@pulse/shared';
import {
  Archive,
  ArchiveRestore,
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
  archived: boolean;
  currentTagIds: number[];
  channelId: number;
  onEditTags: (threadId: number, currentTagIds: number[]) => void;
  onPostDeleted: () => void;
  /** The post was archived or unarchived; the list refetches. */
  onArchivedChange: () => void;
};

/**
 * Shared handler hook so the dropdown ellipsis trigger and the
 * right-click ContextMenu wrapper can share state without re-querying
 * the follow status twice.
 */
const useForumPostActions = (props: TForumPostMenuProps) => {
  const {
    threadId,
    threadName,
    channelId,
    archived,
    onPostDeleted,
    onArchivedChange
  } = props;
  const can = useCan();
  const ownUserId = useOwnUserId();
  const [following, setFollowing] = useState(false);

  const isCreator = props.creatorId === ownUserId;
  const canManage = can(Permission.MANAGE_CHANNELS);
  const canEditTags = isCreator || canManage;
  const canDelete = isCreator || canManage;
  // Archiving is a moderation action; reopening one's own post is not
  // (the server lets the author unarchive, see archive-thread.ts).
  const canToggleArchive = canManage || (archived && isCreator);

  const fetchFollowStatus = useCallback(() => {
    const trpc = getTRPCClient();
    if (!trpc) return;
    trpc.threads.getFollowStatus
      .query({ threadId })
      .then((result) => setFollowing(result.following))
      .catch(() => {});
  }, [threadId]);

  const onOpenPost = useCallback(() => {
    setActiveThreadId(threadId);
  }, [threadId]);

  const onToggleFollow = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) return;
    const newState = !following;
    try {
      await trpc.threads.followThread.mutate({
        threadId,
        follow: newState
      });
      setFollowing(newState);
      toast.success(newState ? 'Following post' : 'Unfollowed post');
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to update follow status'));
    }
  }, [threadId, following]);

  const onCopyLink = useCallback(() => {
    // Emits the deep-link token (`<#post:channelId/threadId>`) that the
    // renderer recognizes. Pasting this into any Pulse text field
    // produces a clickable badge that opens the forum and selects the
    // post. Round-trips through tiptap-to-tokens like channel mentions.
    navigator.clipboard.writeText(`<#post:${channelId}/${threadId}>`);
    toast.success('Post link copied');
  }, [channelId, threadId]);

  const onToggleArchive = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) return;
    try {
      await trpc.threads.archive.mutate({ threadId, archived: !archived });
      toast.success(archived ? 'Post unarchived' : 'Post archived');
      onArchivedChange();
    } catch (err) {
      toast.error(
        getTrpcError(
          err,
          archived ? 'Failed to unarchive post' : 'Failed to archive post'
        )
      );
    }
  }, [threadId, archived, onArchivedChange]);

  const onDelete = useCallback(async () => {
    const choice = await requestConfirmation({
      title: 'Delete Post',
      message: `Are you sure you want to delete "${threadName}"? This will permanently remove the post and all its replies.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel'
    });
    if (!choice) return;
    const trpc = getTRPCClient();
    if (!trpc) return;
    try {
      await trpc.threads.deleteThread.mutate({ threadId });
      toast.success('Post deleted');
      onPostDeleted();
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to delete post'));
    }
  }, [threadId, threadName, onPostDeleted]);

  return {
    following,
    canEditTags,
    canDelete,
    canToggleArchive,
    fetchFollowStatus,
    onOpenPost,
    onToggleFollow,
    onToggleArchive,
    onCopyLink,
    onDelete
  };
};

const ForumPostMenu = memo((props: TForumPostMenuProps) => {
  const { threadId, archived, currentTagIds, onEditTags } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const {
    following,
    canEditTags,
    canDelete,
    canToggleArchive,
    fetchFollowStatus,
    onOpenPost,
    onToggleFollow,
    onToggleArchive,
    onCopyLink,
    onDelete
  } = useForumPostActions(props);

  // Lazy-load follow status the first time the dropdown opens.
  useEffect(() => {
    if (menuOpen) fetchFollowStatus();
  }, [menuOpen, fetchFollowStatus]);

  return (
    <DropdownMenu onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Post options"
          className="absolute top-2 right-2 h-6 w-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 opacity-0 group-hover-or-touch:opacity-100 data-[state=open]:opacity-100 transition-opacity focus-visible:opacity-100"
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
          <DropdownMenuItem
            onClick={() => onEditTags(threadId, currentTagIds)}
          >
            <Tags className="h-4 w-4" />
            Edit Tags
          </DropdownMenuItem>
        )}
        {canToggleArchive && (
          <DropdownMenuItem onClick={onToggleArchive}>
            {archived ? (
              <ArchiveRestore className="h-4 w-4" />
            ) : (
              <Archive className="h-4 w-4" />
            )}
            {archived ? 'Unarchive Post' : 'Archive Post'}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onCopyLink}>
          <ClipboardCopy className="h-4 w-4" />
          Copy Post Link
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
});

/**
 * Right-click wrapper around a forum post card. Shares the same handler
 * hook as the ellipsis dropdown so both surfaces stay in sync (and the
 * follow status only fetches once per shared instance).
 */
const ForumPostContextMenu = memo(
  ({
    children,
    ...props
  }: TForumPostMenuProps & { children: React.ReactNode }) => {
    const { threadId, archived, currentTagIds, onEditTags } = props;
    const [menuOpen, setMenuOpen] = useState(false);
    const {
      following,
      canEditTags,
      canDelete,
      canToggleArchive,
      fetchFollowStatus,
      onOpenPost,
      onToggleFollow,
      onToggleArchive,
      onCopyLink,
      onDelete
    } = useForumPostActions(props);

    useEffect(() => {
      if (menuOpen) fetchFollowStatus();
    }, [menuOpen, fetchFollowStatus]);

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
            <ContextMenuItem
              onClick={() => onEditTags(threadId, currentTagIds)}
            >
              <Tags className="h-4 w-4" />
              Edit Tags
            </ContextMenuItem>
          )}
          {canToggleArchive && (
            <ContextMenuItem onClick={onToggleArchive}>
              {archived ? (
                <ArchiveRestore className="h-4 w-4" />
              ) : (
                <Archive className="h-4 w-4" />
              )}
              {archived ? 'Unarchive Post' : 'Archive Post'}
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={onCopyLink}>
            <ClipboardCopy className="h-4 w-4" />
            Copy Post Link
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

export { ForumPostMenu, ForumPostContextMenu };

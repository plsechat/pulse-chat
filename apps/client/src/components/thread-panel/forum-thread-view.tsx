import { TextChannel } from '@/components/channel-view/text';
import { ForumThreadContext } from '@/components/channel-view/forum/forum-thread-context';
import { Button } from '@/components/ui/button';
import { setActiveThreadId } from '@/features/server/channels/actions';
import { useActiveThread } from '@/features/server/channels/hooks';
import { useCan } from '@/features/server/hooks';
import { windowOrDefault } from '@/features/message-window';
import { useMessagesByChannelId } from '@/features/server/messages/hooks';
import { messageWindowByChannelIdSelector } from '@/features/server/messages/selectors';
import { useOwnUserId } from '@/features/server/users/hooks';
import type { IRootState } from '@/features/store';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import { Permission } from '@pulse/shared';
import { requestConfirmation } from '@/features/dialogs/actions';
import { useHistoryOverlay } from '@/hooks/use-history-overlay';
import { useIsMobile } from '@/hooks/use-is-mobile';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  MoreHorizontal,
  Trash2,
  X
} from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { toast } from 'sonner';

const ForumThreadView = memo(() => {
  const thread = useActiveThread();
  const threadId = thread?.id ?? 0;
  const messages = useMessagesByChannelId(threadId);
  const messageWindow = useSelector((state: IRootState) =>
    messageWindowByChannelIdSelector(state, threadId)
  );
  const { hasOlder } = windowOrDefault(messageWindow);
  const [showMenu, setShowMenu] = useState(false);
  const isMobile = useIsMobile();
  const can = useCan();
  const ownUserId = useOwnUserId();

  const onClose = useCallback(() => {
    setActiveThreadId(undefined);
  }, []);

  // On phones the thread replaces the post list (content-wrapper), so
  // the platform back gesture must return to the list, not leave.
  useHistoryOverlay(isMobile, onClose);

  const onArchive = useCallback(async () => {
    if (!thread) return;

    const trpc = getTRPCClient();
    if (!trpc) return;

    try {
      await trpc.threads.archive.mutate({
        threadId: thread.id,
        archived: !thread.archived
      });

      toast.success(
        thread.archived ? 'Thread unarchived' : 'Thread archived'
      );
      setShowMenu(false);
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to update thread'));
    }
  }, [thread]);

  const onDelete = useCallback(async () => {
    if (!thread) return;

    setShowMenu(false);

    const choice = await requestConfirmation({
      title: 'Delete Thread',
      message: `Are you sure you want to delete "${thread.name}"? This will permanently remove the thread and all its messages.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel'
    });

    if (!choice) return;

    const trpc = getTRPCClient();
    if (!trpc) return;

    try {
      await trpc.threads.deleteThread.mutate({ threadId: thread.id });
      toast.success('Thread deleted');
      setActiveThreadId(undefined);
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to delete thread'));
    }
  }, [thread]);

  // The post is the thread's oldest message. The store keeps messages
  // oldest-first, but only once no older page is left is messages[0]
  // really the post (and not merely the oldest loaded reply).
  const postMessage = useMemo(
    () => (!hasOlder && messages.length > 0 ? messages[0] : null),
    [hasOlder, messages]
  );
  const creatorUserId = postMessage?.userId ?? null;

  const contextValue = useMemo(
    () => ({ creatorUserId, postMessageId: postMessage?.id ?? null }),
    [creatorUserId, postMessage?.id]
  );

  if (!thread) return null;

  const canManage = can(Permission.MANAGE_CHANNELS);
  // Archiving is a moderation action; reopening one's own post is not
  // (the server allows the author to unarchive, see archive-thread.ts).
  const isCreator = creatorUserId !== null && creatorUserId === ownUserId;
  const canToggleArchive = canManage || (thread.archived && isCreator);
  const showMenuButton = canManage || canToggleArchive;

  return (
    <ForumThreadContext.Provider value={contextValue}>
      <div className="flex flex-col flex-1 h-full border-l border-border/30 overflow-hidden">
        {/* Header with thread title */}
        <div className="flex items-center gap-2 h-12 px-4 border-b border-border/30 flex-shrink-0">
          <span className="text-sm font-semibold truncate flex-1">
            {thread.name}
          </span>
          {thread.archived && (
            <span className="shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider bg-muted text-muted-foreground">
              <Archive className="w-3 h-3" />
              Archived
            </span>
          )}

          {/* Menu button */}
          {showMenuButton && (
            <div className="relative">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setShowMenu(!showMenu)}
                title="Thread options"
                aria-label="Thread options"
              >
                <MoreHorizontal className="w-4 h-4" />
              </Button>
              {showMenu && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setShowMenu(false)}
                  />
                  <div className="absolute right-0 top-full mt-1 w-44 bg-popover border border-border rounded-lg shadow-lg z-50 py-1">
                    {canToggleArchive && (
                      <button
                        type="button"
                        onClick={onArchive}
                        className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent/50 flex items-center gap-2"
                      >
                        {thread.archived ? (
                          <ArchiveRestore className="w-3.5 h-3.5" />
                        ) : (
                          <Archive className="w-3.5 h-3.5" />
                        )}
                        {thread.archived ? 'Unarchive' : 'Archive'}
                      </button>
                    )}
                    {canManage && (
                      <button
                        type="button"
                        onClick={onDelete}
                        className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent/50 flex items-center gap-2 text-destructive"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Delete
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Close button — on phones it reads as "back to the posts" */}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={onClose}
            title={isMobile ? 'Back' : 'Close thread'}
            aria-label={isMobile ? 'Back' : 'Close thread'}
          >
            {isMobile ? (
              <ArrowLeft className="w-4 h-4" />
            ) : (
              <X className="w-4 h-4" />
            )}
          </Button>
        </div>

        {/* Post body + replies: the opening message renders as the post
            (title, author, content, gallery) inside the message list,
            see ForumPostBody; the rows after it are the replies. */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <TextChannel channelId={thread.id} />
        </div>
      </div>
    </ForumThreadContext.Provider>
  );
});

export { ForumThreadView };

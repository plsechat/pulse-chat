import { TextChannel } from '@/components/channel-view/text';
import { ForumThreadContext } from '@/components/channel-view/forum/forum-thread-context';
import { Button } from '@/components/ui/button';
import { Protect } from '@/components/protect';
import { setActiveThreadId } from '@/features/server/channels/actions';
import { useActiveThread } from '@/features/server/channels/hooks';
import { useMessagesByChannelId } from '@/features/server/messages/hooks';
import { getTRPCClient } from '@/lib/trpc';
import { Permission } from '@pulse/shared';
import { Archive, MessageCircle, MoreHorizontal, X } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

const ForumThreadView = memo(() => {
  const thread = useActiveThread();
  const messages = useMessagesByChannelId(thread?.id ?? 0);
  const [showMenu, setShowMenu] = useState(false);

  const onClose = useCallback(() => {
    setActiveThreadId(undefined);
  }, []);

  const onArchive = useCallback(async () => {
    if (!thread) return;

    const trpc = getTRPCClient();

    try {
      await trpc.threads.archive.mutate({
        threadId: thread.id,
        archived: !thread.archived
      });

      toast.success(
        thread.archived ? 'Thread unarchived' : 'Thread archived'
      );
      setShowMenu(false);
    } catch {
      toast.error('Failed to update thread');
    }
  }, [thread]);

  // The OP is the author of the first (oldest) message in the thread
  // Messages are stored in chronological ascending order (oldest first)
  const creatorUserId = useMemo(() => {
    if (messages.length === 0) return null;
    return messages[0].userId;
  }, [messages]);

  const contextValue = useMemo(
    () => ({ creatorUserId }),
    [creatorUserId]
  );

  if (!thread) return null;

  return (
    <ForumThreadContext.Provider value={contextValue}>
      <div className="flex flex-col flex-1 h-full border-l border-border/30 overflow-hidden">
        {/* Header with thread title */}
        <div className="flex items-center gap-2 h-12 px-4 border-b border-border/30 flex-shrink-0">
          <span className="text-sm font-semibold truncate flex-1">
            {thread.name}
          </span>

          {/* Menu button */}
          <Protect permission={Permission.MANAGE_CHANNELS}>
            <div className="relative">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setShowMenu(!showMenu)}
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
                    <button
                      type="button"
                      onClick={onArchive}
                      className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent/50 flex items-center gap-2"
                    >
                      <Archive className="w-3.5 h-3.5" />
                      {thread.archived ? 'Unarchive' : 'Archive'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </Protect>

          {/* Close button */}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={onClose}
          >
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Thread title display area */}
        <div className="flex flex-col items-center justify-center py-8 px-4 border-b border-border/30">
          <MessageCircle className="w-10 h-10 text-muted-foreground/40 mb-2" />
          <h1 className="text-xl font-bold text-center">{thread.name}</h1>
        </div>

        {/* Thread messages */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <TextChannel channelId={thread.id} />
        </div>
      </div>
    </ForumThreadContext.Provider>
  );
});

export { ForumThreadView };

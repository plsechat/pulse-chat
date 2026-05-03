import { TextChannel } from '@/components/channel-view/text';
import { Button } from '@/components/ui/button';
import { requestConfirmation } from '@/features/dialogs/actions';
import { setActiveThreadId } from '@/features/server/channels/actions';
import { useActiveThread } from '@/features/server/channels/hooks';
import { useCan } from '@/features/server/hooks';
import { useMessagesByChannelId } from '@/features/server/messages/hooks';
import { useOwnUserId } from '@/features/server/users/hooks';
import { Protect } from '@/components/protect';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import { Permission } from '@pulse/shared';
import { Archive, MessageSquare, Trash2, X } from 'lucide-react';
import { memo, useCallback, useMemo } from 'react';
import { toast } from 'sonner';

const ThreadPanel = memo(() => {
  const thread = useActiveThread();
  const ownUserId = useOwnUserId();
  const can = useCan();
  // The thread's messages live under the thread-channel id. The thread
  // creator is whoever sent the first message in the thread (true for
  // both forum threads, where the creator authored the post itself,
  // and inline threads, which copy the source message in as the first
  // message). The hooks return [] until messages load — falling back
  // to "not creator" in that window is fine; the button just stays
  // hidden until we know.
  const threadMessages = useMessagesByChannelId(thread?.id ?? -1);
  const isCreator =
    !!thread &&
    threadMessages.length > 0 &&
    threadMessages[0].userId === ownUserId;
  // Only the creator can delete *while no foreign user has posted*.
  // Once anyone else posts, the thread is shared and only an admin
  // (MANAGE_CHANNELS) can remove it. Mirrors the server-side gate in
  // delete-thread.ts so the UI stays honest about what will succeed.
  const hasForeignMessage = useMemo(
    () => threadMessages.some((m) => m.userId !== ownUserId),
    [threadMessages, ownUserId]
  );
  const canDeleteAsCreator = isCreator && !hasForeignMessage;
  const canDelete = canDeleteAsCreator || can(Permission.MANAGE_CHANNELS);

  const onClose = useCallback(() => {
    setActiveThreadId(undefined);
  }, []);

  const onArchive = useCallback(async () => {
    if (!thread) return;

    const trpc = getTRPCClient();
    if (!trpc) return;

    try {
      await trpc.threads.archive.mutate({
        threadId: thread.id,
        archived: !thread.archived
      });

      toast.success(thread.archived ? 'Thread unarchived' : 'Thread archived');
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to update thread'));
    }
  }, [thread]);

  const onDelete = useCallback(async () => {
    if (!thread) return;

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

  if (!thread) return null;

  return (
    <div className="flex flex-col h-full w-80 border-l border-border bg-background">
      {/* Header */}
      <div className="flex items-center gap-2 h-12 px-3 border-b border-border flex-shrink-0">
        <MessageSquare className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium truncate flex-1">
          {thread.name}
        </span>
        <Protect permission={Permission.MANAGE_CHANNELS}>
          <Button
            variant="ghost"
            size="sm"
            onClick={onArchive}
            className="h-7 px-2"
            title={thread.archived ? 'Unarchive Thread' : 'Archive Thread'}
          >
            <Archive className="w-4 h-4" />
          </Button>
        </Protect>
        {/*
          Delete is shown to admins (MANAGE_CHANNELS) AND to the thread
          creator while nobody else has posted. Wrapping in <Protect>
          alone hid the button from creators of empty threads — which
          was the whole point of the create-thread-by-accident escape
          hatch. The server's delete-thread route enforces the same
          two cases so the toast still surfaces if they're somehow
          allowed by the UI but not by the server.
        */}
        {canDelete && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            className="h-7 px-2 text-destructive hover:text-destructive"
            title={
              canDeleteAsCreator
                ? 'Delete (only while empty)'
                : 'Delete Thread'
            }
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="h-7 px-2"
        >
          <X className="w-4 h-4" />
        </Button>
      </div>

      {/* Thread content - reuses TextChannel */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <TextChannel channelId={thread.id} />
      </div>
    </div>
  );
});

export { ThreadPanel };

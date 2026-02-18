import { TextChannel } from '@/components/channel-view/text';
import { Button } from '@/components/ui/button';
import { setActiveThreadId } from '@/features/server/channels/actions';
import { useActiveThread } from '@/features/server/channels/hooks';
import { Archive, MessageSquare, X } from 'lucide-react';
import { memo, useCallback } from 'react';
import { toast } from 'sonner';
import { getTRPCClient } from '@/lib/trpc';
import { Protect } from '@/components/protect';
import { Permission } from '@pulse/shared';

const ThreadPanel = memo(() => {
  const thread = useActiveThread();

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

      toast.success(thread.archived ? 'Thread unarchived' : 'Thread archived');
    } catch {
      toast.error('Failed to update thread');
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

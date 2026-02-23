import { TextChannel } from '@/components/channel-view/text';
import { Button } from '@/components/ui/button';
import { Protect } from '@/components/protect';
import { setActiveThreadId } from '@/features/server/channels/actions';
import { useActiveThread } from '@/features/server/channels/hooks';
import { getTRPCClient } from '@/lib/trpc';
import { Permission } from '@pulse/shared';
import { Archive, ArrowLeft } from 'lucide-react';
import { memo, useCallback } from 'react';
import { toast } from 'sonner';

const ForumThreadView = memo(() => {
  const thread = useActiveThread();

  const onBack = useCallback(() => {
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
    } catch {
      toast.error('Failed to update thread');
    }
  }, [thread]);

  if (!thread) return null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 h-12 px-3 border-b border-border flex-shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="h-7 px-2 gap-1"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
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
      </div>

      {/* Full-width thread content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <TextChannel channelId={thread.id} />
      </div>
    </div>
  );
});

export { ForumThreadView };

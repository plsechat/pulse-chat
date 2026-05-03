import { setActiveThreadId } from '@/features/server/channels/actions';
import { useChannelById } from '@/features/server/channels/hooks';
import { channelReadStateByIdSelector } from '@/features/server/channels/selectors';
import type { IRootState } from '@/features/store';
import { MessageSquare } from 'lucide-react';
import { memo, useCallback } from 'react';
import { useSelector } from 'react-redux';

type TThreadIndicatorProps = {
  threadId: number;
};

const ThreadIndicator = memo(({ threadId }: TThreadIndicatorProps) => {
  const thread = useChannelById(threadId);
  // Read state for the thread channel itself — same source the sidebar
  // uses so the badge and the channel list stay in sync. Without this
  // a sound notification fires for thread activity but the user has no
  // visual cue showing where the noise came from.
  const unreadCount = useSelector((s: IRootState) =>
    channelReadStateByIdSelector(s, threadId)
  );

  const onClick = useCallback(() => {
    setActiveThreadId(threadId);
  }, [threadId]);

  if (!thread) return null;

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 mt-1 pl-1 cursor-pointer transition-colors"
    >
      <span className="relative inline-flex">
        <MessageSquare className="w-3 h-3" />
        {unreadCount > 0 && (
          <span
            className="absolute -top-1.5 -right-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-bold text-destructive-foreground"
            aria-label={`${unreadCount} unread`}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </span>
      <span className="font-medium">{thread.name}</span>
    </button>
  );
});

export { ThreadIndicator };

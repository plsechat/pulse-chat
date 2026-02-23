import { ForumChannel } from '@/components/channel-view/forum';
import { TextChannel } from '@/components/channel-view/text';
import { VoiceChannel } from '@/components/channel-view/voice';
import { ForumThreadView } from '@/components/thread-panel/forum-thread-view';
import { ThreadPanel } from '@/components/thread-panel';
import {
  useActiveThread,
  useActiveThreadId,
  useSelectedChannelId,
  useSelectedChannelType
} from '@/features/server/channels/hooks';
import { useServerName } from '@/features/server/hooks';
import { ChannelType } from '@pulse/shared';
import { memo } from 'react';

const ContentWrapper = memo(() => {
  const selectedChannelId = useSelectedChannelId();
  const selectedChannelType = useSelectedChannelType();
  const serverName = useServerName();
  const activeThreadId = useActiveThreadId();
  const activeThread = useActiveThread();

  // Forum threads replace the main content instead of a side panel
  const isForumThread =
    activeThread && selectedChannelType === ChannelType.FORUM;

  let content;

  if (isForumThread) {
    content = <ForumThreadView key={activeThreadId} />;
  } else if (selectedChannelId) {
    if (selectedChannelType === ChannelType.TEXT) {
      content = (
        <TextChannel key={selectedChannelId} channelId={selectedChannelId} />
      );
    } else if (selectedChannelType === ChannelType.VOICE) {
      content = (
        <VoiceChannel key={selectedChannelId} channelId={selectedChannelId} />
      );
    } else if (selectedChannelType === ChannelType.FORUM) {
      content = (
        <ForumChannel key={selectedChannelId} channelId={selectedChannelId} />
      );
    }
  } else {
    content = (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
        <h2 className="text-2xl font-semibold text-foreground">
          Welcome to <span className="font-bold">{serverName}</span>
        </h2>
        <p className="text-sm text-muted-foreground">
          Select a channel to get started
        </p>
      </div>
    );
  }

  return (
    <main className="flex flex-1 relative overflow-hidden">
      <div className="flex flex-1 flex-col overflow-hidden">
        {content}
      </div>
      {activeThreadId && !isForumThread && (
        <ThreadPanel key={activeThreadId} />
      )}
    </main>
  );
});

export { ContentWrapper };

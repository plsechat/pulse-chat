import { ForumChannel } from '@/components/channel-view/forum';
import { TextChannel } from '@/components/channel-view/text';
import { VoiceChannel } from '@/components/channel-view/voice';
import { ForumThreadView } from '@/components/thread-panel/forum-thread-view';
import { ThreadPanel } from '@/components/thread-panel';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup
} from '@/components/ui/resizable';
import {
  useActiveThreadId,
  useSelectedChannelId,
  useSelectedChannelType
} from '@/features/server/channels/hooks';
import {
  useConnectedServerPublicId,
  useServerName
} from '@/features/server/hooks';
import { ChannelType } from '@pulse/shared';
import { memo, useCallback, useState } from 'react';

const FORUM_LAYOUT_KEY = 'forum-panel-layout';
const DEFAULT_LAYOUT = { 'forum-posts': 40, 'forum-thread': 60 };

function getSavedLayout() {
  try {
    const saved = localStorage.getItem(FORUM_LAYOUT_KEY);
    if (saved) return JSON.parse(saved) as Record<string, number>;
  } catch { /* ignore */ }
  return DEFAULT_LAYOUT;
}

const ContentWrapper = memo(() => {
  const selectedChannelId = useSelectedChannelId();
  const selectedChannelType = useSelectedChannelType();
  const serverName = useServerName();
  const activeThreadId = useActiveThreadId();
  const connectedServerPublicId = useConnectedServerPublicId();

  // Content components remount via `key` when the channel changes.
  // Numeric channel ids COLLIDE across federated instances (a remote
  // server's "General Text" can share our home channel's id), so a bare
  // id key wouldn't remount when switching instances while the same id
  // stays selected — leaving stale content and never refetching history.
  //
  // Scope by the CONNECTED server's publicId, which flips atomically with
  // setInitialData's slice replacement — NOT by activeInstanceDomain,
  // which flips optimistically before the remote data lands. Keying on
  // the optimistic flip made the remounted view fetch BEFORE
  // setInitialData cleared messagesMap, wiping the just-loaded history.
  const serverScope = connectedServerPublicId ?? 'connecting';
  const channelKey = `${serverScope}:${selectedChannelId}`;
  const threadKey = `${serverScope}:${activeThreadId}`;

  const isForum = selectedChannelType === ChannelType.FORUM;

  const [savedLayout] = useState(getSavedLayout);

  const onLayoutChanged = useCallback((layout: Record<string, number>) => {
    localStorage.setItem(FORUM_LAYOUT_KEY, JSON.stringify(layout));
  }, []);

  // Forum with active thread: resizable two-panel layout
  if (selectedChannelId && isForum && activeThreadId) {
    return (
      <main className="flex flex-1 relative overflow-hidden">
        <ResizablePanelGroup
          orientation="horizontal"
          defaultLayout={savedLayout}
          onLayoutChanged={onLayoutChanged}
        >
          <ResizablePanel id="forum-posts" minSize="15" maxSize="85">
            <ForumChannel key={channelKey} channelId={selectedChannelId} />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel id="forum-thread" minSize="15">
            <ForumThreadView key={threadKey} />
          </ResizablePanel>
        </ResizablePanelGroup>
      </main>
    );
  }

  let content;

  if (selectedChannelId) {
    if (selectedChannelType === ChannelType.TEXT) {
      content = (
        <TextChannel key={channelKey} channelId={selectedChannelId} />
      );
    } else if (selectedChannelType === ChannelType.VOICE) {
      content = (
        <VoiceChannel key={channelKey} channelId={selectedChannelId} />
      );
    } else if (isForum) {
      content = (
        <ForumChannel key={channelKey} channelId={selectedChannelId} />
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
      {/* Non-forum: standard thread side panel */}
      {activeThreadId && !isForum && (
        <ThreadPanel key={threadKey} />
      )}
    </main>
  );
});

export { ContentWrapper };

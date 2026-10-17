import { ForumChannel } from '@/components/channel-view/forum';
import { TextChannel } from '@/components/channel-view/text';
import { VoiceChannel } from '@/components/channel-view/voice';
import { ThreadPanel } from '@/components/thread-panel';
import { ForumThreadView } from '@/components/thread-panel/forum-thread-view';
import { LazyFallback } from '@/components/lazy-fallback';
import { EventSurfaces } from '@/components/raid-planner/hosts';
import { usePlannerOpen } from '@/features/events/hooks';
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
import { useIsMobile } from '@/hooks/use-is-mobile';
import { ChannelType } from '@pulse/shared';
import { lazy, memo, Suspense, useCallback, useState } from 'react';

// The planner is an app of its own (calendar, roster grid, editor) and
// loads the first time its row is selected.
const RaidPlanner = lazy(() =>
  import('@/components/raid-planner').then((m) => ({ default: m.RaidPlanner }))
);

const FORUM_LAYOUT_KEY = 'forum-panel-layout';
const DEFAULT_LAYOUT = { 'forum-posts': 40, 'forum-thread': 60 };

function getSavedLayout() {
  try {
    const saved = localStorage.getItem(FORUM_LAYOUT_KEY);
    if (saved) return JSON.parse(saved) as Record<string, number>;
  } catch {
    /* ignore */
  }
  return DEFAULT_LAYOUT;
}

const ContentWrapper = memo(() => {
  const selectedChannelId = useSelectedChannelId();
  const selectedChannelType = useSelectedChannelType();
  const serverName = useServerName();
  const activeThreadId = useActiveThreadId();
  const connectedServerPublicId = useConnectedServerPublicId();
  const isMobile = useIsMobile();
  const plannerOpen = usePlannerOpen();

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

  // Forum with active thread: resizable two-panel layout. At phone
  // width a 40/60 split leaves ~150px per pane — the open thread takes
  // the whole pane instead and its X is the way back to the post list.
  if (selectedChannelId && isForum && activeThreadId && isMobile) {
    return (
      <main className="flex flex-1 relative overflow-hidden">
        <ForumThreadView key={threadKey} />
        <EventSurfaces />
      </main>
    );
  }

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
        <EventSurfaces />
      </main>
    );
  }

  let content;

  // The planner row clears the channel selection, so the two never
  // compete for the pane (features/events/selectors plannerOpenSelector).
  if (plannerOpen) {
    content = (
      <Suspense fallback={<LazyFallback />}>
        <RaidPlanner key={serverScope} />
      </Suspense>
    );
  } else if (selectedChannelId) {
    if (selectedChannelType === ChannelType.TEXT) {
      content = <TextChannel key={channelKey} channelId={selectedChannelId} />;
    } else if (selectedChannelType === ChannelType.VOICE) {
      content = <VoiceChannel key={channelKey} channelId={selectedChannelId} />;
    } else if (isForum) {
      content = <ForumChannel key={channelKey} channelId={selectedChannelId} />;
    }
  } else {
    content = (
      <div className="view-enter flex flex-col items-center justify-center h-full gap-5 p-8 text-center">
        <div
          aria-hidden
          className="squircle flex h-24 w-24 items-center justify-center text-4xl font-bold text-foreground ring-1 ring-white/10"
          style={{
            background:
              'radial-gradient(120% 120% at 20% 10%, oklch(from var(--community) l c h / 0.55), oklch(from var(--community) l c h / 0.12))'
          }}
        >
          {(serverName ?? '?').charAt(0).toUpperCase()}
        </div>
        <div className="space-y-1.5">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            Welcome to {serverName}
          </h2>
          <p className="text-sm text-muted-foreground">
            Pick a channel on the left to start talking, or hop into voice.
          </p>
        </div>
      </div>
    );
  }

  return (
    <main className="flex flex-1 relative overflow-hidden">
      <div className="flex flex-1 flex-col overflow-hidden">{content}</div>
      {/* Non-forum: standard thread side panel */}
      {activeThreadId && !isForum && <ThreadPanel key={threadKey} />}
      {/* Event sheet + editor: open from the planner, a chat card or a reminder */}
      <EventSurfaces />
    </main>
  );
});

export { ContentWrapper };

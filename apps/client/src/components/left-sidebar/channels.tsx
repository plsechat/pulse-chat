import { TypingDots } from '@/components/typing-dots';
import { setSelectedChannelId } from '@/features/server/channels/actions';
import {
  useChannelById,
  useChannelsByCategoryId,
  useCurrentVoiceChannelPublicId,
  useSelectedChannelId
} from '@/features/server/channels/hooks';
import {
  useCan,
  useChannelCan,
  useMentionCount,
  usePreviewMode,
  useTypingUsersByChannelId,
  useUnreadMessagesCount,
  useVoiceUsersByChannelId
} from '@/features/server/hooks';
import { joinVoice } from '@/features/server/voice/actions';
import {
  useVoice,
  useVoiceChannelExternalStreamsList
} from '@/features/server/voice/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { emitAppEvent } from '@/lib/events';
import { getTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import {
  DndContext,
  type DragEndEvent,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { TChannel } from '@pulse/server/types';
import { ChannelPermission, ChannelType, Permission } from '@pulse/shared';
import { Hash, LayoutList, Volume2 } from 'lucide-react';
import { memo, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { ChannelContextMenu } from '../context-menus/channel';
import { VoiceTimer } from '../top-bar/voice-timer';
import { ExternalStream } from './external-stream';
import { VoiceUser } from './voice-user';

type TVoiceProps = Omit<TItemWrapperProps, 'children'> & {
  channel: TChannel;
  isInVoice?: boolean;
};

const Voice = memo(({ channel, isInVoice, ...props }: TVoiceProps) => {
  const users = useVoiceUsersByChannelId(channel.id);
  const externalStreams = useVoiceChannelExternalStreamsList(channel.id);
  const unreadCount = useUnreadMessagesCount(channel.id);
  const mentionCount = useMentionCount(channel.id);
  const hasActiveSession = users.length > 0;
  const hasMentions = mentionCount > 0;

  return (
    <>
      <ItemWrapper
        {...props}
        hasUnread={unreadCount > 0}
        className={cn(
          props.className,
          isInVoice && 'text-foreground [&>svg]:text-green-400'
        )}
      >
        <span
          className={cn(
            'channel-tile flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
            (isInVoice || hasActiveSession) && 'bg-live/20 text-live'
          )}
        >
          <Volume2 className="h-4 w-4" />
        </span>
        {/* Connected state: full-contrast semibold — the live tile and
            timer already say "connected"; no glow filters on text. */}
        <span
          className={cn(
            'flex-1 min-w-0 truncate',
            isInVoice && 'font-semibold text-foreground'
          )}
        >
          {channel.name}
        </span>
        {hasActiveSession && <VoiceTimer channelId={channel.id} />}
        {!hasActiveSession && unreadCount > 0 && (
          <div
            className={cn(
              'badge-pop ml-auto flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold',
              hasMentions
                ? 'bg-destructive text-white'
                : 'bg-foreground/10 text-foreground'
            )}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </div>
        )}
      </ItemWrapper>
      {channel.type === 'VOICE' && (
        <div className="ml-6 space-y-1 mt-1">
          {users.map((user) => (
            <VoiceUser
              key={user.id}
              userId={user.id}
              user={user}
              channelId={channel.id}
            />
          ))}
          {externalStreams.map((stream) => (
            <ExternalStream
              key={stream.streamId}
              title={stream.title}
              tracks={stream.tracks}
              pluginId={stream.pluginId}
              avatarUrl={stream.avatarUrl}
            />
          ))}
        </div>
      )}
    </>
  );
});

type TTextProps = Omit<TItemWrapperProps, 'children'> & {
  channel: TChannel;
};

const Text = memo(({ channel, ...props }: TTextProps) => {
  const typingUsers = useTypingUsersByChannelId(channel.id);
  const unreadCount = useUnreadMessagesCount(channel.id);
  const mentionCount = useMentionCount(channel.id);
  const hasTypingUsers = typingUsers.length > 0;
  const hasMentions = mentionCount > 0;

  return (
    <ItemWrapper {...props} hasUnread={unreadCount > 0}>
      <span className="channel-tile flex h-7 w-7 shrink-0 items-center justify-center rounded-lg">
        <Hash className="h-4 w-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate">{channel.name}</span>
        {channel.topic && (
          // Context only: the row's accessible name stays the channel name
          // (the header announces the topic).
          <span
            aria-hidden
            className="truncate text-[11px] font-normal text-muted-foreground/70"
          >
            {channel.topic}
          </span>
        )}
      </span>
      {hasTypingUsers && (
        <div className="flex items-center gap-0.5 ml-auto">
          <TypingDots className="space-x-0.5" />
        </div>
      )}
      {!hasTypingUsers && unreadCount > 0 && (
        <div
          className={cn(
            'badge-pop ml-auto flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold',
            hasMentions
              ? 'bg-destructive text-white'
              : 'bg-foreground/10 text-foreground'
          )}
        >
          {unreadCount > 99 ? '99+' : unreadCount}
        </div>
      )}
    </ItemWrapper>
  );
});

type TForumProps = Omit<TItemWrapperProps, 'children'> & {
  channel: TChannel;
};

const Forum = memo(({ channel, ...props }: TForumProps) => {
  const unreadCount = useUnreadMessagesCount(channel.id);
  const mentionCount = useMentionCount(channel.id);
  const hasMentions = mentionCount > 0;

  return (
    <ItemWrapper {...props} hasUnread={unreadCount > 0}>
      <span className="channel-tile flex h-7 w-7 shrink-0 items-center justify-center rounded-lg">
        <LayoutList className="h-4 w-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate">{channel.name}</span>
        {channel.topic && (
          // Context only: the row's accessible name stays the channel name
          // (the header announces the topic).
          <span
            aria-hidden
            className="truncate text-[11px] font-normal text-muted-foreground/70"
          >
            {channel.topic}
          </span>
        )}
      </span>
      {unreadCount > 0 && (
        <div
          className={cn(
            'badge-pop ml-auto flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold',
            hasMentions
              ? 'bg-destructive text-white'
              : 'bg-foreground/10 text-foreground'
          )}
        >
          {unreadCount > 99 ? '99+' : unreadCount}
        </div>
      )}
    </ItemWrapper>
  );
});

type TItemWrapperProps = {
  children: React.ReactNode;
  className?: string;
  isSelected: boolean;
  hasUnread?: boolean;
  onClick: () => void;
  dragHandleProps?: React.HTMLAttributes<HTMLDivElement>;
  style?: React.CSSProperties;
  disabled?: boolean;
};

const ItemWrapper = memo(
  ({
    children,
    isSelected,
    hasUnread = false,
    onClick,
    className,
    dragHandleProps,
    style,
    disabled = false
  }: TItemWrapperProps) => {
    return (
      <div
        {...dragHandleProps}
        style={style}
        className={cn(
          'relative flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground select-none cursor-pointer transition-colors duration-150',
          {
            'channel-row-active text-foreground font-medium': isSelected,
            'text-foreground font-semibold': hasUnread && !isSelected,
            'cursor-default opacity-50 hover:bg-transparent hover:text-muted-foreground':
              disabled
          },
          className
        )}
        onClick={disabled ? undefined : onClick}
      >
        {children}
      </div>
    );
  }
);

type TChannelProps = {
  channelId: number;
  isSelected: boolean;
};

const Channel = memo(({ channelId, isSelected }: TChannelProps) => {
  const channel = useChannelById(channelId);
  const currentVoiceChannelPublicId = useCurrentVoiceChannelPublicId();
  // Whether the user's active voice session is THIS channel. Matched by the
  // globally-unique publicId, not the numeric id — a federated server's
  // channel can share our home channel's numeric id and would falsely glow.
  const isInThisVoice =
    !!channel?.publicId && currentVoiceChannelPublicId === channel.publicId;
  const channelCan = useChannelCan(channelId);
  const can = useCan();
  const previewMode = usePreviewMode();
  const { init } = useVoice();

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: channelId });

  const onClick = useCallback(async () => {
    // Previews are read-only — voice joins would be refused server-side
    if (previewMode && channel?.type === ChannelType.VOICE) {
      toast.info('Join the server to use voice channels');
      return;
    }

    setSelectedChannelId(channelId);
    emitAppEvent('channel-selected', { channelId });

    if (channel?.type === ChannelType.VOICE && !isInThisVoice) {
      const response = await joinVoice(channelId);

      if (!response) {
        // joinVoice has already told the user why.
        setSelectedChannelId(undefined);

        return;
      }

      try {
        await init(response, channelId);
      } catch {
        setSelectedChannelId(undefined);
        toast.error('Failed to initialize voice connection');
      }
    }
  }, [channelId, channel?.type, init, isInThisVoice, previewMode]);

  if (!channel) {
    return null;
  }

  if (!channelCan(ChannelPermission.VIEW_CHANNEL)) return null;

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform && { ...transform, x: 0 }),
        transition,
        opacity: isDragging ? 0.5 : 1
      }}
    >
      <ChannelContextMenu channelId={channelId}>
        <div>
          {channel.type === 'TEXT' && (
            <Text
              channel={channel}
              isSelected={isSelected}
              onClick={onClick}
              dragHandleProps={{ ...attributes, ...listeners }}
            />
          )}
          {channel.type === 'VOICE' && (
            <Voice
              channel={channel}
              isSelected={isSelected}
              isInVoice={isInThisVoice}
              onClick={onClick}
              dragHandleProps={{ ...attributes, ...listeners }}
              disabled={
                !channelCan(ChannelPermission.JOIN) ||
                !can(Permission.JOIN_VOICE_CHANNELS)
              }
            />
          )}
          {channel.type === 'FORUM' && (
            <Forum
              channel={channel}
              isSelected={isSelected}
              onClick={onClick}
              dragHandleProps={{ ...attributes, ...listeners }}
            />
          )}
        </div>
      </ChannelContextMenu>
    </div>
  );
});

type TChannelsProps = {
  categoryId: number;
};

const Channels = memo(({ categoryId }: TChannelsProps) => {
  const channels = useChannelsByCategoryId(categoryId);
  const selectedChannelId = useSelectedChannelId();
  const channelIds = useMemo(() => channels.map((ch) => ch.id), [channels]);
  const can = useCan();

  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: 8
      }
    }),
    // Touch: a long press starts the reorder; a plain drag scrolls the
    // list as the platform expects (PointerSensor alone got cancelled
    // by the scroll before the distance threshold was met).
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 250,
        tolerance: 5
      }
    })
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;

      if (!over || active.id === over.id) {
        return;
      }

      const oldIndex = channelIds.indexOf(active.id as number);
      const newIndex = channelIds.indexOf(over.id as number);

      if (oldIndex === -1 || newIndex === -1) {
        return;
      }

      const reorderedIds = [...channelIds];
      const [movedId] = reorderedIds.splice(oldIndex, 1);

      reorderedIds.splice(newIndex, 0, movedId);

      try {
        const trpc = getTRPCClient();
        if (!trpc) return;

        await trpc.channels.reorder.mutate({
          categoryId,
          channelIds: reorderedIds
        });
      } catch (error) {
        toast.error(getTrpcError(error, 'Failed to reorder channels'));
      }
    },
    [categoryId, channelIds]
  );

  return (
    <div className="space-y-0.5">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={channelIds}
          strategy={verticalListSortingStrategy}
          disabled={!can(Permission.MANAGE_CHANNELS)}
        >
          {channels.map((channel) => (
            <Channel
              key={channel.id}
              channelId={channel.id}
              isSelected={selectedChannelId === channel.id}
            />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
});

export { Channels };

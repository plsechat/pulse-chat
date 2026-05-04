import { UserPopover } from '@/components/user-popover';
import {
  setActiveThreadId,
  setHighlightedMessageId,
  setSelectedChannelId
} from '@/features/server/channels/actions';
import { useChannelById } from '@/features/server/channels/hooks';
import { useRoleById } from '@/features/server/roles/hooks';
import { useUserById } from '@/features/server/users/hooks';
import { getDisplayName } from '@/helpers/get-display-name';
import { LayoutList, MessageSquare } from 'lucide-react';
import { memo, useCallback } from 'react';

type TMentionOverrideProps = {
  type: 'user' | 'role' | 'all';
  id: number;
  name: string;
};

const UserMention = memo(({ id, name }: { id: number; name: string }) => {
  const user = useUserById(id);
  const displayName = user ? getDisplayName(user) : name;
  const isFederated = user?._identity?.includes('@');

  return (
    <UserPopover userId={id}>
      <span className={isFederated ? 'mention mention-federated' : 'mention'}>
        @{displayName}{isFederated && <span className="mention-fed-icon" aria-label="Federated user">🌐</span>}
      </span>
    </UserPopover>
  );
});

const RoleMention = memo(({ id, name }: { id: number; name: string }) => {
  const role = useRoleById(id);
  const displayName = role?.name ?? name;
  const color = role?.color;

  return (
    <span
      className="mention"
      style={
        color
          ? {
              color,
              backgroundColor: `${color}26`
            }
          : undefined
      }
    >
      @{displayName}
    </span>
  );
});

const AllMention = memo(() => {
  return (
    <span className="mention" style={{ color: '#f59e0b', backgroundColor: '#f59e0b26' }}>
      @all
    </span>
  );
});

const MentionOverride = memo(({ type, id, name }: TMentionOverrideProps) => {
  if (type === 'all') {
    return <AllMention />;
  }

  if (type === 'user') {
    return <UserMention id={id} name={name} />;
  }

  return <RoleMention id={id} name={name} />;
});

const ChannelMention = memo(({ id, name }: { id: number; name: string }) => {
  const channel = useChannelById(id);
  const displayName = channel?.name ?? name;
  const isForumPost = channel?.type === 'THREAD' && channel.parentChannelId;

  const handleClick = useCallback(() => {
    if (isForumPost) {
      setSelectedChannelId(channel!.parentChannelId!);
      setActiveThreadId(id);
    } else {
      setSelectedChannelId(id);
    }
  }, [id, isForumPost, channel]);

  return (
    <span
      className="mention"
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') handleClick();
      }}
    >
      #{displayName}
    </span>
  );
});

/**
 * Renders a `<#post:channelId/threadId>` token as a clickable badge that
 * navigates to the forum and opens the post. The companion to
 * `<#msg:.../...>` (MessageLink). Both replace the previous "Copy Post
 * ID" / "Copy Message ID" patterns that copied bare `N/M` strings the
 * renderer didn't recognize.
 */
const ForumPostLink = memo(
  ({ channelId, threadId }: { channelId: number; threadId: number }) => {
    const thread = useChannelById(threadId);
    const handleClick = useCallback(() => {
      setSelectedChannelId(channelId);
      setActiveThreadId(threadId);
    }, [channelId, threadId]);

    return (
      <span
        className="mention inline-flex items-center gap-1"
        onClick={handleClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleClick();
        }}
      >
        <LayoutList className="h-3 w-3" />
        {thread?.name ?? `Post #${threadId}`}
      </span>
    );
  }
);

/**
 * Renders a `<#msg:channelId/messageId>` token. Click switches to the
 * channel and uses the existing scroll-to-message highlight pulse to
 * land on the message. Falls back to a label-only badge if the channel
 * isn't loaded.
 */
const MessageLink = memo(
  ({ channelId, messageId }: { channelId: number; messageId: number }) => {
    const channel = useChannelById(channelId);
    const handleClick = useCallback(() => {
      setSelectedChannelId(channelId);
      // Channel selection is async (messages load); the highlight effect
      // tolerates the message not being in the DOM yet — it'll latch on
      // when the row mounts. Same hook the existing reply-jump uses.
      setHighlightedMessageId(messageId);
    }, [channelId, messageId]);

    return (
      <span
        className="mention inline-flex items-center gap-1"
        onClick={handleClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleClick();
        }}
      >
        <MessageSquare className="h-3 w-3" />
        Message in {channel?.name ?? `#${channelId}`}
      </span>
    );
  }
);

export { ChannelMention, ForumPostLink, MentionOverride, MessageLink };

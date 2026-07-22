import { useChatScroll } from '@/components/chat-primitives/use-chat-scroll';
import { useConnectedServerPublicId } from '@/features/server/hooks';
import { peekPendingJump } from '@/features/server/messages/jump';
import { LocalStorageKey } from '@/helpers/storage';
import { useCallback } from 'react';

/**
 * Channel-side adapter over the shared useChatScroll: builds the
 * federation-scoped position key, wires the jump-latch, and opts into
 * detached-window paging and new-messages-divider landing (all
 * channel-only). DMs call useChatScroll directly.
 */
type TUseScrollControllerProps = {
  channelId: number;
  messages: unknown[];
  fetching: boolean;
  hasMore: boolean;
  loadMore: () => Promise<unknown>;
  detached?: boolean;
  loadNewer?: () => Promise<unknown>;
};

const useScrollController = ({
  channelId,
  messages,
  fetching,
  hasMore,
  loadMore,
  detached = false,
  loadNewer
}: TUseScrollControllerProps) => {
  const serverPublicId = useConnectedServerPublicId();
  // Bare numeric channel ids collide across federated instances, so key
  // on the connected server's publicId (same reason the content wrapper
  // keys the view on it).
  const posKey = `${serverPublicId ?? 'connecting'}:${channelId}`;

  const isJumpPending = useCallback(
    () => !!peekPendingJump(channelId),
    [channelId]
  );

  return useChatScroll({
    posKey,
    storageKey: LocalStorageKey.SCROLL_POSITIONS,
    messages,
    fetching,
    hasMore,
    loadMore,
    detached,
    loadNewer,
    isJumpPending,
    landOnNewMessagesDivider: true
  });
};

export { useScrollController };

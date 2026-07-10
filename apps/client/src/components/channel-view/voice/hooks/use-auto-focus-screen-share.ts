import type { TVoiceUser } from '@/features/server/types';
import { useEffect, useRef } from 'react';
import { PinnedCardType, type TPinnedCard } from './use-pin-card-controller';

/**
 * Auto-focus the pinned layout around screen shares.
 *
 * When a NEW sharer appears and nothing is pinned, their screen-share
 * card is pinned automatically — an existing pin is never stolen. When
 * the currently-pinned screen share ends (the sharer stopped sharing
 * or left the call), the pin is released.
 */
const useAutoFocusScreenShare = (
  voiceUsers: TVoiceUser[],
  pinnedCard: TPinnedCard | undefined,
  pinCard: (card: TPinnedCard) => void,
  unpinCard: () => void
) => {
  const prevSharerIdsRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    const sharerIds = new Set(
      voiceUsers
        .filter((voiceUser) => voiceUser.state.sharingScreen)
        .map((voiceUser) => voiceUser.id)
    );
    const prevSharerIds = prevSharerIdsRef.current;
    prevSharerIdsRef.current = sharerIds;

    if (!pinnedCard) {
      const newSharerId = [...sharerIds].find((id) => !prevSharerIds.has(id));

      if (newSharerId !== undefined) {
        pinCard({
          id: `screen-share-${newSharerId}`,
          type: PinnedCardType.SCREEN_SHARE,
          userId: newSharerId
        });
      }

      return;
    }

    if (
      pinnedCard.type === PinnedCardType.SCREEN_SHARE &&
      !sharerIds.has(pinnedCard.userId)
    ) {
      unpinCard();
    }
  }, [voiceUsers, pinnedCard, pinCard, unpinCard]);
};

export { useAutoFocusScreenShare };

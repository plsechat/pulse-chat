import type { TWatchTarget } from '@/features/app/deck';
import { watchCardOf } from '@/features/server/voice/watch-together';
import type { IRootState } from '@/features/store';
import { subscribe } from '@/lib/subscription-helpers';
import { getTRPCClient } from '@/lib/trpc';
import type { TWatchCard } from '@pulse/shared';
import { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';

/**
 * The card as it is now. The message lives in the channel's loaded
 * window, where the ordinary MESSAGE_UPDATE handling keeps it current;
 * while it is not there (the channel was never opened in this session,
 * or its window moved on), the player follows the same event directly
 * so a pause from the channel still reaches an open panel. The
 * snapshot taken when the panel opened is the first paint either way.
 */
export const useLiveWatchCard = (target: TWatchTarget): TWatchCard => {
  const stored = useSelector((state: IRootState) => {
    const list = state.server.messagesMap[target.channelId];
    return list?.find((m) => m.id === target.messageId) ?? null;
  });
  const [fallback, setFallback] = useState(target.card);
  const inStore = stored !== null;

  useEffect(() => {
    setFallback(target.card);
  }, [target]);

  useEffect(() => {
    if (inStore) return;
    const trpc = getTRPCClient();
    if (!trpc) return;
    return subscribe('onWatchCardUpdate', trpc.messages.onUpdate, (message) => {
      if (message.id !== target.messageId) return;
      const card = watchCardOf(message.metadata);
      if (card) setFallback(card);
    });
  }, [inStore, target.messageId]);

  return (stored ? watchCardOf(stored.metadata) : null) ?? fallback;
};

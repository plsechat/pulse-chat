import type { IRootState } from '@/features/store';
import { windowOrDefault } from '@/features/message-window';
import type { TJoinedDmMessage } from '@pulse/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { fetchDmMessages, fetchLatestDmMessages } from './actions';
import { dmMessagesSelector, dmMessageWindowSelector } from './selectors';

/**
 * DM twin of features/server/messages/hooks useMessages. Both window
 * edges come from the store (features/message-window): paging up past
 * the 300-message cap trims the newest end and detaches the window
 * from the live tail. The DM route has no forward (`after`) paging, so
 * the only way back is `reattach` — refetch the latest page — which
 * the conversation's "Jump to Present" pill drives.
 */
export const useDmMessages = (dmChannelId: number) => {
  const messages = useSelector((state: IRootState) =>
    dmMessagesSelector(state, dmChannelId)
  );
  const window = useSelector((state: IRootState) =>
    dmMessageWindowSelector(state, dmChannelId)
  );
  const { hasOlder, hasNewer } = windowOrDefault(window);
  const inited = useRef(false);
  const [fetching, setFetching] = useState(false);
  const [loading, setLoading] = useState(messages.length === 0);
  // Cursors derive from the loaded window (not from the last page
  // result) because the cap may have dropped what that result pointed
  // at; the ref keeps loadMore's identity stable across live messages.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const fetchLatest = useCallback(async () => {
    setFetching(true);
    try {
      await fetchLatestDmMessages(dmChannelId);
    } finally {
      setFetching(false);
      setLoading(false);
    }
  }, [dmChannelId]);

  const loadMore = useCallback(async () => {
    if (fetching || !hasOlder) return;

    const oldest = messagesRef.current[0];
    if (!oldest) return;

    setFetching(true);
    try {
      await fetchDmMessages(dmChannelId, oldest.createdAt);
    } finally {
      setFetching(false);
    }
  }, [fetching, hasOlder, dmChannelId]);

  const reattach = useCallback(async () => {
    if (fetching) return;
    await fetchLatest();
  }, [fetching, fetchLatest]);

  // Reset when dmChannelId changes so messages are fetched for the new channel
  useEffect(() => {
    inited.current = false;
    setLoading(true);
  }, [dmChannelId]);

  useEffect(() => {
    if (inited.current) return;
    void fetchLatest();
    inited.current = true;
  }, [fetchLatest]);

  const groupedMessages = useMemo(() => {
    const grouped = messages.reduce((acc, message) => {
      const last = acc[acc.length - 1];

      if (!last) return [[message]];

      const lastMessage = last[last.length - 1];

      // System messages are always standalone (never grouped)
      if (message.type === 'system' || lastMessage.type === 'system') {
        return [...acc, [message]];
      }

      if (lastMessage.userId === message.userId) {
        const timeDiff =
          Math.abs(message.createdAt - lastMessage.createdAt) / 1000 / 60;

        if (timeDiff < 1) {
          last.push(message);
          return acc;
        }
      }

      return [...acc, [message]];
    }, [] as TJoinedDmMessage[][]);

    return grouped;
  }, [messages]);

  return {
    messages,
    loading,
    fetching,
    hasMore: hasOlder,
    loadMore,
    reattach,
    detached: hasNewer,
    groupedMessages
  };
};

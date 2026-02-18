import type { IRootState } from '@/features/store';
import type { TJoinedDmMessage } from '@pulse/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { fetchDmMessages } from './actions';
import { dmMessagesSelector } from './selectors';

export const useDmMessages = (dmChannelId: number) => {
  const messages = useSelector((state: IRootState) =>
    dmMessagesSelector(state, dmChannelId)
  );
  const inited = useRef(false);
  const [fetching, setFetching] = useState(false);
  const [loading, setLoading] = useState(messages.length === 0);
  const [cursor, setCursor] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(true);

  const fetchPage = useCallback(
    async (cursorToFetch: number | null) => {
      setFetching(true);
      try {
        const nextCursor = await fetchDmMessages(
          dmChannelId,
          cursorToFetch
        );
        setCursor(nextCursor ?? null);
        setHasMore(nextCursor != null);
      } finally {
        setFetching(false);
        setLoading(false);
      }
    },
    [dmChannelId]
  );

  const loadMore = useCallback(async () => {
    if (fetching || !hasMore) return;
    await fetchPage(cursor);
  }, [fetching, hasMore, cursor, fetchPage]);

  // Reset when dmChannelId changes so messages are fetched for the new channel
  useEffect(() => {
    inited.current = false;
    setLoading(true);
    setCursor(null);
    setHasMore(true);
  }, [dmChannelId]);

  useEffect(() => {
    if (inited.current) return;
    fetchPage(null);
    inited.current = true;
  }, [fetchPage]);

  const groupedMessages = useMemo(() => {
    const grouped = messages.reduce((acc, message) => {
      const last = acc[acc.length - 1];

      if (!last) return [[message]];

      const lastMessage = last[last.length - 1];

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
    hasMore,
    loadMore,
    groupedMessages
  };
};

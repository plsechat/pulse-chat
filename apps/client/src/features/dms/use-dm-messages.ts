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
  const fetchingRef = useRef(false);
  const cursorRef = useRef<number | null>(null);
  const hasMoreRef = useRef(true);
  const [fetching, setFetching] = useState(false);
  const [loading, setLoading] = useState(messages.length === 0);
  const [hasMore, setHasMore] = useState(true);

  const fetchPage = useCallback(
    async (cursorToFetch: number | null) => {
      if (fetchingRef.current) return;
      fetchingRef.current = true;
      setFetching(true);
      try {
        const nextCursor = await fetchDmMessages(
          dmChannelId,
          cursorToFetch
        );
        cursorRef.current = nextCursor ?? null;
        hasMoreRef.current = nextCursor != null;
        setHasMore(nextCursor != null);
      } finally {
        fetchingRef.current = false;
        setFetching(false);
        setLoading(false);
      }
    },
    [dmChannelId]
  );

  const loadMore = useCallback(async () => {
    if (fetchingRef.current || !hasMoreRef.current) return;
    await fetchPage(cursorRef.current);
  }, [fetchPage]);

  // Reset when dmChannelId changes so messages are fetched for the new channel
  useEffect(() => {
    inited.current = false;
    fetchingRef.current = false;
    cursorRef.current = null;
    hasMoreRef.current = true;
    setLoading(true);
    setHasMore(true);
  }, [dmChannelId]);

  useEffect(() => {
    if (inited.current) return;
    fetchPage(null);
    inited.current = true;
  }, [fetchPage]);

  const groupedMessages = useMemo(() => {
    const grouped: TJoinedDmMessage[][] = [];

    for (const message of messages) {
      const last = grouped[grouped.length - 1];

      if (!last) {
        grouped.push([message]);
        continue;
      }

      const lastMessage = last[last.length - 1];

      // System messages are always standalone (never grouped)
      if (message.type === 'system' || lastMessage.type === 'system') {
        grouped.push([message]);
        continue;
      }

      if (lastMessage.userId === message.userId) {
        const timeDiff =
          Math.abs(message.createdAt - lastMessage.createdAt) / 1000 / 60;

        if (timeDiff < 1) {
          last.push(message);
          continue;
        }
      }

      grouped.push([message]);
    }

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

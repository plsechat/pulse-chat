import type { IRootState } from '@/features/store';
import { getTRPCClient } from '@/lib/trpc';
import { DEFAULT_MESSAGES_LIMIT, type TJoinedMessage } from '@pulse/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { addMessages, mergeMessageAuthors, purgeChannelMessages } from './actions';
import { decryptChannelMessages } from './decrypt';
import { finishJump, JUMP_EVENT, peekPendingJump } from './jump';
import { messagesByChannelIdSelector } from './selectors';

export const useMessagesByChannelId = (channelId: number) =>
  useSelector((state: IRootState) =>
    messagesByChannelIdSelector(state, channelId)
  );

export const useMessages = (channelId: number) => {
  const messages = useMessagesByChannelId(channelId);
  const inited = useRef(false);
  const [fetching, setFetching] = useState(false);
  const [loading, setLoading] = useState(messages.length === 0);
  const [cursor, setCursor] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(true);
  // Non-null while the loaded window is DETACHED from the live tail
  // (after a jump to an old message): the createdAt cursor for paging
  // forward. null = attached, new messages append contiguously.
  const [afterCursor, setAfterCursor] = useState<number | null>(null);
  // Bumped to re-attempt the initial load while the tRPC client is
  // unavailable (e.g. a federated instance's WS still connecting right
  // after a server switch). Without the retry, fetchMessages would no-op
  // once, `inited` would latch, and the pane would stay empty forever.
  const [clientRetryTick, setClientRetryTick] = useState(0);

  const fetchMessages = useCallback(
    async (cursorToFetch: number | null) => {
      const trpcClient = getTRPCClient();
      if (!trpcClient) return;

      setFetching(true);

      try {
        const { messages: rawPage, nextCursor, authors } =
          await trpcClient.messages.get.query({
            channelId,
            cursor: cursorToFetch,
            limit: DEFAULT_MESSAGES_LIMIT
          });

        // Preview-only author profiles (no member bootstrap to resolve from)
        mergeMessageAuthors(authors);

        const decryptedPage = await decryptChannelMessages(rawPage);
        const page = [...decryptedPage].reverse();
        const existingIds = new Set(messages.map((m) => m.id));
        const filtered = page.filter((m) => !existingIds.has(m.id));

        if (cursorToFetch === null) {
          // initial load (latest page) — append (or replace if you prefer)
          addMessages(channelId, filtered);
        } else {
          // loading older messages -> they must go *before* current list
          addMessages(channelId, filtered, { prepend: true });
        }

        setCursor(nextCursor);
        setHasMore(nextCursor !== null);

        return { success: true };
      } finally {
        setFetching(false);
        setLoading(false);
      }
    },
    [channelId, messages]
  );

  const loadMore = useCallback(async () => {
    if (fetching || !hasMore) return;

    await fetchMessages(cursor);
  }, [fetching, hasMore, cursor, fetchMessages]);

  /**
   * Jump to a message that may be far outside the loaded history: fetch
   * a window AROUND it and REPLACE the channel's loaded messages with
   * that window. Replacing (not merging) matters — the reducer renders
   * whatever it holds as contiguous, so merging a distant window into
   * existing history would display unrelated messages as adjacent.
   */
  const jumpTo = useCallback(
    async (messageId: number) => {
      if (messages.some((m) => m.id === messageId)) {
        finishJump(channelId, messageId);
        return;
      }

      const trpcClient = getTRPCClient();
      if (!trpcClient) return;

      setFetching(true);
      try {
        const res = await trpcClient.messages.get.query({
          channelId,
          aroundId: messageId,
          limit: DEFAULT_MESSAGES_LIMIT
        });
        mergeMessageAuthors(res.authors);
        const decrypted = await decryptChannelMessages(res.messages);
        purgeChannelMessages(channelId);
        addMessages(channelId, [...decrypted].reverse());
        setCursor(res.nextCursor);
        setHasMore(res.nextCursor !== null);
        setAfterCursor(res.afterCursor);
        finishJump(channelId, messageId);
      } finally {
        setFetching(false);
        setLoading(false);
      }
    },
    [channelId, messages]
  );

  /** Page forward (toward the present) while detached. */
  const loadNewer = useCallback(async () => {
    if (fetching || afterCursor === null) return;

    const trpcClient = getTRPCClient();
    if (!trpcClient) return;

    setFetching(true);
    try {
      const res = await trpcClient.messages.get.query({
        channelId,
        after: afterCursor,
        limit: DEFAULT_MESSAGES_LIMIT
      });
      mergeMessageAuthors(res.authors);
      const decrypted = await decryptChannelMessages(res.messages);
      addMessages(channelId, [...decrypted].reverse());
      setAfterCursor(res.afterCursor);
    } finally {
      setFetching(false);
    }
  }, [channelId, fetching, afterCursor]);

  /**
   * Drop the detached window and rejoin the live tail ("Jump to
   * Present"). Fetches the latest page BEFORE purging so the pane never
   * flashes empty.
   */
  const reattach = useCallback(async () => {
    if (fetching) return;

    const trpcClient = getTRPCClient();
    if (!trpcClient) return;

    setFetching(true);
    try {
      const res = await trpcClient.messages.get.query({
        channelId,
        cursor: null,
        limit: DEFAULT_MESSAGES_LIMIT
      });
      mergeMessageAuthors(res.authors);
      const decrypted = await decryptChannelMessages(res.messages);
      purgeChannelMessages(channelId);
      addMessages(channelId, [...decrypted].reverse());
      setCursor(res.nextCursor);
      setHasMore(res.nextCursor !== null);
      setAfterCursor(null);
    } finally {
      setFetching(false);
    }
  }, [channelId, fetching]);

  useEffect(() => {
    if (inited.current) return;

    if (!getTRPCClient()) {
      const timer = setTimeout(() => setClientRetryTick((t) => t + 1), 300);
      return () => clearTimeout(timer);
    }

    inited.current = true;

    // A jump was requested before this channel mounted (message link /
    // search result) — load around the target instead of the tail.
    const pending = peekPendingJump(channelId);
    if (pending) {
      void jumpTo(pending.messageId);
    } else {
      fetchMessages(null);
    }
  }, [fetchMessages, jumpTo, channelId, clientRetryTick]);

  // Jump requested while this channel is already mounted (link to an
  // older message in the same channel).
  useEffect(() => {
    const handler = () => {
      const pending = peekPendingJump(channelId);
      if (pending && inited.current) void jumpTo(pending.messageId);
    };
    window.addEventListener(JUMP_EVENT, handler);
    return () => window.removeEventListener(JUMP_EVENT, handler);
  }, [channelId, jumpTo]);

  const isEmpty = useMemo(
    () => !messages.length && !fetching,
    [messages.length, fetching]
  );

  const groupedMessages = useMemo(() => {
    const grouped = messages.reduce((acc, message) => {
      const last = acc[acc.length - 1];

      if (!last) return [[message]];

      const lastMessage = last[last.length - 1];

      // System messages are always standalone (never grouped)
      if (message.type === 'system' || lastMessage.type === 'system') {
        return [...acc, [message]];
      }

      // Don't group webhook messages with regular messages (or different webhooks)
      const sameWebhook = lastMessage.webhookId === message.webhookId;

      if (lastMessage.userId === message.userId && sameWebhook) {
        const lastDate = lastMessage.createdAt;
        const currentDate = message.createdAt;
        const timeDifference = Math.abs(currentDate - lastDate) / 1000 / 60;

        if (timeDifference < 7) {
          last.push(message);
          return acc;
        }
      }

      return [...acc, [message]];
    }, [] as TJoinedMessage[][]);

    return grouped;
  }, [messages]);

  return {
    fetching,
    loading, // for initial load
    hasMore,
    messages,
    loadMore,
    loadNewer,
    reattach,
    detached: afterCursor !== null,
    cursor,
    groupedMessages,
    isEmpty
  };
};

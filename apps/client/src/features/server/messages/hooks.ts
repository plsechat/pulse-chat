import type { IRootState } from '@/features/store';
import { getTRPCClient } from '@/lib/trpc';
import { DEFAULT_MESSAGES_LIMIT } from '@pulse/shared';
import type { TJoinedMessage } from '@pulse/server/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { windowOrDefault } from '@/features/message-window';
import {
  addMessages,
  mergeMessageAuthors,
  purgeChannelMessages,
  replaceMessages,
  setMessageWindow
} from './actions';
import { decryptChannelMessages } from './decrypt';
import { finishJump, peekPendingJump } from './jump';
import {
  messagesByChannelIdSelector,
  messageWindowByChannelIdSelector
} from './selectors';
import { onAppEvent } from '@/lib/events';

export const useMessagesByChannelId = (channelId: number) =>
  useSelector((state: IRootState) =>
    messagesByChannelIdSelector(state, channelId)
  );

/**
 * The loaded window of a channel and the paging around it.
 *
 * Both edges of the window are store state (features/message-window):
 * `hasOlder` because the 300-message cap can trim the oldest end on
 * any append, and `hasNewer` because trimming the newest end while
 * paging up detaches the window from the live tail — the same detached
 * state a jump to an old message produces. Cursors are derived from
 * the window itself (oldest / newest loaded createdAt) for the same
 * reason: a cursor remembered from the last page result would point
 * past whatever the cap has since dropped and leave a gap.
 */
export const useMessages = (channelId: number) => {
  const messages = useMessagesByChannelId(channelId);
  const window = useSelector((state: IRootState) =>
    messageWindowByChannelIdSelector(state, channelId)
  );
  const { hasOlder, hasNewer } = windowOrDefault(window);
  const inited = useRef(false);
  const [fetching, setFetching] = useState(false);
  const [loading, setLoading] = useState(messages.length === 0);
  // Bumped to re-attempt the initial load while the tRPC client is
  // unavailable (e.g. a federated instance's WS still connecting right
  // after a server switch). Without the retry, fetchMessages would no-op
  // once, `inited` would latch, and the pane would stay empty forever.
  const [clientRetryTick, setClientRetryTick] = useState(0);
  // The paging callbacks peek at the loaded window without depending on
  // it: a `messages` dependency gave them a new identity on every
  // incoming message, re-running every consumer effect keyed on them.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const hasNewerRef = useRef(hasNewer);
  hasNewerRef.current = hasNewer;

  /**
   * Fetch the LATEST page and attach the window to the live tail —
   * initial load and "Jump to Present" alike. The page is fetched
   * before anything is dropped so the pane never flashes empty; while
   * it is in flight the window is marked attached so a live message
   * landing meanwhile is kept and survives the replace.
   */
  const fetchLatest = useCallback(async () => {
    const trpcClient = getTRPCClient();
    if (!trpcClient) return;

    setFetching(true);
    if (hasNewerRef.current) setMessageWindow(channelId, { hasNewer: false });

    try {
      const { messages: rawPage, nextCursor, authors } =
        await trpcClient.messages.get.query({
          channelId,
          cursor: null,
          limit: DEFAULT_MESSAGES_LIMIT
        });

      // Preview-only author profiles (no member bootstrap to resolve from)
      mergeMessageAuthors(authors);

      const decryptedPage = await decryptChannelMessages(rawPage);
      replaceMessages(channelId, [...decryptedPage].reverse(), nextCursor !== null);
    } finally {
      setFetching(false);
      setLoading(false);
    }
  }, [channelId]);

  /** Page toward the past from the oldest message loaded. */
  const loadMore = useCallback(async () => {
    if (fetching || !hasOlder) return;

    const oldest = messagesRef.current[0];
    // Nothing loaded yet: the initial fetch is what fills the pane.
    if (!oldest) return;

    const trpcClient = getTRPCClient();
    if (!trpcClient) return;

    setFetching(true);
    try {
      const { messages: rawPage, nextCursor, authors } =
        await trpcClient.messages.get.query({
          channelId,
          cursor: oldest.createdAt,
          limit: DEFAULT_MESSAGES_LIMIT
        });
      mergeMessageAuthors(authors);
      const decryptedPage = await decryptChannelMessages(rawPage);
      // The reducer trims the newest end past the cap and flags
      // hasNewer itself; only what lies above the page is news here.
      addMessages(channelId, [...decryptedPage].reverse(), { prepend: true });
      setMessageWindow(channelId, { hasOlder: nextCursor !== null });
    } finally {
      setFetching(false);
    }
  }, [channelId, fetching, hasOlder]);

  /**
   * Jump to a message that may be far outside the loaded history: fetch
   * a window AROUND it and REPLACE the channel's loaded messages with
   * that window. Replacing (not merging) matters — the reducer renders
   * whatever it holds as contiguous, so merging a distant window into
   * existing history would display unrelated messages as adjacent.
   */
  const jumpTo = useCallback(
    async (messageId: number) => {
      if (messagesRef.current.some((m) => m.id === messageId)) {
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
        setMessageWindow(channelId, {
          hasOlder: res.nextCursor !== null,
          hasNewer: res.afterCursor !== null
        });
        finishJump(channelId, messageId);
      } finally {
        setFetching(false);
        setLoading(false);
      }
    },
    [channelId]
  );

  /** Page forward (toward the present) while detached. */
  const loadNewer = useCallback(async () => {
    if (fetching || !hasNewer) return;

    const newest = messagesRef.current[messagesRef.current.length - 1];
    if (!newest) return;

    const trpcClient = getTRPCClient();
    if (!trpcClient) return;

    setFetching(true);
    try {
      const res = await trpcClient.messages.get.query({
        channelId,
        after: newest.createdAt,
        limit: DEFAULT_MESSAGES_LIMIT
      });
      mergeMessageAuthors(res.authors);
      const decrypted = await decryptChannelMessages(res.messages);
      // Appending past the cap trims the oldest end and flags hasOlder
      // in the reducer; reaching the tail (afterCursor null) re-attaches.
      addMessages(channelId, [...decrypted].reverse());
      setMessageWindow(channelId, { hasNewer: res.afterCursor !== null });
    } finally {
      setFetching(false);
    }
  }, [channelId, fetching, hasNewer]);

  /** Drop the detached window and rejoin the live tail ("Jump to Present"). */
  const reattach = useCallback(async () => {
    if (fetching) return;
    await fetchLatest();
  }, [fetching, fetchLatest]);

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
      void fetchLatest();
    }
  }, [fetchLatest, jumpTo, channelId, clientRetryTick]);

  // Jump requested while this channel is already mounted (link to an
  // older message in the same channel).
  useEffect(() => {
    const handler = () => {
      const pending = peekPendingJump(channelId);
      if (pending && inited.current) void jumpTo(pending.messageId);
    };
    return onAppEvent('jump-to-message', handler);
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
    hasMore: hasOlder,
    messages,
    loadMore,
    loadNewer,
    reattach,
    detached: hasNewer,
    groupedMessages,
    isEmpty
  };
};

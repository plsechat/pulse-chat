import type { IRootState } from '@/features/store';
import {
  decryptChannelMessage,
  fetchAndProcessPendingSenderKeys
} from '@/lib/e2ee';
import { getTRPCClient } from '@/lib/trpc';
import { DEFAULT_MESSAGES_LIMIT, type TJoinedMessage } from '@pulse/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { addMessages } from './actions';
import { messagesByChannelIdSelector } from './selectors';

async function decryptE2eeMessages(
  messages: TJoinedMessage[]
): Promise<TJoinedMessage[]> {
  // Pre-fetch all pending sender keys for channels in this batch so that
  // the per-message decryptChannelMessage calls hit the in-memory cache
  // instead of each independently fetching from the server.
  const e2eeChannelIds = new Set(
    messages
      .filter((m) => m.e2ee && m.encryptedContent)
      .map((m) => m.channelId)
  );
  for (const channelId of e2eeChannelIds) {
    await fetchAndProcessPendingSenderKeys(channelId);
  }

  return Promise.all(
    messages.map(async (msg) => {
      if (!msg.e2ee || !msg.encryptedContent) return msg;

      try {
        const payload = await decryptChannelMessage(
          msg.channelId,
          msg.userId,
          msg.encryptedContent
        );
        return { ...msg, content: payload.content };
      } catch (err) {
        console.error('[E2EE] Failed to decrypt channel message:', err);
        return { ...msg, content: '[Unable to decrypt]' };
      }
    })
  );
}

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

  const fetchMessages = useCallback(
    async (cursorToFetch: number | null) => {
      const trpcClient = getTRPCClient();

      setFetching(true);

      try {
        const { messages: rawPage, nextCursor } =
          await trpcClient.messages.get.query({
            channelId,
            cursor: cursorToFetch,
            limit: DEFAULT_MESSAGES_LIMIT
          });

        const decryptedPage = await decryptE2eeMessages(rawPage);
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

  useEffect(() => {
    if (inited.current) return;

    fetchMessages(null);

    inited.current = true;
  }, [fetchMessages]);

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

        if (timeDifference < 1) {
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
    cursor,
    groupedMessages,
    isEmpty
  };
};

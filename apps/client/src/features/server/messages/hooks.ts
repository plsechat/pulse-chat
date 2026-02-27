import type { IRootState } from '@/features/store';
import {
  decryptChannelMessage,
  fetchAndProcessPendingSenderKeys
} from '@/lib/e2ee';
import { setFileKeys } from '@/lib/e2ee/file-key-store';
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
      .filter((m) => m.e2ee && m.content)
      .map((m) => m.channelId)
  );
  await Promise.all(
    [...e2eeChannelIds].map((channelId) =>
      fetchAndProcessPendingSenderKeys(channelId)
    )
  );

  return Promise.all(
    messages.map(async (msg) => {
      if (!msg.e2ee || !msg.content) return msg;

      try {
        const payload = await decryptChannelMessage(
          msg.channelId,
          msg.userId,
          msg.content
        );
        setFileKeys(msg.id, payload.fileKeys);
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
  const fetchingRef = useRef(false);
  const cursorRef = useRef<number | null>(null);
  const hasMoreRef = useRef(true);
  const [fetching, setFetching] = useState(false);
  const [loading, setLoading] = useState(messages.length === 0);
  const [hasMore, setHasMore] = useState(true);

  const fetchMessages = useCallback(
    async (cursorToFetch: number | null) => {
      if (fetchingRef.current) return;
      fetchingRef.current = true;
      setFetching(true);

      try {
        const trpcClient = getTRPCClient();

        const { messages: rawPage, nextCursor } =
          await trpcClient.messages.get.query({
            channelId,
            cursor: cursorToFetch,
            limit: DEFAULT_MESSAGES_LIMIT
          });

        const decryptedPage = await decryptE2eeMessages(rawPage);
        const page = [...decryptedPage].reverse();

        if (cursorToFetch === null) {
          addMessages(channelId, page);
        } else {
          addMessages(channelId, page, { prepend: true });
        }

        cursorRef.current = nextCursor;
        hasMoreRef.current = nextCursor !== null;
        setHasMore(nextCursor !== null);

        return { success: true };
      } finally {
        fetchingRef.current = false;
        setFetching(false);
        setLoading(false);
      }
    },
    [channelId]
  );

  const loadMore = useCallback(async () => {
    if (fetchingRef.current || !hasMoreRef.current) return;
    await fetchMessages(cursorRef.current);
  }, [fetchMessages]);

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
    const grouped: TJoinedMessage[][] = [];

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

      // Don't group webhook messages with regular messages (or different webhooks)
      const sameWebhook = lastMessage.webhookId === message.webhookId;

      if (lastMessage.userId === message.userId && sameWebhook) {
        const timeDifference =
          Math.abs(message.createdAt - lastMessage.createdAt) / 1000 / 60;

        if (timeDifference < 1) {
          last.push(message);
          continue;
        }
      }

      grouped.push([message]);
    }

    return grouped;
  }, [messages]);

  return {
    fetching,
    loading,
    hasMore,
    messages,
    loadMore,
    groupedMessages,
    isEmpty
  };
};

import { switchServer, switchToFederatedServer } from '@/features/app/actions';
import {
  useFederatedMentionCounts,
  useFederatedServers,
  useFederatedUnreadCounts,
  useJoinedServers,
  useServerMentionCounts,
  useServerUnreadCounts
} from '@/features/app/hooks';
import { useDmChannels } from '@/features/dms/hooks';
import { useIncomingFriendRequestCount } from '@/features/friends/hooks';
import { getHandshakeHash } from '@/features/server/actions';
import { useOwnUserId } from '@/features/server/users/hooks';
import type { TServerSummary } from '@pulse/server/types';
import { useMemo } from 'react';

/**
 * Everything waiting for the user, derived once from the counts the
 * app already tracks: communities with mentions or unread messages,
 * conversations with new messages, and friend requests. The Inbox
 * panel lists it in full; the Home overview shows the totals. One
 * derivation, so the two never disagree about what is "waiting".
 */

export type TInboxCommunityRow = {
  key: string;
  name: string;
  logo?: TServerSummary['logo'];
  instanceName?: string;
  count: number;
  mention: boolean;
  go: () => void;
};

export type TInboxConversationRow = {
  id: number;
  name: string;
  peerId?: number;
  count: number;
};

export type TInboxSummary = {
  /** Mentions first, then by count. */
  communities: TInboxCommunityRow[];
  conversations: TInboxConversationRow[];
  /** Incoming friend requests. */
  pending: number;
  /** Mentions of you across every community. */
  mentionTotal: number;
  empty: boolean;
};

export const useInboxSummary = (): TInboxSummary => {
  const joinedServers = useJoinedServers();
  const federatedServers = useFederatedServers();
  const unread = useServerUnreadCounts();
  const mentions = useServerMentionCounts();
  const federatedUnread = useFederatedUnreadCounts();
  const federatedMentions = useFederatedMentionCounts();
  const dmChannels = useDmChannels();
  const pending = useIncomingFriendRequestCount();
  const ownUserId = useOwnUserId();

  const communities = useMemo(() => {
    const rows: TInboxCommunityRow[] = [];
    joinedServers.forEach((s) => {
      const m = mentions[s.id] ?? 0;
      const u = unread[s.id] ?? 0;
      if (m === 0 && u === 0) return;
      rows.push({
        key: `server:${s.id}`,
        name: s.name,
        logo: s.logo,
        count: m > 0 ? m : u,
        mention: m > 0,
        go: () => {
          const hash = getHandshakeHash();
          if (hash) switchServer(s.id, hash);
        }
      });
    });
    federatedServers.forEach((e) => {
      const countKey = `${e.instanceDomain}:${e.server.id}`;
      const m = federatedMentions[countKey] ?? 0;
      const u = federatedUnread[countKey] ?? 0;
      if (m === 0 && u === 0) return;
      rows.push({
        key: `fed:${countKey}`,
        name: e.server.name,
        logo: e.server.logo,
        instanceName: e.instanceName,
        count: m > 0 ? m : u,
        mention: m > 0,
        go: () => switchToFederatedServer(e.instanceDomain, e.server.id)
      });
    });
    return rows.sort(
      (a, b) => Number(b.mention) - Number(a.mention) || b.count - a.count
    );
  }, [
    joinedServers,
    federatedServers,
    unread,
    mentions,
    federatedUnread,
    federatedMentions
  ]);

  const conversations = useMemo(
    () =>
      dmChannels
        .filter((c) => (c.unreadCount ?? 0) > 0)
        .map((c): TInboxConversationRow => {
          const others = c.members.filter((m) => m.id !== ownUserId);
          return {
            id: c.id,
            name: c.isGroup
              ? c.name || others.map((m) => m.name).join(', ')
              : (others[0]?.name ?? 'Conversation'),
            peerId: !c.isGroup ? others[0]?.id : undefined,
            count: c.unreadCount ?? 0
          };
        }),
    [dmChannels, ownUserId]
  );

  const mentionTotal = useMemo(
    () =>
      Object.values(mentions).reduce((a, b) => a + (b ?? 0), 0) +
      Object.values(federatedMentions).reduce((a, b) => a + (b ?? 0), 0),
    [mentions, federatedMentions]
  );

  return useMemo(
    () => ({
      communities,
      conversations,
      pending,
      mentionTotal,
      empty:
        communities.length === 0 && conversations.length === 0 && pending === 0
    }),
    [communities, conversations, pending, mentionTotal]
  );
};

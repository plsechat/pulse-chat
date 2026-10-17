import { UserAvatar } from '@/components/user-avatar';
import { switchServer, switchToFederatedServer } from '@/features/app/actions';
import { openConversationPanel, setPanel } from '@/features/app/deck';
import {
  useFederatedMentionCounts,
  useFederatedServers,
  useFederatedUnreadCounts,
  useJoinedServers,
  useServerMentionCounts,
  useServerUnreadCounts
} from '@/features/app/hooks';
import { setSelectedDmChannelId } from '@/features/dms/actions';
import { useDmChannels } from '@/features/dms/hooks';
import { useIncomingFriendRequestCount } from '@/features/friends/hooks';
import { getHandshakeHash } from '@/features/server/actions';
import { useOwnUserId } from '@/features/server/users/hooks';
import { getFileUrl } from '@/helpers/get-file-url';
import type { TServerSummary } from '@pulse/server/types';
import { AtSign, Globe, Inbox, UserPlus } from 'lucide-react';
import { memo, useMemo } from 'react';

/**
 * Everything waiting for you, in one list: communities with mentions or
 * unread messages, conversations with new messages, and friend requests.
 * Built from the counts the app already tracks; each row jumps there.
 */

const Row = memo(
  ({
    onClick,
    icon,
    title,
    subtitle,
    count,
    mention
  }: {
    onClick: () => void;
    icon: React.ReactNode;
    title: string;
    subtitle?: string;
    count: number;
    mention?: boolean;
  }) => (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent/60"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-secondary text-sm font-semibold text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {title}
        </span>
        {subtitle && (
          <span className="block truncate text-xs text-muted-foreground">
            {subtitle}
          </span>
        )}
      </span>
      <span
        className={
          mention
            ? 'flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground'
            : 'flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-semibold text-foreground'
        }
      >
        {count > 99 ? '99+' : count}
      </span>
    </button>
  )
);

const Section = ({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <section className="px-2 pt-3">
    <h3 className="px-3 pb-1 text-xs font-medium text-muted-foreground">
      {title}
    </h3>
    <div className="space-y-0.5">{children}</div>
  </section>
);

const InboxPanel = memo(() => {
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
    const rows: {
      key: string;
      name: string;
      logo?: TServerSummary['logo'];
      instanceName?: string;
      count: number;
      mention: boolean;
      go: () => void;
    }[] = [];
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
    // Mentions first, then by count.
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
        .map((c) => {
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

  const empty =
    communities.length === 0 && conversations.length === 0 && pending === 0;

  if (empty) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <Inbox className="h-8 w-8 text-muted-foreground/60" />
        <p className="text-sm font-medium text-foreground">
          You&rsquo;re all caught up
        </p>
        <p className="text-xs text-muted-foreground">
          New mentions, unread channels and messages show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="pb-3">
      {pending > 0 && (
        <Section title="Friend requests">
          <Row
            onClick={() => setPanel('friends')}
            icon={<UserPlus className="h-4 w-4" />}
            title={
              pending === 1
                ? '1 person wants to be friends'
                : `${pending} people want to be friends`
            }
            subtitle="Open Friends to respond"
            count={pending}
            mention
          />
        </Section>
      )}
      {communities.length > 0 && (
        <Section title="Communities">
          {communities.map((row) => (
            <Row
              key={row.key}
              onClick={row.go}
              icon={
                row.logo ? (
                  <img
                    src={getFileUrl(row.logo)}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : row.instanceName ? (
                  <Globe className="h-4 w-4" />
                ) : (
                  row.name.charAt(0).toUpperCase()
                )
              }
              title={row.name}
              subtitle={
                row.mention
                  ? `${row.count} mention${row.count === 1 ? '' : 's'}`
                  : `${row.count} unread`
              }
              count={row.count}
              mention={row.mention}
            />
          ))}
        </Section>
      )}
      {conversations.length > 0 && (
        <Section title="Messages">
          {conversations.map((c) => (
            <Row
              key={c.id}
              onClick={() => {
                setSelectedDmChannelId(c.id);
                openConversationPanel();
              }}
              icon={
                c.peerId !== undefined ? (
                  <UserAvatar
                    userId={c.peerId}
                    className="h-8 w-8 rounded-lg"
                    homeScope
                    showUserPopover={false}
                  />
                ) : (
                  <AtSign className="h-4 w-4" />
                )
              }
              title={c.name}
              subtitle={`${c.count} new message${c.count === 1 ? '' : 's'}`}
              count={c.count}
            />
          ))}
        </Section>
      )}
    </div>
  );
});

export { InboxPanel };

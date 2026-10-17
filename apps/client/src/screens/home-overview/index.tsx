import { Dialog } from '@/components/dialogs/dialogs';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/empty-state';
import { UserAvatar } from '@/components/user-avatar';
import { groupAvatarFallbackClass } from '@/components/user-avatar/fallback';
import { activateTab } from '@/features/app/activate-tab';
import {
  openConversationPanel,
  openFriendsPanel,
  setMessagesView,
  setPanel
} from '@/features/app/deck';
import {
  useFederatedMentionCounts,
  useFederatedServers,
  useFederatedUnreadCounts,
  useJoinedServers,
  useServerMentionCounts,
  useServerUnreadCounts
} from '@/features/app/hooks';
import { useInboxSummary } from '@/features/app/inbox-summary';
import { openDialog } from '@/features/dialogs/actions';
import {
  getOrCreateDmChannel,
  setSelectedDmChannelId
} from '@/features/dms/actions';
import { useDmChannels } from '@/features/dms/hooks';
import { navigateToEvent } from '@/features/events/actions';
import { useUpcomingEvents } from '@/features/events/upcoming';
import { useFriends } from '@/features/friends/hooks';
import {
  useHomeOwnUserId,
  useOwnUserId,
  useUsers
} from '@/features/server/users/hooks';
import type { IRootState } from '@/features/store';
import { getRosterSubline } from '@/helpers/game-presence';
import { getDisplayName } from '@/helpers/get-display-name';
import { getFileUrl } from '@/helpers/get-file-url';
import { getInitialsFromName } from '@/helpers/get-initials-from-name';
import { timeOnly } from '@/helpers/time-format';
import { useNow } from '@/hooks/use-now';
import { cn } from '@/lib/utils';
import type { TJoinedPublicUser, TUpcomingEvent } from '@pulse/server/types';
import { format } from 'date-fns';
import { ChevronRight, Globe, Lock } from 'lucide-react';
import { memo, useCallback, useMemo, type ReactNode } from 'react';
import { useSelector } from 'react-redux';
import {
  deriveFriendsForHome,
  deriveRecentConversations,
  formatRelativeAge,
  formatStartsIn,
  groupUpcomingByDay,
  nowPlayingGroups,
  signupLabel,
  startsSoon,
  type TRecentConversation
} from './derive';

/**
 * The Home tab of the tab layout: an overview of everything that
 * matters to the user — recent conversations, friends, communities,
 * the inbox, the week's events and who is playing what — built from
 * state the client already holds (one query for events). Nothing opens
 * here: a row opens the tray panel or the community tab it belongs to,
 * and the overview stays on screen beneath it.
 */

const CONVERSATIONS_MAX = 8;
const FRIENDS_MAX = 8;
const UPCOMING_MAX = 5;
const PLAYING_NAMES_MAX = 3;

const ROW =
  'flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/60';
const FOOTER_ACTION =
  'rounded-md px-2 py-1 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60';

/** The pill count on a row: digits for the eye, the full phrase for a screen reader. */
const Count = memo(
  ({ count, label, mention }: { count: number; label: string; mention?: boolean }) => {
    if (count <= 0) return null;
    return (
      <span
        className={cn(
          'flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums',
          mention
            ? 'bg-primary text-primary-foreground'
            : 'bg-accent text-foreground'
        )}
      >
        <span aria-hidden>{count > 99 ? '99+' : count}</span>
        <span className="sr-only">{label}</span>
      </span>
    );
  }
);

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

type TCardProps = {
  id: string;
  title: string;
  /** Opens the full surface; the title becomes the button. */
  onOpen?: () => void;
  /** Muted text beside the title (a count, a community). */
  aside?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
};

/**
 * One section of the overview. A section with somewhere fuller to go
 * (a tray panel) has its title as the button there — one control, named
 * exactly after the section, so "Friends" opens Friends.
 */
const Card = memo(({ id, title, onOpen, aside, children, footer }: TCardProps) => (
  <section
    aria-labelledby={id}
    className="flex min-w-0 flex-col rounded-xl bg-card/60 ring-1 ring-border/60"
  >
    <header className="flex h-11 items-center gap-2 pl-4 pr-3">
      {onOpen ? (
        <h2 id={id} className="-ml-1.5">
          <button
            type="button"
            onClick={onOpen}
            className="flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[13px] font-semibold text-foreground outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {title}
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          </button>
        </h2>
      ) : (
        <h2 id={id} className="text-[13px] font-semibold text-foreground">
          {title}
        </h2>
      )}
      {aside && (
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {aside}
        </span>
      )}
    </header>
    <div className="px-2 pb-2">{children}</div>
    {footer && (
      <footer className="flex flex-wrap items-center gap-1 border-t border-border/60 px-2 py-1.5">
        {footer}
      </footer>
    )}
  </section>
));

const openConversation = (dmChannelId: number) => {
  setSelectedDmChannelId(dmChannelId);
  openConversationPanel();
};

const openMessagesList = () => {
  setMessagesView('list');
  setPanel('messages');
};

// ─── Conversations ────────────────────────────────────────────────────

const ConversationAvatar = memo(({ row }: { row: TRecentConversation }) => {
  if (row.peerId !== undefined) {
    return (
      <UserAvatar
        userId={row.peerId}
        className="h-9 w-9"
        homeScope
        showStatusBadge
        showUserPopover={false}
      />
    );
  }
  return (
    <Avatar className="h-9 w-9">
      {row.icon && <AvatarImage src={getFileUrl(row.icon)} alt="" />}
      <AvatarFallback className={cn('text-xs', groupAvatarFallbackClass(row.id))}>
        {getInitialsFromName(row.name)}
      </AvatarFallback>
    </Avatar>
  );
});

const ConversationRow = memo(
  ({ row, now }: { row: TRecentConversation; now: number }) => {
    const { snippet } = row;
    return (
      <li>
        <button
          type="button"
          onClick={() => openConversation(row.id)}
          className={ROW}
        >
          <ConversationAvatar row={row} />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-[13px] text-foreground',
                  row.unread > 0 ? 'font-semibold' : 'font-medium'
                )}
              >
                {row.name}
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {formatRelativeAge(row.at, now)}
              </span>
            </span>
            <span
              className={cn(
                'flex items-center gap-1 text-xs',
                snippet.kind === 'deleted' || snippet.kind === 'encrypted'
                  ? 'italic text-muted-foreground/80'
                  : 'text-muted-foreground'
              )}
            >
              {snippet.e2ee && (
                <Lock className="h-3 w-3 shrink-0" aria-label="Encrypted" />
              )}
              <span className="truncate">
                {snippet.fromMe && snippet.kind === 'text' ? 'You: ' : ''}
                {snippet.text}
              </span>
            </span>
          </span>
          <Count count={row.unread} label={`${row.unread} unread`} />
        </button>
      </li>
    );
  }
);

const ConversationsCard = memo(() => {
  const channels = useDmChannels();
  const ownUserId = useHomeOwnUserId();
  const now = useNow();
  const rows = useMemo(
    () => deriveRecentConversations(channels, ownUserId, CONVERSATIONS_MAX),
    [channels, ownUserId]
  );
  return (
    <Card
      id="home-conversations"
      title="Conversations"
      onOpen={openMessagesList}
      aside={channels.length > rows.length ? `${channels.length} in all` : undefined}
    >
      {rows.length === 0 ? (
        <EmptyState
          size="sm"
          title="No conversations yet"
          description="Message a friend and it shows up here."
          action={
            <button
              type="button"
              onClick={() => openFriendsPanel('all')}
              className={FOOTER_ACTION}
            >
              Open Friends
            </button>
          }
        />
      ) : (
        <ul className="space-y-0.5">
          {rows.map((row) => (
            <ConversationRow key={row.id} row={row} now={now} />
          ))}
        </ul>
      )}
    </Card>
  );
});

// ─── Friends ──────────────────────────────────────────────────────────

const FriendRow = memo(({ friend }: { friend: TJoinedPublicUser }) => {
  const subline = getRosterSubline(friend);
  const handleClick = useCallback(async () => {
    const channel = await getOrCreateDmChannel(friend.id);
    if (channel) openConversation(channel.id);
  }, [friend.id]);
  return (
    <li>
      <button type="button" onClick={handleClick} className={ROW}>
        <UserAvatar
          userId={friend.id}
          className="h-8 w-8"
          homeScope
          showStatusBadge
          showUserPopover={false}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-foreground">
            {getDisplayName(friend)}
          </span>
          {subline && (
            <span
              className={cn(
                'block truncate text-xs',
                friend.gamePresence ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              {subline}
            </span>
          )}
        </span>
      </button>
    </li>
  );
});

const FriendsCard = memo(() => {
  const friends = useFriends();
  const { pending } = useInboxSummary();
  const { shown, onlineCount, total } = useMemo(
    () => deriveFriendsForHome(friends, FRIENDS_MAX),
    [friends]
  );
  return (
    <Card
      id="home-friends"
      title="Friends"
      onOpen={() => openFriendsPanel('all')}
      aside={total > 0 ? `${onlineCount} of ${total} online` : undefined}
      footer={
        <>
          {pending > 0 && (
            <button
              type="button"
              onClick={() => openFriendsPanel('pending')}
              className={cn(FOOTER_ACTION, 'text-foreground')}
            >
              {pending === 1 ? '1 friend request' : `${pending} friend requests`}
            </button>
          )}
          <button
            type="button"
            onClick={() => openFriendsPanel('add')}
            className={FOOTER_ACTION}
          >
            Add friend
          </button>
        </>
      }
    >
      {shown.length === 0 ? (
        <EmptyState
          size="sm"
          title="No friends yet"
          description="Add someone by their username and see when they are around."
        />
      ) : (
        <ul className="space-y-0.5">
          {shown.map((friend) => (
            <FriendRow key={friend.id} friend={friend} />
          ))}
        </ul>
      )}
    </Card>
  );
});

// ─── Communities ──────────────────────────────────────────────────────

type TCommunityRow = {
  key: string;
  name: string;
  logoUrl: string | null;
  instanceName?: string;
  unread: number;
  mentions: number;
};

const CommunitiesCard = memo(() => {
  const joined = useJoinedServers();
  const federated = useFederatedServers();
  const unread = useServerUnreadCounts();
  const mentions = useServerMentionCounts();
  const federatedUnread = useFederatedUnreadCounts();
  const federatedMentions = useFederatedMentionCounts();

  const rows = useMemo((): TCommunityRow[] => {
    const home = joined.map((s) => ({
      key: `server:${s.id}`,
      name: s.name,
      logoUrl: s.logo ? getFileUrl(s.logo) : null,
      unread: unread[s.id] ?? 0,
      mentions: mentions[s.id] ?? 0
    }));
    const remote = federated.map((e) => {
      const countKey = `${e.instanceDomain}:${e.server.id}`;
      return {
        key: `fed:${countKey}`,
        name: e.server.name,
        logoUrl: e.server.logo ? getFileUrl(e.server.logo) : null,
        instanceName: e.instanceName,
        unread: federatedUnread[countKey] ?? 0,
        mentions: federatedMentions[countKey] ?? 0
      };
    });
    return [...home, ...remote];
  }, [joined, federated, unread, mentions, federatedUnread, federatedMentions]);

  return (
    <Card
      id="home-communities"
      title="Your communities"
      aside={rows.length > 0 ? `${rows.length}` : undefined}
      footer={
        <>
          <button
            type="button"
            onClick={() => activateTab('discover')}
            className={FOOTER_ACTION}
          >
            Discover communities
          </button>
          <button
            type="button"
            onClick={() => openDialog(Dialog.CREATE_SERVER)}
            className={FOOTER_ACTION}
          >
            Create or join
          </button>
        </>
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          size="sm"
          title="You have not joined a community yet"
          description="Discover one, or create your own and invite people."
        />
      ) : (
        <ul className="space-y-0.5">
          {rows.map((row) => (
            <li key={row.key}>
              <button
                type="button"
                onClick={() => activateTab(row.key)}
                className={ROW}
              >
                <span className="squircle relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden bg-secondary text-sm font-semibold text-muted-foreground">
                  {row.logoUrl ? (
                    <img src={row.logoUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    row.name.charAt(0).toUpperCase()
                  )}
                  {row.instanceName && (
                    <Globe
                      aria-hidden
                      className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-card text-muted-foreground"
                    />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      'block truncate text-[13px] text-foreground',
                      row.unread > 0 || row.mentions > 0 ? 'font-semibold' : 'font-medium'
                    )}
                  >
                    {row.name}
                  </span>
                  {row.instanceName && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {row.instanceName}
                    </span>
                  )}
                </span>
                <Count
                  count={row.mentions}
                  label={plural(row.mentions, 'mention', 'mentions')}
                  mention
                />
                <Count count={row.unread} label={`${row.unread} unread`} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
});

// ─── Inbox ────────────────────────────────────────────────────────────

const InboxCard = memo(() => {
  const { communities, conversations, pending, mentionTotal, empty } =
    useInboxSummary();
  const open = () => setPanel('inbox');
  const unreadCommunities = communities.filter((c) => !c.mention).length;
  const mentionCommunities = communities.length - unreadCommunities;
  const newMessages = conversations.reduce((sum, c) => sum + c.count, 0);

  return (
    <Card id="home-inbox" title="Inbox" onOpen={open}>
      {empty ? (
        <EmptyState
          size="sm"
          title="You're all caught up"
          description="Mentions, unread channels and new messages show up here."
        />
      ) : (
        <ul className="space-y-0.5">
          {mentionTotal > 0 && (
            <li>
              <button type="button" onClick={open} className={ROW}>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                  {mentionTotal === 1 ? '1 mention' : `${mentionTotal} mentions`}
                  <span className="font-normal text-muted-foreground">
                    {mentionCommunities === 1
                      ? ' in 1 community'
                      : ` in ${mentionCommunities} communities`}
                  </span>
                </span>
                <Count
                  count={mentionTotal}
                  label={plural(mentionTotal, 'mention', 'mentions')}
                  mention
                />
              </button>
            </li>
          )}
          {unreadCommunities > 0 && (
            <li>
              <button type="button" onClick={open} className={ROW}>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                  {unreadCommunities === 1
                    ? '1 community with unread channels'
                    : `${unreadCommunities} communities with unread channels`}
                </span>
              </button>
            </li>
          )}
          {newMessages > 0 && (
            <li>
              <button type="button" onClick={open} className={ROW}>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                  {newMessages === 1 ? '1 new message' : `${newMessages} new messages`}
                  <span className="font-normal text-muted-foreground">
                    {conversations.length === 1
                      ? ' in 1 conversation'
                      : ` in ${conversations.length} conversations`}
                  </span>
                </span>
                <Count
                  count={newMessages}
                  label={plural(newMessages, 'new message', 'new messages')}
                />
              </button>
            </li>
          )}
          {pending > 0 && (
            <li>
              <button
                type="button"
                onClick={() => openFriendsPanel('pending')}
                className={ROW}
              >
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                  {pending === 1
                    ? '1 person wants to be friends'
                    : `${pending} people want to be friends`}
                </span>
                <Count
                  count={pending}
                  label={plural(pending, 'friend request', 'friend requests')}
                  mention
                />
              </button>
            </li>
          )}
        </ul>
      )}
    </Card>
  );
});

// ─── Upcoming events ──────────────────────────────────────────────────

const UpcomingRow = memo(({ item, now }: { item: TUpcomingEvent; now: number }) => {
  const soon = startsSoon(item.event.startsAt, now);
  return (
    <li>
      <button
        type="button"
        onClick={() => void navigateToEvent(item.serverId, item.event.id)}
        className={ROW}
      >
        <span
          className={cn(
            'w-14 shrink-0 text-[15px] font-semibold tabular-nums',
            soon ? 'text-live' : 'text-foreground'
          )}
        >
          {format(item.event.startsAt, timeOnly())}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-foreground">
            {item.event.title}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {item.serverName}, {lowerFirst(signupLabel(item))}
          </span>
        </span>
        <span
          className={cn(
            'shrink-0 text-xs tabular-nums',
            soon ? 'font-medium text-live' : 'text-muted-foreground'
          )}
        >
          {formatStartsIn(item.event.startsAt, now)}
        </span>
        <span className="sr-only">, open</span>
      </button>
    </li>
  );
});

const UpcomingCard = memo(() => {
  const homeUserId = useHomeOwnUserId();
  const { items, loaded } = useUpcomingEvents(homeUserId);
  const now = useNow();
  const days = useMemo(
    () => groupUpcomingByDay(items.slice(0, UPCOMING_MAX), now),
    [items, now]
  );
  return (
    <Card id="home-upcoming" title="Upcoming events" aside="next 7 days">
      {!loaded ? (
        <div className="h-16" aria-busy />
      ) : days.length === 0 ? (
        <EmptyState
          size="sm"
          title="Nothing scheduled this week"
          description="Events your communities plan in the Raid Planner show up here."
        />
      ) : (
        <div className="space-y-2">
          {days.map((day) => (
            <div key={day.dayStart}>
              <div className="px-2 pb-0.5 pt-1 text-xs font-medium text-muted-foreground">
                {day.label}
              </div>
              <ul className="space-y-0.5">
                {day.items.map((item) => (
                  <UpcomingRow key={item.event.id} item={item} now={now} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
});

// ─── Now playing ──────────────────────────────────────────────────────

const NowPlayingCard = memo(() => {
  const roster = useUsers();
  const friends = useFriends();
  const ownUserId = useOwnUserId();
  // The roster on screen belongs to the last home community opened; its
  // name says whose members these are.
  const rosterServerKey = useSelector(
    (state: IRootState) => state.server.serverId
  );
  const joined = useJoinedServers();
  const community = joined.find((s) => s.publicId === rosterServerKey)?.name;
  const groups = useMemo(
    () => nowPlayingGroups(roster, friends, ownUserId),
    [roster, friends, ownUserId]
  );
  if (groups.length === 0) return null;
  return (
    <Card id="home-playing" title="Now playing" aside={community}>
      <ul className="space-y-1">
        {groups.map((group) => {
          const names = group.users.slice(0, PLAYING_NAMES_MAX).map(getDisplayName);
          const more = group.users.length - names.length;
          return (
            <li key={group.game} className="flex items-center gap-3 px-2 py-1.5">
              <span className="flex shrink-0 -space-x-2">
                {group.users.slice(0, 4).map((u) => (
                  <UserAvatar
                    key={u.id}
                    userId={u.id}
                    className="h-7 w-7 ring-2 ring-card"
                    noDecoration
                    showUserPopover={false}
                  />
                ))}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-foreground">
                  {group.game}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {names.join(', ')}
                  {more > 0 ? ` and ${more} more` : ''}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
});

// ─── The overview ─────────────────────────────────────────────────────

const HomeOverview = memo(() => (
  <div className="min-h-0 flex-1 overflow-y-auto">
    <div className="grid grid-cols-1 gap-3 p-3 lg:grid-cols-2 lg:p-4">
      <ConversationsCard />
      <FriendsCard />
      <CommunitiesCard />
      <UpcomingCard />
      <InboxCard />
      <NowPlayingCard />
    </div>
  </div>
));

export { HomeOverview };

import { UserContextMenu } from '@/components/context-menus/user';
import { VerifiedMemberDot } from '@/components/e2ee-status-badge';
import { NameplateBackground } from '@/components/nameplate';
import { UserAvatar } from '@/components/user-avatar';
import { useSelectedChannel } from '@/features/server/channels/hooks';
import { useUserDisplayRole } from '@/features/server/hooks';
import { usersGroupedByRoleSelector } from '@/features/server/users/selectors';
import type { IRootState } from '@/features/store';
import { getDisplayName } from '@/helpers/get-display-name';
import { getRosterSubline, groupMembersByGame } from '@/helpers/game-presence';
import { getNameStyleCss } from '@/helpers/name-style';
import { useReadableRoleColor } from '@/hooks/use-readable-role-color';
import { getTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import type { TGamePresence, TJoinedPublicUser } from '@pulse/server/types';
import type { TNameStyle } from '@pulse/shared';
import { UserStatus } from '@pulse/shared';
import { ChevronDown, Gamepad2, Globe, Loader2, TimerOff } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { Tooltip } from '../ui/tooltip';
import { UserPopover } from '../user-popover';
import { UserStatusBadge } from '../user-status';

/**
 * The member list is fed by others.getServerMembers, which adds the
 * per-membership automod deadline on top of the public projection; the
 * slice stores the public type, so the field is read through this view.
 */
type TMemberRow = TJoinedPublicUser & { timedOutUntil?: number | null };

const getTimedOutUntil = (user: TJoinedPublicUser): number | null =>
  (user as TMemberRow).timedOutUntil ?? null;

/** Re-renders every `intervalMs` while `enabled`, so a deadline expires on screen. */
const useNow = (enabled: boolean, intervalMs: number) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs]);
  return now;
};

const TimedOutBadge = memo(({ until }: { until: number }) => (
  <Tooltip content={`Timed out until ${new Date(until).toLocaleTimeString()}`}>
    <span
      className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-amber-500/15 px-1.5 py-px text-[10px] font-medium text-amber-500"
      aria-label="Timed out"
    >
      <TimerOff className="h-3 w-3" />
    </span>
  </Tooltip>
));

type TUserProps = {
  userId: number;
  name: string;
  banned: boolean;
  /** Automod timeout deadline (ms epoch); shown while in the future. */
  timedOutUntil?: number | null;
  status?: UserStatus;
  customStatus?: string | null;
  /** What they are playing, as this server may show it. */
  gamePresence?: TGamePresence | null;
  nameplate?: string | null;
  nameStyle?: TNameStyle | null;
  _identity?: string;
  /** A plugin's account: labelled so it is not mistaken for a person. */
  system?: boolean;
  e2ee?: boolean;
  dimmed?: boolean;
};

const User = memo(
  ({
    userId,
    name,
    banned,
    timedOutUntil,
    status,
    customStatus,
    gamePresence,
    nameplate,
    nameStyle,
    _identity,
    system,
    e2ee,
    dimmed
  }: TUserProps) => {
    const displayRole = useUserDisplayRole(userId);
    // The game wins over the custom status while it is set; the custom
    // status comes back by itself once the game clears.
    const subline = getRosterSubline({ gamePresence, customStatus });
    const now = useNow(!!timedOutUntil, 30_000);
    const timedOut = !!timedOutUntil && timedOutUntil > now;
    const nameColor = useReadableRoleColor(displayRole?.color);
    // Styled name wins over role color; banned rows stay struck-through
    // and unstyled.
    const nameCss = !banned ? getNameStyleCss(nameStyle) : null;

    return (
      <UserContextMenu userId={userId}>
        <UserPopover userId={userId}>
          <div
            className={cn(
              // relative + overflow-hidden clip the nameplate layer to the
              // rounded row; content stays `relative` so it paints above it.
              'group relative overflow-hidden flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent select-none transition-[background-color,color,opacity] duration-150 cursor-pointer',
              dimmed && 'opacity-50 hover:opacity-100'
            )}
          >
            <NameplateBackground nameplate={nameplate} />
            <div className="relative flex-shrink-0">
              <UserAvatar
                userId={userId}
                className="squircle h-8 w-8"
                showStatusBadge={false}
              />
              <div className="absolute -bottom-0.5 -right-0.5">
                <UserStatusBadge
                  status={status || UserStatus.OFFLINE}
                  className="h-3 w-3"
                />
              </div>
            </div>
            <div className="relative flex flex-col min-w-0">
              <div className="flex items-center gap-1.5 min-w-0">
                <span
                  className={cn(
                    'text-sm truncate',
                    banned && 'line-through text-muted-foreground',
                    !banned &&
                      !nameColor &&
                      !nameCss &&
                      'text-foreground/80 group-hover:text-foreground',
                    nameCss?.className
                  )}
                  style={
                    nameCss?.style ??
                    (!banned && nameColor ? { color: nameColor } : undefined)
                  }
                >
                  {name}
                </span>
                {_identity?.includes('@') && (
                  <Globe className="h-3 w-3 text-blue-500 shrink-0" />
                )}
                {system && (
                  <span className="shrink-0 rounded-sm bg-muted px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Plugin
                  </span>
                )}
                {timedOut && <TimedOutBadge until={timedOutUntil} />}
                {e2ee && <VerifiedMemberDot userId={userId} />}
              </div>
              {subline && (
                <span
                  className={cn(
                    'text-xs text-muted-foreground truncate',
                    gamePresence && 'inline-flex items-center gap-1'
                  )}
                >
                  {gamePresence && (
                    <Gamepad2 className="h-3 w-3 shrink-0" aria-hidden />
                  )}
                  {subline}
                </span>
              )}
            </div>
          </div>
        </UserPopover>
      </UserContextMenu>
    );
  }
);

const RoleGroupSection = memo(
  ({
    label,
    color,
    users,
    dimmed,
    e2ee
  }: {
    label: string;
    color?: string;
    users: TJoinedPublicUser[];
    dimmed?: boolean;
    e2ee?: boolean;
  }) => (
    <div>
      {/* Old shape was bold uppercase tracking-widest with an em-dash
          before the count — read as a corporate section header. The
          casual rebuild: sentence-case label, count as a soft chip.
          More "lived-in," still scannable. */}
      <div className="flex items-center gap-2 px-2 pt-4 pb-1.5">
        {color && color !== '#ffffff' && (
          <span
            aria-hidden
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: color }}
          />
        )}
        <h4
          className={cn(
            'text-xs font-semibold',
            !(color && color !== '#ffffff') && 'text-muted-foreground/80'
          )}
          style={color && color !== '#ffffff' ? { color } : undefined}
        >
          {label}
        </h4>
        <span className="text-[10px] tabular-nums font-medium text-muted-foreground/70 px-1.5 py-px rounded-full bg-muted/60 ring-1 ring-border/30">
          {users.length}
        </span>
      </div>
      <div className="space-y-0.5">
        {users.map((user) => (
          <User
            key={user.id}
            userId={user.id}
            name={getDisplayName(user)}
            banned={user.banned}
            timedOutUntil={getTimedOutUntil(user)}
            status={user.status}
            customStatus={user.customStatus}
            gamePresence={user.gamePresence}
            nameplate={user.nameplate}
            nameStyle={user.nameStyle}
            _identity={user._identity}
            system={user.system}
            e2ee={e2ee}
            dimmed={dimmed}
          />
        ))}
      </div>
    </div>
  )
);

/**
 * Who is playing what, grouped by game, at the top of the pane. Only
 * exists while someone is playing (an empty section is nothing, not a
 * header); the chevron folds the groups away for a session.
 */
const NowPlayingSection = memo(
  ({ users, e2ee }: { users: TJoinedPublicUser[]; e2ee?: boolean }) => {
    const groups = useMemo(() => groupMembersByGame(users), [users]);
    const [collapsed, setCollapsed] = useState(false);
    if (groups.length === 0) return null;
    const playing = groups.reduce((n, g) => n + g.users.length, 0);

    return (
      <div className="border-b border-border/40 pb-2">
        <button
          type="button"
          onClick={() => setCollapsed((prev) => !prev)}
          aria-expanded={!collapsed}
          className="flex w-full items-center gap-2 px-2 pt-4 pb-1.5 text-left"
        >
          <Gamepad2 className="h-3.5 w-3.5 text-primary" aria-hidden />
          <h4 className="text-xs font-semibold text-foreground/90">Now playing</h4>
          <span className="text-[10px] tabular-nums font-medium text-muted-foreground/70 px-1.5 py-px rounded-full bg-muted/60 ring-1 ring-border/30">
            {playing}
          </span>
          <ChevronDown
            className={cn(
              'ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform',
              collapsed && '-rotate-90'
            )}
            aria-hidden
          />
        </button>
        {!collapsed &&
          groups.map((group) => (
            <div key={group.game} className="mb-1">
              <div className="truncate px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {group.game}
              </div>
              <div className="space-y-0.5">
                {group.users.map((user) => (
                  <User
                    key={user.id}
                    userId={user.id}
                    name={getDisplayName(user)}
                    banned={user.banned}
                    timedOutUntil={getTimedOutUntil(user)}
                    status={user.status}
                    customStatus={user.customStatus}
                    gamePresence={user.gamePresence}
                    nameplate={user.nameplate}
                    nameStyle={user.nameStyle}
                    _identity={user._identity}
                    system={user.system}
                    e2ee={e2ee}
                  />
                ))}
              </div>
            </div>
          ))}
      </div>
    );
  }
);

type TRightSidebarProps = {
  className?: string;
  isOpen?: boolean;
};

const RightSidebar = memo(
  ({ className, isOpen = true }: TRightSidebarProps) => {
    const { groups, offlineUsers } = useSelector(usersGroupedByRoleSelector);
    const usersLoaded = useSelector(
      (state: IRootState) => state.server.usersLoaded
    );
    const selectedChannel = useSelectedChannel();
    const [visibleUserIds, setVisibleUserIds] = useState<Set<number> | null>(
      null
    );

    useEffect(() => {
      if (!selectedChannel || !selectedChannel.private) {
        setVisibleUserIds(null);
        return;
      }

      let cancelled = false;
      const trpc = getTRPCClient();
      if (!trpc) return;

      trpc.channels.getVisibleUsers
        .query({ channelId: selectedChannel.id })
        .then((userIds) => {
          if (!cancelled) {
            setVisibleUserIds(new Set(userIds));
          }
        })
        .catch(() => {
          if (!cancelled) {
            setVisibleUserIds(null);
          }
        });

      return () => {
        cancelled = true;
      };
    }, [selectedChannel]);

    const filteredGroups = useMemo(() => {
      if (!visibleUserIds) return groups;

      return groups
        .map((group) => ({
          ...group,
          users: group.users.filter((u) => visibleUserIds.has(u.id))
        }))
        .filter((group) => group.users.length > 0);
    }, [groups, visibleUserIds]);

    const filteredOfflineUsers = useMemo(() => {
      if (!visibleUserIds) return offlineUsers;

      return offlineUsers.filter((u) => visibleUserIds.has(u.id));
    }, [offlineUsers, visibleUserIds]);

    // The "Now playing" groups draw from the same visible set as the
    // role groups: a private channel's roster must not list a player
    // its members cannot see.
    const visibleOnlineUsers = useMemo(
      () => filteredGroups.flatMap((group) => group.users),
      [filteredGroups]
    );

    return (
      <aside
        className={cn(
          'flex flex-col bg-card lg:bg-sidebar/50 h-full transition-all duration-300 ease-out overflow-hidden',
          isOpen ? 'w-60' : 'w-0',
          className
        )}
        style={{
          overflow: isOpen ? 'visible' : 'hidden'
        }}
      >
        {isOpen && (
          <>
            {!usersLoaded ? (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto p-2 pt-0">
                <NowPlayingSection
                  users={visibleOnlineUsers}
                  e2ee={selectedChannel?.e2ee}
                />
                {filteredGroups.map((group) => (
                  <RoleGroupSection
                    key={group.role?.id ?? 'online'}
                    label={group.role?.name ?? 'Online'}
                    color={group.role?.color}
                    users={group.users}
                    e2ee={selectedChannel?.e2ee}
                  />
                ))}
                {filteredOfflineUsers.length > 0 && (
                  <RoleGroupSection
                    label="Offline"
                    users={filteredOfflineUsers}
                    dimmed
                    e2ee={selectedChannel?.e2ee}
                  />
                )}
              </div>
            )}
          </>
        )}
      </aside>
    );
  }
);

export { RightSidebar };

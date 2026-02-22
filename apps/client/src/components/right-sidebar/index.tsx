import { UserAvatar } from '@/components/user-avatar';
import { useSelectedChannel } from '@/features/server/channels/hooks';
import { useUserDisplayRole } from '@/features/server/hooks';
import { usersGroupedByRoleSelector } from '@/features/server/users/selectors';
import { getDisplayName } from '@/helpers/get-display-name';
import { getTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import type { TJoinedPublicUser } from '@pulse/shared';
import { UserStatus } from '@pulse/shared';
import { Globe } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { UserPopover } from '../user-popover';
import { UserStatusBadge } from '../user-status';

type TUserProps = {
  userId: number;
  name: string;
  banned: boolean;
  status?: UserStatus;
  _identity?: string;
};

const User = memo(({ userId, name, banned, status, _identity }: TUserProps) => {
  const displayRole = useUserDisplayRole(userId);
  const nameColor =
    displayRole?.color && displayRole.color !== '#ffffff'
      ? displayRole.color
      : undefined;

  return (
    <UserPopover userId={userId}>
      <div className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent/40 select-none transition-colors duration-150 cursor-pointer">
        <div className="relative flex-shrink-0">
          <UserAvatar userId={userId} className="h-8 w-8" showStatusBadge={false} />
          <div className="absolute -bottom-0.5 -right-0.5">
            <UserStatusBadge
              status={status || UserStatus.OFFLINE}
              className="h-3 w-3"
            />
          </div>
        </div>
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={cn(
              'text-sm truncate',
              banned && 'line-through text-muted-foreground',
              !banned && !nameColor && 'text-foreground/80'
            )}
            style={!banned && nameColor ? { color: nameColor } : undefined}
          >
            {name}
          </span>
          {_identity?.includes('@') && (
            <Globe className="h-3 w-3 text-blue-500 shrink-0" />
          )}
        </div>
      </div>
    </UserPopover>
  );
});

const RoleGroupSection = memo(
  ({
    label,
    color,
    users,
    dimmed
  }: {
    label: string;
    color?: string;
    users: TJoinedPublicUser[];
    dimmed?: boolean;
  }) => (
    <div className={cn(dimmed && 'opacity-50')}>
      <h4
        className={cn(
          'px-2 pt-4 pb-1 text-[11px] font-bold uppercase tracking-widest',
          !(color && color !== '#ffffff') && 'text-muted-foreground'
        )}
        style={color && color !== '#ffffff' ? { color } : undefined}
      >
        {label} — {users.length}
      </h4>
      <div className="space-y-0.5">
        {users.map((user) => (
          <User
            key={user.id}
            userId={user.id}
            name={getDisplayName(user)}
            banned={user.banned}
            status={user.status}
            _identity={user._identity}
          />
        ))}
      </div>
    </div>
  )
);

type TRightSidebarProps = {
  className?: string;
  isOpen?: boolean;
};

const RightSidebar = memo(
  ({ className, isOpen = true }: TRightSidebarProps) => {
    const { groups, offlineUsers } = useSelector(usersGroupedByRoleSelector);
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

    return (
      <aside
        className={cn(
          'flex flex-col bg-card h-full transition-all duration-300 ease-out overflow-hidden',
          isOpen ? 'w-60' : 'w-0',
          className
        )}
        style={{
          overflow: isOpen ? 'visible' : 'hidden'
        }}
      >
        {isOpen && (
          <>
            <div className="flex-1 overflow-y-auto p-2 pt-0">
              {filteredGroups.map((group) => (
                <RoleGroupSection
                  key={group.role?.id ?? 'online'}
                  label={group.role?.name ?? 'Online'}
                  color={group.role?.color}
                  users={group.users}
                />
              ))}
              {filteredOfflineUsers.length > 0 && (
                <RoleGroupSection
                  label="Offline"
                  users={filteredOfflineUsers}
                  dimmed
                />
              )}
            </div>
          </>
        )}
      </aside>
    );
  }
);

export { RightSidebar };

import { UserAvatar } from '@/components/user-avatar';
import { useDmChannels } from '@/features/dms/hooks';
import { useOwnUserId } from '@/features/server/users/hooks';
import { getDisplayName } from '@/helpers/get-display-name';
import { cn } from '@/lib/utils';
import { UserStatus, type TJoinedPublicUser } from '@pulse/shared';
import { format } from 'date-fns';
import { Globe } from 'lucide-react';
import { memo, useMemo } from 'react';

const STATUS_LABEL: Record<UserStatus, string> = {
  [UserStatus.ONLINE]: 'Online',
  [UserStatus.IDLE]: 'Idle',
  [UserStatus.DND]: 'Do not disturb',
  [UserStatus.INVISIBLE]: 'Offline',
  [UserStatus.OFFLINE]: 'Offline'
};

const STATUS_DOT: Record<UserStatus, string> = {
  [UserStatus.ONLINE]: 'bg-green-500',
  [UserStatus.IDLE]: 'bg-yellow-500',
  [UserStatus.DND]: 'bg-red-500',
  [UserStatus.INVISIBLE]: 'bg-muted-foreground',
  [UserStatus.OFFLINE]: 'bg-muted-foreground'
};

/**
 * Right-side panel for the DM view. Mirrors the visual rhythm of the
 * server's `RightSidebar` (same width, `bg-card`, slide animation) so
 * DM and server screens read as one product, not two.
 *
 * Two content shapes:
 *   - 1:1 DM   → partner profile (avatar, name, status, federation,
 *                bio, member-since).
 *   - Group DM → flat member list with the same chip styling we just
 *                shipped on the server's role-group headers.
 *
 * v1 deliberately omits "mutual servers" / "mutual friends" — those
 * need new tRPC procedures and aren't blocking the layout fix.
 */
const DmProfilePanel = memo(
  ({
    dmChannelId,
    isOpen
  }: {
    dmChannelId: number;
    isOpen: boolean;
  }) => {
    const dmChannels = useDmChannels();
    const ownUserId = useOwnUserId();

    const channel = useMemo(
      () => dmChannels.find((c) => c.id === dmChannelId),
      [dmChannels, dmChannelId]
    );

    const otherMembers = useMemo(
      () => channel?.members.filter((m) => m.id !== ownUserId) ?? [],
      [channel, ownUserId]
    );

    const isGroup = !!channel?.isGroup;
    const single = !isGroup && otherMembers.length === 1 ? otherMembers[0] : null;

    return (
      <aside
        className={cn(
          'flex flex-col bg-card h-full transition-all duration-300 ease-out overflow-hidden',
          isOpen ? 'w-60' : 'w-0'
        )}
        style={{ overflow: isOpen ? 'visible' : 'hidden' }}
      >
        {single && <ProfileBody user={single} />}
        {isGroup && <GroupBody members={otherMembers} groupName={channel?.name} />}
      </aside>
    );
  }
);

const ProfileBody = memo(({ user }: { user: TJoinedPublicUser }) => {
  const status = user.status ?? UserStatus.OFFLINE;
  const memberSince = useMemo(() => {
    if (!user.createdAt) return null;
    return format(new Date(user.createdAt), 'MMM d, yyyy');
  }, [user.createdAt]);

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Banner area — uses bannerColor when no banner image is set,
          gives the panel a touch of personality without requiring an
          uploaded banner. Height matches the avatar overlap pattern
          you see on most modern profile cards. */}
      <div
        className="h-20 shrink-0"
        style={{ backgroundColor: user.bannerColor ?? undefined }}
      />
      <div className="px-4 pb-4 -mt-10">
        <div className="relative inline-block">
          <UserAvatar
            userId={user.id}
            className="h-20 w-20 ring-4 ring-card"
            showStatusBadge
            showUserPopover={false}
          />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <h3 className="text-base font-semibold text-foreground truncate">
            {getDisplayName(user)}
          </h3>
          {user._identity && (
            <Globe
              className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0"
              aria-label="Federated user"
            />
          )}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn('h-2 w-2 rounded-full', STATUS_DOT[status])} />
          <span>{STATUS_LABEL[status]}</span>
        </div>

        {user.bio && (
          <Section label="About me">
            <p className="text-xs text-foreground/80 whitespace-pre-wrap break-words">
              {user.bio}
            </p>
          </Section>
        )}

        {memberSince && (
          <Section label="Member since">
            <p className="text-xs text-foreground/80">{memberSince}</p>
          </Section>
        )}
      </div>
    </div>
  );
});

const GroupBody = memo(
  ({
    members,
    groupName
  }: {
    members: TJoinedPublicUser[];
    groupName?: string | null;
  }) => {
    return (
      <div className="flex flex-col h-full overflow-y-auto p-2">
        {groupName && (
          <h3 className="px-2 pt-2 pb-3 text-base font-semibold text-foreground truncate">
            {groupName}
          </h3>
        )}
        <div className="flex items-center gap-2 px-2 pt-2 pb-1.5">
          <h4 className="text-xs font-semibold text-muted-foreground/80">
            Members
          </h4>
          <span className="text-[10px] tabular-nums font-medium text-muted-foreground/70 px-1.5 py-px rounded-full bg-muted/60 ring-1 ring-border/30">
            {members.length}
          </span>
        </div>
        <div className="flex flex-col">
          {members.map((m) => (
            <MemberRow key={m.id} user={m} />
          ))}
        </div>
      </div>
    );
  }
);

const MemberRow = memo(({ user }: { user: TJoinedPublicUser }) => {
  return (
    <div className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-accent/40 transition-colors">
      <UserAvatar
        userId={user.id}
        className="h-7 w-7"
        showStatusBadge
        showUserPopover
      />
      <span className="text-sm text-foreground truncate flex-1">
        {getDisplayName(user)}
      </span>
      {user._identity && (
        <Globe
          className="h-3 w-3 text-muted-foreground/70 shrink-0"
          aria-label="Federated user"
        />
      )}
    </div>
  );
});

const Section = memo(
  ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="mt-4">
      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-1.5">
        {label}
      </h4>
      {children}
    </div>
  )
);

DmProfilePanel.displayName = 'DmProfilePanel';
ProfileBody.displayName = 'ProfileBody';
GroupBody.displayName = 'GroupBody';
MemberRow.displayName = 'MemberRow';
Section.displayName = 'Section';

export { DmProfilePanel };

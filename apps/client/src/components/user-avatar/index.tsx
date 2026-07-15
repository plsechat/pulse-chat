import { useActiveInstanceDomain } from '@/features/app/hooks';
import { useHomeUserById, useUserById } from '@/features/server/users/hooks';
import { getFileUrl } from '@/helpers/get-file-url';
import { getInitialsFromName } from '@/helpers/get-initials-from-name';
import { cn } from '@/lib/utils';
import { UserStatus } from '@pulse/shared';
import { memo } from 'react';
// Use the local AvatarImage wrapper (not the raw radix primitive) so
// the `object-cover object-center` styling lands. Importing directly
// from @radix-ui/react-avatar leaves the <img> with browser-default
// `object-fit: fill`, which warps non-square uploads into a strip on
// the left of the circle — the original "right quarter empty" report.
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar';
import { UserPopover } from '../user-popover';
import { UserStatusBadge } from '../user-status';

type TUserAvatarProps = {
  userId: number;
  className?: string;
  showUserPopover?: boolean;
  showStatusBadge?: boolean;
  /**
   * Resolve `userId` in HOME id-space and serve the avatar file from the
   * home instance. REQUIRED on home-scoped surfaces (DM conversations,
   * friends) rendered while a federated server is active: their ids are
   * home ids, but the default ambient lookup reads the REMOTE roster,
   * where the same numeric id is a different person (the federated-DM
   * identity-swap bug).
   */
  homeScope?: boolean;
  onClick?: () => void;
};

const avatarGradients = [
  'from-violet-600 to-indigo-600',
  'from-rose-500 to-orange-500',
  'from-emerald-500 to-teal-500',
  'from-blue-500 to-cyan-500',
  'from-fuchsia-500 to-pink-500',
  'from-amber-500 to-yellow-500',
  'from-sky-500 to-blue-600',
  'from-red-500 to-rose-600'
];

const UserAvatar = memo(
  ({
    userId,
    className,
    showUserPopover = false,
    showStatusBadge = true,
    homeScope = false,
    onClick
  }: TUserAvatarProps) => {
    const ambientUser = useUserById(userId);
    const homeUser = useHomeUserById(userId);
    const activeInstanceDomain = useActiveInstanceDomain();

    const user = homeScope ? homeUser : ambientUser;
    // Home-scoped avatars are files on the HOME instance — never route
    // them through the active federated instance's public route.
    const fileInstanceDomain = homeScope
      ? undefined
      : (activeInstanceDomain ?? undefined);

    if (!user) return null;

    const content = (
      <div className="relative w-fit h-fit" onClick={onClick}>
        <Avatar className={cn('h-8 w-8 ring-1 ring-border/50 shadow-sm', className)}>
          <AvatarImage src={getFileUrl(user.avatar, fileInstanceDomain)} key={user.avatarId} />
          <AvatarFallback className={cn('text-xs text-white bg-gradient-to-br', avatarGradients[userId % avatarGradients.length])}>
            {getInitialsFromName(user.name)}
          </AvatarFallback>
        </Avatar>
        {showStatusBadge && (
          <UserStatusBadge
            status={user.status || UserStatus.OFFLINE}
            className="absolute bottom-0 right-0"
          />
        )}
      </div>
    );

    if (!showUserPopover) return content;

    // Forward the scope: a correctly home-resolved avatar wrapping an
    // ambient-resolved popover would show the WRONG identity on click.
    return (
      <UserPopover userId={userId} homeScope={homeScope}>
        {content}
      </UserPopover>
    );
  }
);

export { UserAvatar };

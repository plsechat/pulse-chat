import { useActiveInstanceDomain } from '@/features/app/hooks';
import { useUserById } from '@/features/server/users/hooks';
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
    onClick
  }: TUserAvatarProps) => {
    const user = useUserById(userId);
    const activeInstanceDomain = useActiveInstanceDomain();

    if (!user) return null;

    const content = (
      <div className="relative w-fit h-fit" onClick={onClick}>
        <Avatar className={cn('h-8 w-8 ring-1 ring-border/50 shadow-sm', className)}>
          <AvatarImage src={getFileUrl(user.avatar, activeInstanceDomain ?? undefined)} key={user.avatarId} />
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

    return <UserPopover userId={userId}>{content}</UserPopover>;
  }
);

export { UserAvatar };

import { useUserById } from '@/features/server/users/hooks';
import { getFileUrl } from '@/helpers/get-file-url';
import { getInitialsFromName } from '@/helpers/get-initials-from-name';
import { cn } from '@/lib/utils';
import { AvatarImage } from '@radix-ui/react-avatar';
import { UserStatus } from '@pulse/shared';
import { memo, useMemo } from 'react';
import { Avatar, AvatarFallback } from '../ui/avatar';
import { UserPopover } from '../user-popover';
import { UserStatusBadge } from '../user-status';

type TUserAvatarProps = {
  userId: number;
  className?: string;
  showUserPopover?: boolean;
  showStatusBadge?: boolean;
  onClick?: () => void;
};

const UserAvatar = memo(
  ({
    userId,
    className,
    showUserPopover = false,
    showStatusBadge = true,
    onClick
  }: TUserAvatarProps) => {
    const user = useUserById(userId);

    // Extract instance domain from federated user identity (e.g. "user@remote.com")
    const instanceDomain = useMemo(
      () =>
        user?._identity?.includes('@')
          ? user._identity.split('@').slice(1).join('@')
          : undefined,
      [user?._identity]
    );

    if (!user) return null;

    const content = (
      <div className="relative w-fit h-fit" onClick={onClick}>
        <Avatar className={cn('h-8 w-8', className)}>
          <AvatarImage src={getFileUrl(user.avatar, instanceDomain)} key={user.avatarId} />
          <AvatarFallback className="bg-muted text-xs">
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

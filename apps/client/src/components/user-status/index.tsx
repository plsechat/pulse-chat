import { cn } from '@/lib/utils';
import { UserStatus } from '@pulse/shared';
import { MinusCircle, Moon } from 'lucide-react';
import { memo } from 'react';

type TUserStatusBadgeProps = {
  status: UserStatus;
  className?: string;
};

const statusConfig: Record<
  UserStatus,
  { color: string; label: string; icon?: 'moon' | 'dnd' }
> = {
  [UserStatus.ONLINE]: { color: 'bg-emerald-500', label: 'Online' },
  [UserStatus.IDLE]: { color: 'bg-amber-400', label: 'Idle', icon: 'moon' },
  [UserStatus.DND]: {
    color: 'bg-rose-500',
    label: 'Do Not Disturb',
    icon: 'dnd'
  },
  [UserStatus.INVISIBLE]: { color: 'bg-gray-500', label: 'Invisible' },
  [UserStatus.OFFLINE]: { color: 'bg-gray-500', label: 'Offline' }
};

const UserStatusBadge = memo(({ status, className }: TUserStatusBadgeProps) => {
  const config = statusConfig[status] || statusConfig[UserStatus.OFFLINE];

  if (config.icon === 'moon') {
    return (
      <div
        className={cn(
          'relative flex items-center justify-center rounded-full border-2 border-card h-3 w-3',
          config.color,
          className
        )}
      >
        <Moon className="h-[60%] w-[60%] text-card fill-card" />
      </div>
    );
  }

  if (config.icon === 'dnd') {
    return (
      <div
        className={cn(
          'relative flex items-center justify-center rounded-full border-2 border-card h-3 w-3',
          config.color,
          className
        )}
      >
        <MinusCircle className="h-[70%] w-[70%] text-card fill-rose-500 stroke-card" />
      </div>
    );
  }

  // Online, Invisible, Offline — simple filled circle
  return (
    <div
      className={cn(
        'rounded-full border-2 border-card h-3 w-3',
        config.color,
        // Invisible/Offline: hollow ring effect
        (status === UserStatus.INVISIBLE || status === UserStatus.OFFLINE) &&
          'bg-transparent ring-[2px] ring-inset ring-gray-500',
        className
      )}
    />
  );
});

const getStatusLabel = (status: UserStatus): string => {
  return statusConfig[status]?.label || 'Offline';
};

// eslint-disable-next-line react-refresh/only-export-components
export { getStatusLabel, statusConfig, UserStatusBadge };

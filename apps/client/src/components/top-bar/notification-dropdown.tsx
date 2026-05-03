import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import { NotificationLevel } from '@pulse/shared';
import { Bell, BellOff, BellRing, Check } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu';
import { Tooltip } from '../ui/tooltip';

type TNotificationDropdownProps = {
  channelId: number;
};

const LEVEL_OPTIONS = [
  { value: NotificationLevel.ALL, label: 'All Messages', icon: BellRing },
  { value: NotificationLevel.MENTIONS, label: 'Only @mentions', icon: Bell },
  { value: NotificationLevel.NOTHING, label: 'Nothing', icon: BellOff },
] as const;

const NotificationDropdown = memo(({ channelId }: TNotificationDropdownProps) => {
  const [level, setLevel] = useState<NotificationLevel>(NotificationLevel.DEFAULT);

  useEffect(() => {
    const fetchLevel = async () => {
      try {
        const trpc = getTRPCClient();
        const result = await trpc.notifications.getSetting.query({ channelId });

        setLevel(result.level);
      } catch {
        // Silently fall back to default
      }
    };

    fetchLevel();
  }, [channelId]);

  const onSetLevel = useCallback(
    async (newLevel: NotificationLevel) => {
      const trpc = getTRPCClient();

      try {
        await trpc.notifications.setSetting.mutate({
          channelId,
          level: newLevel
        });
        setLevel(newLevel);
        toast.success('Notification preference updated');
      } catch (err) {
        toast.error(getTrpcError(err, 'Failed to update notification preference'));
      }
    },
    [channelId]
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 transition-all duration-200 ease-in-out"
        >
          <Tooltip content="Notification Settings">
            <div>
              <Bell className="w-4 h-4" />
            </div>
          </Tooltip>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {LEVEL_OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onClick={() => onSetLevel(option.value)}
            className="flex items-center gap-2"
          >
            <option.icon className="w-4 h-4" />
            <span>{option.label}</span>
            {level === option.value && (
              <Check className="w-3 h-3 ml-auto" />
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => onSetLevel(NotificationLevel.DEFAULT)}
          className="flex items-center gap-2"
        >
          <Bell className="w-4 h-4" />
          <span>Use Default</span>
          {level === NotificationLevel.DEFAULT && (
            <Check className="w-3 h-3 ml-auto" />
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

export { NotificationDropdown };

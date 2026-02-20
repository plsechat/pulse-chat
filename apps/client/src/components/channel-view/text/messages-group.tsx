import { UserContextMenu } from '@/components/context-menus/user';
import { UserAvatar } from '@/components/user-avatar';
import { UserPopover } from '@/components/user-popover';
import { useUserDisplayRole } from '@/features/server/hooks';
import { useUserById } from '@/features/server/users/hooks';
import { useAppearanceSettings } from '@/hooks/use-appearance-settings';
import { cn } from '@/lib/utils';
import type { TJoinedMessage } from '@pulse/shared';
import { format, isToday, isYesterday } from 'date-fns';
import { memo } from 'react';
import { Tooltip } from '../../ui/tooltip';
import { Message } from './message';
import { MessageErrorBoundary } from './message-error-boundary';

type TMessagesGroupProps = {
  group: TJoinedMessage[];
  onReply: (message: TJoinedMessage) => void;
};

const spacingMap = {
  tight: 'mt-1',
  normal: 'mt-[1.0625rem]',
  relaxed: 'mt-6'
} as const;

const MessagesGroup = memo(({ group, onReply }: TMessagesGroupProps) => {
  const firstMessage = group[0];
  const user = useUserById(firstMessage.userId);
  const date = new Date(firstMessage.createdAt);
  const displayRole = useUserDisplayRole(firstMessage.userId);
  const { settings } = useAppearanceSettings();
  const { compactMode, messageSpacing } = settings;

  if (!user) return null;

  // Check if this is a webhook message and extract alias
  const webhookMeta = firstMessage.webhookId
    ? firstMessage.metadata?.find((m) => m.mediaType === 'webhook')
    : null;
  const isWebhook = !!webhookMeta;
  const displayName = isWebhook && webhookMeta?.title ? webhookMeta.title : user.name;

  const nameColor =
    !isWebhook && displayRole?.color && displayRole.color !== '#ffffff'
      ? displayRole.color
      : undefined;

  const timeStr = isToday(date)
    ? `Today at ${format(date, 'h:mm a')}`
    : isYesterday(date)
      ? `Yesterday at ${format(date, 'h:mm a')}`
      : format(date, 'MM/dd/yyyy h:mm a');

  if (compactMode) {
    return (
      <div className={cn(spacingMap[messageSpacing], 'flex min-w-0 gap-2 pl-[40px] pr-12 relative py-0.5')}>
        <UserContextMenu userId={user.id}>
          <div className="absolute left-3 top-1">
            <UserAvatar userId={user.id} className="h-5 w-5" showUserPopover />
          </div>
        </UserContextMenu>
        <div className="flex min-w-0 flex-col w-full">
          <div className="flex gap-2 items-baseline select-none leading-[1.375rem]">
            <Tooltip content={format(date, 'PPpp')}>
              <span className="text-muted-foreground/50 text-[10px] shrink-0">
                {format(date, 'h:mm a')}
              </span>
            </Tooltip>
            <UserContextMenu userId={user.id}>
              <UserPopover userId={user.id}>
                <span
                  className="font-medium hover:underline cursor-pointer text-sm"
                  style={nameColor ? { color: nameColor } : undefined}
                >
                  {displayName}
                </span>
              </UserPopover>
            </UserContextMenu>
            {user._identity?.includes('@') && (
              <Tooltip content={user._identity}>
                <span className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500 cursor-default">
                  FED
                </span>
              </Tooltip>
            )}
            {isWebhook && (
              <span className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                BOT
              </span>
            )}
          </div>
          {group.map((message) => (
            <MessageErrorBoundary key={message.id} messageId={message.id}>
              <Message message={message} onReply={() => onReply(message)} />
            </MessageErrorBoundary>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={cn(spacingMap[messageSpacing], 'flex min-w-0 gap-4 pl-[72px] pr-12 relative py-0.5')}>
      <UserContextMenu userId={user.id}>
        <div className="absolute left-4 top-1">
          <UserAvatar userId={user.id} className="h-10 w-10" showUserPopover />
        </div>
      </UserContextMenu>
      <div className="flex min-w-0 flex-col w-full">
        <div className="flex gap-2 items-baseline select-none leading-[1.375rem]">
          <UserContextMenu userId={user.id}>
            <UserPopover userId={user.id}>
              <span
                className="font-medium hover:underline cursor-pointer"
                style={nameColor ? { color: nameColor } : undefined}
              >
                {displayName}
              </span>
            </UserPopover>
          </UserContextMenu>
          {user._identity?.includes('@') && (
            <Tooltip content={user._identity}>
              <span className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500 cursor-default">
                FED
              </span>
            </Tooltip>
          )}
          {isWebhook && (
            <span className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/10 text-primary">
              BOT
            </span>
          )}
          <Tooltip content={format(date, 'PPpp')}>
            <span className="text-muted-foreground/50 text-xs">
              {timeStr}
            </span>
          </Tooltip>
        </div>
        {group.map((message) => (
          <MessageErrorBoundary key={message.id} messageId={message.id}>
            <Message message={message} onReply={() => onReply(message)} />
          </MessageErrorBoundary>
        ))}
      </div>
    </div>
  );
});

export { MessagesGroup };

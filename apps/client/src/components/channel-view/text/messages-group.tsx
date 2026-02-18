import { UserContextMenu } from '@/components/context-menus/user';
import { UserAvatar } from '@/components/user-avatar';
import { useUserDisplayRole } from '@/features/server/hooks';
import { useUserById } from '@/features/server/users/hooks';
import type { TJoinedMessage } from '@pulse/shared';
import { format, isToday, isYesterday } from 'date-fns';
import { memo } from 'react';
import { Tooltip } from '../../ui/tooltip';
import { Message } from './message';

type TMessagesGroupProps = {
  group: TJoinedMessage[];
  onReply: (message: TJoinedMessage) => void;
};

const MessagesGroup = memo(({ group, onReply }: TMessagesGroupProps) => {
  const firstMessage = group[0];
  const user = useUserById(firstMessage.userId);
  const date = new Date(firstMessage.createdAt);
  const displayRole = useUserDisplayRole(firstMessage.userId);

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

  return (
    <div className="mt-[1.0625rem] flex min-w-0 gap-4 pl-[72px] pr-12 relative py-0.5 hover:bg-foreground/[0.02]">
      <UserContextMenu userId={user.id}>
        <div className="absolute left-4 top-1">
          <UserAvatar userId={user.id} className="h-10 w-10" showUserPopover />
        </div>
      </UserContextMenu>
      <div className="flex min-w-0 flex-col w-full">
        <div className="flex gap-2 items-baseline select-none leading-[1.375rem]">
          <UserContextMenu userId={user.id}>
            <span
              className="font-medium hover:underline cursor-pointer"
              style={nameColor ? { color: nameColor } : undefined}
            >
              {displayName}
            </span>
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
              {isToday(date)
                ? `Today at ${format(date, 'h:mm a')}`
                : isYesterday(date)
                  ? `Yesterday at ${format(date, 'h:mm a')}`
                  : format(date, 'MM/dd/yyyy h:mm a')}
            </span>
          </Tooltip>
        </div>
        {group.map((message) => (
          <Message key={message.id} message={message} onReply={() => onReply(message)} />
        ))}
      </div>
    </div>
  );
});

export { MessagesGroup };

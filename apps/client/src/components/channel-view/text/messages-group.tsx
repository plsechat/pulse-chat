import { UserContextMenu } from '@/components/context-menus/user';
import { UserAvatar } from '@/components/user-avatar';
import { UserPopover } from '@/components/user-popover';
import { useForumThreadCreator } from '@/components/channel-view/forum/forum-thread-context';
import { useUserDisplayRole } from '@/features/server/hooks';
import { useUserById } from '@/features/server/users/hooks';
import { getDisplayName } from '@/helpers/get-display-name';
import { getNameStyleCss } from '@/helpers/name-style';
import { useAppearanceSettings } from '@/hooks/use-appearance-settings';
import { cn } from '@/lib/utils';
import { useReadableRoleColor } from '@/hooks/use-readable-role-color';
import type { TJoinedMessage } from '@pulse/shared';
import { fullDateTime, groupTimestamp, timeOnly } from '@/helpers/time-format';
import { format } from 'date-fns';
import { memo } from 'react';
import { Tooltip } from '../../ui/tooltip';
import { Message } from './message';
import { MessageErrorBoundary } from '@/components/chat-primitives/message-error-boundary';

type TMessagesGroupProps = {
  group: TJoinedMessage[];
  onReply: (message: TJoinedMessage) => void;
};

const spacingMap = {
  tight: 'mt-1',
  normal: 'mt-4',
  relaxed: 'mt-6'
} as const;

const MessagesGroup = memo(({ group, onReply }: TMessagesGroupProps) => {
  const firstMessage = group[0];
  const user = useUserById(firstMessage.userId);
  const date = new Date(firstMessage.createdAt);
  const displayRole = useUserDisplayRole(firstMessage.userId);
  const { settings } = useAppearanceSettings();
  const { compactMode, messageSpacing } = settings;
  const forumThreadCreatorId = useForumThreadCreator();
  const isOP = forumThreadCreatorId !== null && firstMessage.userId === forumThreadCreatorId;

  // Check if this is a webhook message and extract alias
  const webhookMeta = firstMessage.webhookId
    ? firstMessage.metadata?.find((m) => m.mediaType === 'webhook')
    : null;
  const isWebhook = !!webhookMeta;

  // Hook order: must run unconditionally, before the !user early return
  const nameColor = useReadableRoleColor(
    !isWebhook ? displayRole?.color : undefined
  );
  // Styled name wins over role color; webhook aliases stay unstyled
  // (the alias is the webhook's persona, not the user's).
  const nameCss = !isWebhook ? getNameStyleCss(user?.nameStyle) : null;

  if (!user) return null;

  const displayName = isWebhook && webhookMeta?.title ? webhookMeta.title : getDisplayName(user);

  const timeStr = groupTimestamp(date);

  if (compactMode) {
    return (
      <div className={cn(spacingMap[messageSpacing], 'flex min-w-0 gap-2 pl-[40px] pr-12 relative py-0.5 group/msggroup')}>
        <UserContextMenu userId={user.id}>
          <div className="absolute left-3 top-1 z-10">
            <UserAvatar userId={user.id} className="h-5 w-5" showUserPopover />
          </div>
        </UserContextMenu>
        <div className="flex min-w-0 flex-col w-full">
          <div className="flex gap-2 items-baseline select-none leading-[1.375rem]">
            <Tooltip content={format(date, fullDateTime())}>
              <span className="text-muted-foreground/70 text-[10px] shrink-0 group-hover/msggroup:text-muted-foreground transition-colors duration-150">
                {format(date, timeOnly())}
              </span>
            </Tooltip>
            <UserContextMenu userId={user.id}>
              <UserPopover userId={user.id}>
                <span
                  className={cn(
                    'font-medium hover:underline cursor-pointer text-sm',
                    nameCss?.className
                  )}
                  style={
                    nameCss?.style ??
                    (nameColor ? { color: nameColor } : undefined)
                  }
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
            {isOP && (
              <span className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded bg-blue-600/20 text-blue-500">
                OP
              </span>
            )}
          </div>
          {group.map((message, index) => (
            <MessageErrorBoundary key={message.id} messageId={message.id}>
              <Message
                message={message}
                onReply={() => onReply(message)}
                compact
                isFirstInGroup={index === 0}
              />
            </MessageErrorBoundary>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={cn(spacingMap[messageSpacing], 'flex min-w-0 gap-4 pl-[72px] pr-12 relative py-0.5 group/msggroup')}>
      <UserContextMenu userId={user.id}>
        <div className="absolute left-4 top-1 z-10">
          <UserAvatar userId={user.id} className="h-10 w-10" showUserPopover />
        </div>
      </UserContextMenu>
      <div className="flex min-w-0 flex-col w-full">
        <div className="flex gap-2 items-baseline select-none leading-[1.375rem]">
          <UserContextMenu userId={user.id}>
            <UserPopover userId={user.id}>
              <span
                className={cn(
                  'font-medium hover:underline cursor-pointer',
                  nameCss?.className
                )}
                style={
                  nameCss?.style ??
                  (nameColor ? { color: nameColor } : undefined)
                }
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
          {isOP && (
            <span className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded bg-blue-600/20 text-blue-500">
              OP
            </span>
          )}
          <Tooltip content={format(date, fullDateTime())}>
            <span className="text-muted-foreground/70 text-xs group-hover/msggroup:text-muted-foreground transition-colors duration-150">
              {timeStr}
            </span>
          </Tooltip>
        </div>
        {group.map((message, index) => (
          <MessageErrorBoundary key={message.id} messageId={message.id}>
            <Message
              message={message}
              onReply={() => onReply(message)}
              isFirstInGroup={index === 0}
            />
          </MessageErrorBoundary>
        ))}
      </div>
    </div>
  );
});

export { MessagesGroup };

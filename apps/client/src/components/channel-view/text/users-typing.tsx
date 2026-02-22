import { TypingDots } from '@/components/typing-dots';
import { useTypingUsersByChannelId } from '@/features/server/hooks';
import { getDisplayName } from '@/helpers/get-display-name';
import { memo } from 'react';

type TUsersTypingProps = {
  channelId: number;
};

const UsersTyping = memo(({ channelId }: TUsersTypingProps) => {
  const typingUsers = useTypingUsersByChannelId(channelId);

  if (typingUsers.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground px-1">
      <div className="flex items-center gap-2">
        <TypingDots className="[&>div]:w-0.5 [&>div]:h-0.5" />
        <span>
          {typingUsers.length === 1
            ? `${getDisplayName(typingUsers[0])} is typing...`
            : typingUsers.length === 2
              ? `${getDisplayName(typingUsers[0])} and ${getDisplayName(typingUsers[1])} are typing...`
              : `${getDisplayName(typingUsers[0])} and ${typingUsers.length - 1} others are typing...`}
        </span>
      </div>
    </div>
  );
});

export { UsersTyping };

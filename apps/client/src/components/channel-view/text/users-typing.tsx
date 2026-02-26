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
    return <div className="h-6" />;
  }

  return (
    <div className="flex h-6 items-center gap-2 px-4 text-xs text-muted-foreground">
      <TypingDots />
      <span>
        {typingUsers.length === 1 ? (
          <>
            <strong>{getDisplayName(typingUsers[0])}</strong> is typing...
          </>
        ) : typingUsers.length === 2 ? (
          <>
            <strong>{getDisplayName(typingUsers[0])}</strong> and{' '}
            <strong>{getDisplayName(typingUsers[1])}</strong> are typing...
          </>
        ) : (
          <>
            <strong>{getDisplayName(typingUsers[0])}</strong> and{' '}
            {typingUsers.length - 1} others are typing...
          </>
        )}
      </span>
    </div>
  );
});

export { UsersTyping };

import { TypingIndicator } from '@/components/chat-primitives/typing-indicator';
import { useTypingUsersByChannelId } from '@/features/server/hooks';
import { getDisplayName } from '@/helpers/get-display-name';
import { memo } from 'react';

type TUsersTypingProps = {
  channelId: number;
};

const UsersTyping = memo(({ channelId }: TUsersTypingProps) => {
  const typingUsers = useTypingUsersByChannelId(channelId);

  return (
    <TypingIndicator
      names={typingUsers.slice(0, 2).map(getDisplayName)}
      total={typingUsers.length}
    />
  );
});

export { UsersTyping };

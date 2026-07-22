import {
  useHomeUserById,
  useUserById
} from '@/features/server/users/hooks';
import { useChatScope } from '@/components/chat-primitives/chat-scope';
import { Tooltip } from '@/components/ui/tooltip';
import { fullDateTime } from '@/helpers/time-format';
import { format } from 'date-fns';
import { ShieldAlert } from 'lucide-react';
import { memo } from 'react';

type SystemMessageProps = {
  message: {
    userId: number;
    content: string | null;
    createdAt: number;
  };
};

const SystemMessage = memo(({ message }: SystemMessageProps) => {
  // Identity-reset banners appear in DMs (home-space userId); resolve
  // against the home roster when scoped so the name is right under a
  // federated server.
  const { homeScope } = useChatScope();
  const ambientUser = useUserById(message.userId);
  const homeUser = useHomeUserById(message.userId);
  const user = homeScope ? homeUser : ambientUser;
  const date = new Date(message.createdAt);

  if (message.content === 'identity_reset') {
    return (
      <div className="flex justify-center py-2 px-4">
        <Tooltip content={format(date, fullDateTime())}>
          <div className="flex items-center gap-2 text-xs text-amber-500 bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-2 max-w-lg select-none backdrop-blur-sm shadow-sm">
            <ShieldAlert className="h-4 w-4 shrink-0 animate-pulse" />
            <span>
              <strong>{user?.name ?? 'Unknown user'}</strong>
              {"'s encryption keys have changed. This may mean they reinstalled the app or reset their keys."}
            </span>
          </div>
        </Tooltip>
      </div>
    );
  }

  return null;
});

export { SystemMessage };

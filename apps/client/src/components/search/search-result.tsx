import { UserAvatar } from '@/components/user-avatar';
import { useChannels } from '@/features/server/channels/hooks';
import { useUserById } from '@/features/server/users/hooks';
import type { TJoinedMessage } from '@pulse/shared';
import { longDateTime } from '@/helpers/time-format';
import { format } from 'date-fns';
import { ArrowRight, Hash } from 'lucide-react';
import { memo, useCallback, useMemo } from 'react';
import { Button } from '../ui/button';

type TSearchResultProps = {
  message: TJoinedMessage;
  query: string;
  onJump: (channelId: number, messageId: number) => void;
};

const highlightMatch = (text: string, query: string) => {
  if (!query || !text) return text;

  const stripped = text.replace(/<[^>]*>/g, '');
  const idx = stripped.toLowerCase().indexOf(query.toLowerCase());

  if (idx === -1) return stripped.slice(0, 150);

  const start = Math.max(0, idx - 40);
  const end = Math.min(stripped.length, idx + query.length + 80);
  const before = stripped.slice(start, idx);
  const match = stripped.slice(idx, idx + query.length);
  const after = stripped.slice(idx + query.length, end);

  return (
    <>
      {start > 0 && '...'}
      {before}
      <mark className="bg-yellow-500/30 text-foreground rounded-sm px-0.5">
        {match}
      </mark>
      {after}
      {end < stripped.length && '...'}
    </>
  );
};

const SearchResult = memo(({ message, query, onJump }: TSearchResultProps) => {
  const user = useUserById(message.userId);
  const channels = useChannels();
  const channel = useMemo(
    () => channels.find((c) => c.id === message.channelId),
    [channels, message.channelId]
  );

  const handleJump = useCallback(() => {
    onJump(message.channelId, message.id);
  }, [message.channelId, message.id, onJump]);

  return (
    <div className="p-3 hover:bg-secondary/30 border-b border-border/20 last:border-b-0 group/result">
      <div className="flex items-center gap-1.5 mb-1">
        <Hash className="w-3 h-3 text-muted-foreground" />
        <span className="text-xs text-muted-foreground font-medium flex-1">
          {channel?.name ?? 'Unknown'}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 px-1.5 text-[10px] opacity-0 group-hover/result:opacity-100 transition-opacity"
          onClick={handleJump}
        >
          Jump
          <ArrowRight className="w-3 h-3 ml-0.5" />
        </Button>
      </div>
      <div className="flex items-center gap-2 mb-1">
        <UserAvatar userId={message.userId} className="h-5 w-5" />
        <span className="text-sm font-medium">{user?.name ?? 'Unknown'}</span>
        <span className="text-xs text-muted-foreground">
          {format(new Date(message.createdAt), longDateTime())}
        </span>
      </div>
      <div className="text-sm text-muted-foreground pl-7">
        {highlightMatch(message.content ?? '', query)}
      </div>
    </div>
  );
});

export { SearchResult };

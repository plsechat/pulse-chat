import { ChatMessageBody } from '@/components/chat-primitives/message-body';
import { Tooltip } from '@/components/ui/tooltip';
import { useActiveInstanceDomain } from '@/features/app/hooks';
import { getPublicFileUrl } from '@/helpers/get-file-url';
import { fullDateTime } from '@/helpers/time-format';
import type { TAnnouncementRow } from '@pulse/server/types';
import { format } from 'date-fns';
import { Megaphone } from 'lucide-react';
import { memo } from 'react';

type TAnnouncementCardProps = {
  messageId: number;
  row: TAnnouncementRow;
  date: Date;
};

/**
 * The persona avatar: a `/public/<name>` of THIS instance (a local
 * source) is served from the active instance; a peer's avatar arrives
 * as an absolute URL and is used as given.
 */
const avatarSrc = (avatarUrl: string | null, instanceDomain: string | undefined) => {
  if (!avatarUrl) return null;
  if (avatarUrl.startsWith('/public/')) {
    return getPublicFileUrl(avatarUrl.slice('/public/'.length), instanceDomain);
  }
  return avatarUrl;
};

/**
 * A copy of a post from a followed announcement channel: where it came
 * from, who wrote it (as a persona — the author is not a member here),
 * and the content through the shared message body. Reactions are not
 * part of a copy.
 */
const AnnouncementCard = memo(({ messageId, row, date }: TAnnouncementCardProps) => {
  const instanceDomain = useActiveInstanceDomain() ?? undefined;
  const src = avatarSrc(row.author.avatarUrl, instanceDomain);
  const origin = row.source.domain
    ? `${row.source.serverName} · ${row.source.domain}`
    : row.source.serverName;

  return (
    <article
      className="mx-4 my-1.5 max-w-2xl rounded-xl border border-border/70 bg-card/60 p-3"
      aria-label={`Announcement from #${row.source.channelName} in ${row.source.serverName}`}
      data-testid="announcement-card"
    >
      <header className="flex items-center gap-2 text-xs text-muted-foreground">
        <Megaphone className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
        <span className="min-w-0 truncate">
          Announcement from <strong className="text-foreground">#{row.source.channelName}</strong>{' '}
          · {origin}
        </span>
        <Tooltip content={format(date, fullDateTime())}>
          <time dateTime={date.toISOString()} className="ml-auto shrink-0">
            {format(date, 'PP')}
          </time>
        </Tooltip>
      </header>
      <div className="mt-2 flex items-center gap-2">
        {src ? (
          <img src={src} alt="" className="h-6 w-6 rounded-full object-cover ring-1 ring-border/50" />
        ) : (
          <span
            aria-hidden="true"
            className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-semibold uppercase"
          >
            {row.author.name.slice(0, 1)}
          </span>
        )}
        <span className="text-sm font-medium">{row.author.name}</span>
      </div>
      <div className="mt-1.5 text-sm">
        <ChatMessageBody
          compact
          message={{
            id: messageId,
            content: row.content,
            e2ee: false,
            edited: row.edited,
            updatedAt: null,
            files: [],
            metadata: null,
            reactions: []
          }}
          instanceDomain={instanceDomain}
        />
        {row.edited && (
          <span className="ml-1 text-[10px] text-muted-foreground">(edited)</span>
        )}
      </div>
    </article>
  );
});

export { AnnouncementCard };

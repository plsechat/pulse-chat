import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { UserAvatar } from '@/components/user-avatar';
import { openWatch } from '@/components/watch-together/open-watch';
import { useActiveServerId } from '@/features/app/hooks';
import { useUserById } from '@/features/server/users/hooks';
import {
  cardElapsed,
  cardStatus,
  formatPlaybackTime,
  youtubeThumbnailUrl
} from '@/features/server/voice/watch-together';
import { getDisplayName } from '@/helpers/get-display-name';
import { fullDateTime } from '@/helpers/time-format';
import { cn } from '@/lib/utils';
import type { TWatchCard as TWatchCardState } from '@pulse/shared';
import { format } from 'date-fns';
import { MonitorPlay, Play } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';

/**
 * A watch-together session living in a text channel, as the plugin
 * posted it: what plays, who started it, whether it plays, is paused or
 * has ended, how far it is, how many have it open — and the one thing
 * to do with it, Watch, which opens the synced player (a side panel in
 * the tab layout, a dialog elsewhere). The card is the message's
 * metadata; every control the host or a moderator makes arrives as a
 * message update, so the card is always current without any state of
 * its own beyond the clock that moves the elapsed time.
 */

type TWatchCardProps = {
  channelId: number;
  messageId: number;
  card: TWatchCardState;
  date: Date;
};

/** Ticks once a second while the card plays; otherwise the clock stands. */
const useElapsed = (card: TWatchCardState): number => {
  const [now, setNow] = useState(() => Date.now());
  const playing = cardStatus(card) === 'playing';
  useEffect(() => {
    setNow(Date.now());
    if (!playing) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [playing, card]);
  return cardElapsed(card, now);
};

const Poster = memo(({ card, ended }: { card: TWatchCardState; ended: boolean }) => {
  const src = card.kind === 'youtube' && card.videoId ? youtubeThumbnailUrl(card.videoId) : null;
  return (
    <span
      className={cn(
        'relative flex aspect-video w-36 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-black/80 text-white/80',
        ended && 'opacity-60 grayscale'
      )}
      aria-hidden="true"
    >
      {src ? (
        <img src={src} alt="" className="absolute inset-0 h-full w-full object-cover" loading="lazy" />
      ) : (
        <MonitorPlay className="h-7 w-7" />
      )}
      {!ended && (
        <span className="relative flex h-8 w-8 items-center justify-center rounded-full bg-black/55 backdrop-blur-sm">
          <Play className="ml-0.5 h-4 w-4 fill-current" />
        </span>
      )}
    </span>
  );
});

const WatchCard = memo(({ channelId, messageId, card, date }: TWatchCardProps) => {
  const starter = useUserById(card.startedBy);
  const serverId = useActiveServerId();
  const status = cardStatus(card);
  const ended = status === 'ended';
  const elapsed = useElapsed(card);

  const watch = useCallback(() => {
    openWatch({ serverId, channelId, messageId, card });
  }, [serverId, channelId, messageId, card]);

  return (
    <div
      className={cn(
        'surface-soft my-1 flex w-full max-w-xl items-center gap-3 rounded-2xl bg-card p-3 ring-1 ring-white/[0.05]',
        ended && 'opacity-80'
      )}
      data-testid="watch-card"
      data-status={status}
    >
      <Poster card={card} ended={ended} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Tooltip content={format(date, fullDateTime())}>
          <span className="line-clamp-2 text-sm font-semibold leading-tight text-foreground">{card.title}</span>
        </Tooltip>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5 tabular-nums" data-testid="watch-card-status">
            {status === 'playing' && (
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full bg-sky-400 shadow-[0_0_6px_1px_rgba(56,189,248,0.6)]"
              />
            )}
            {status === 'playing' && `Playing ${formatPlaybackTime(elapsed)}`}
            {status === 'paused' && `Paused at ${formatPlaybackTime(elapsed)}`}
            {status === 'ended' && 'Ended'}
          </span>
          {!ended && card.viewers > 0 && <span>{card.viewers} watching</span>}
        </span>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <UserAvatar userId={card.startedBy} className="h-4 w-4" showStatusBadge={false} noDecoration />
          Started by {getDisplayName(starter)}
        </span>
      </div>
      <Button
        type="button"
        size="sm"
        onClick={watch}
        disabled={ended}
        className={cn('shrink-0', !ended && 'bg-sky-500 text-white hover:bg-sky-400')}
      >
        {ended ? 'Ended' : 'Watch'}
      </Button>
    </div>
  );
});

export { WatchCard };

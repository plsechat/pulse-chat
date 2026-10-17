import { WatchTogetherPlayer } from '@/components/channel-view/voice/watch-together-player';
import { UserAvatar } from '@/components/user-avatar';
import type { TWatchTarget } from '@/features/app/deck';
import { useChannelById } from '@/features/server/channels/hooks';
import { useUserById } from '@/features/server/users/hooks';
import {
  cardElapsed,
  cardMedia,
  cardStatus,
  formatPlaybackTime,
  WATCH_HEARTBEAT_MS,
  WATCH_TOGETHER_PLUGIN_ID,
  youtubeThumbnailUrl
} from '@/features/server/voice/watch-together';
import { getDisplayName } from '@/helpers/get-display-name';
import { getLocalStorageItem, LocalStorageKey, setLocalStorageItem } from '@/helpers/storage';
import { getTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import type { TWatchCard } from '@pulse/shared';
import { Volume2, VolumeX } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { useLiveWatchCard } from './use-live-watch-card';

/**
 * The synced player for a watch card, shared by the tab layout's side
 * panel and the traditional layout's dialog. The player is the room
 * player fed from the card instead of a stream; its controls go to the
 * card's channel. While the panel is open it tells the plugin so every
 * WATCH_HEARTBEAT_MS (and says goodbye on close): that is how the
 * viewer count on the card is kept and how a card nobody watches ends.
 * A viewer who may not run plugin commands is simply not counted; the
 * player works for them all the same.
 */

const DEFAULT_VOLUME = 80;

const readVolume = (): number => {
  const raw = Number(getLocalStorageItem(LocalStorageKey.WATCH_VOLUME));
  return Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : DEFAULT_VOLUME;
};

const reportPresence = (channelId: number, action: 'watching' | 'left') => {
  const trpc = getTRPCClient();
  if (!trpc) return;
  // Silent on purpose: a member without the command permission still watches.
  trpc.plugins.executeCommand
    .mutate({ pluginId: WATCH_TOGETHER_PLUGIN_ID, commandName: 'watch', args: { action, channelId } })
    .catch(() => {});
};

const usePresence = (channelId: number, live: boolean) => {
  useEffect(() => {
    if (!live) return;
    reportPresence(channelId, 'watching');
    const interval = window.setInterval(() => reportPresence(channelId, 'watching'), WATCH_HEARTBEAT_MS);
    return () => {
      window.clearInterval(interval);
      reportPresence(channelId, 'left');
    };
  }, [channelId, live]);
};

/** Ticks once a second while the card plays, so the elapsed time moves. */
const useElapsed = (card: TWatchCard): number => {
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

const StatusLine = memo(({ card }: { card: TWatchCard }) => {
  const elapsed = useElapsed(card);
  const status = cardStatus(card);
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums" data-testid="watch-panel-status">
      {status === 'playing' && (
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-sky-400 shadow-[0_0_6px_1px_rgba(56,189,248,0.6)]" />
      )}
      {status === 'playing' && `Playing ${formatPlaybackTime(elapsed)}`}
      {status === 'paused' && `Paused at ${formatPlaybackTime(elapsed)}`}
      {status === 'ended' && 'Ended'}
    </span>
  );
});

type TWatchPanelProps = { target: TWatchTarget };

const WatchPanel = memo(({ target }: TWatchPanelProps) => {
  const card = useLiveWatchCard(target);
  const channel = useChannelById(target.channelId);
  const starter = useUserById(card.startedBy);
  const status = cardStatus(card);
  const live = status !== 'ended';
  const [volume, setVolume] = useState(readVolume);
  const [lastAudible, setLastAudible] = useState(() => (readVolume() > 0 ? readVolume() : DEFAULT_VOLUME));

  usePresence(target.channelId, live);

  const changeVolume = useCallback((next: number) => {
    const clamped = Math.min(100, Math.max(0, Math.round(next)));
    setVolume(clamped);
    if (clamped > 0) setLastAudible(clamped);
    setLocalStorageItem(LocalStorageKey.WATCH_VOLUME, String(clamped));
  }, []);

  const toggleMute = useCallback(() => {
    changeVolume(volume > 0 ? 0 : lastAudible);
  }, [changeVolume, volume, lastAudible]);

  const poster = card.kind === 'youtube' && card.videoId ? youtubeThumbnailUrl(card.videoId) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3" data-testid="watch-panel">
      <div className="group relative aspect-video w-full shrink-0 overflow-hidden rounded-xl bg-black">
        {live ? (
          <WatchTogetherPlayer
            media={cardMedia(card)}
            volume={volume}
            pluginId={WATCH_TOGETHER_PLUGIN_ID}
            source={{ kind: 'card', channelId: target.channelId }}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            {poster && (
              <img src={poster} alt="" className="absolute inset-0 h-full w-full object-cover opacity-30 grayscale" />
            )}
            <span className="relative rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white/90">
              This watch has ended
            </span>
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="text-base font-semibold leading-tight text-foreground">{card.title}</h3>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <StatusLine card={card} />
          {live && card.viewers > 0 && (
            <span>
              {card.viewers} watching
            </span>
          )}
          {channel && <span>#{channel.name}</span>}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <UserAvatar userId={card.startedBy} className="h-4 w-4" showStatusBadge={false} noDecoration />
          <span>Started by {getDisplayName(starter)}</span>
        </div>
      </div>

      {live && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={toggleMute}
            aria-label={volume === 0 ? 'Unmute' : 'Mute'}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-accent hover:text-foreground"
          >
            {volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={volume}
            onChange={(e) => changeVolume(Number(e.target.value))}
            aria-label="Your volume"
            className={cn('h-1 flex-1 accent-sky-400')}
          />
          <span className="w-8 text-right tabular-nums">{volume}%</span>
        </label>
      )}
    </div>
  );
});

export { WatchPanel };

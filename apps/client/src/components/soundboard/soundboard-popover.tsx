import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@/components/ui/popover';
import Spinner from '@/components/ui/spinner';
import { useSoundboard } from '@/components/voice-provider/soundboard-store';
import {
  useCurrentVoiceChannelId,
  useCurrentVoiceKind
} from '@/features/server/channels/hooks';
import {
  filterSounds,
  loadFavouriteSoundIds,
  saveFavouriteSoundIds,
  sortSounds,
  toggleFavourite
} from '@/features/server/sounds/soundboard';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getVoiceTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import type { TJoinedServerSound } from '@pulse/server/types';
import { SOUND_USER_COOLDOWN_MS } from '@pulse/shared';
import { AudioLines, Search, Star } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

type TListing = {
  sounds: TJoinedServerSound[];
  canPlay: boolean;
};

type TSoundboardPopoverProps = {
  /** Button styling of the host bar (sidebar block vs phone strip). */
  buttonClassName?: string;
  side?: 'top' | 'bottom';
};

/**
 * The in-call soundboard: a button in the voice controls opening a grid
 * of the room's clips (emoji + name), favourites first, a tap plays.
 * The list is fetched from the session's server on every open (it is
 * small and the clips may have changed since), and the button only
 * exists in a server voice channel — DM calls have no soundboard.
 */
const SoundboardPopover = memo(
  ({ buttonClassName, side = 'top' }: TSoundboardPopoverProps) => {
    const channelId = useCurrentVoiceChannelId();
    const kind = useCurrentVoiceKind();
    const { playSound } = useSoundboard();

    const [open, setOpen] = useState(false);
    const [listing, setListing] = useState<TListing | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [favourites, setFavourites] = useState<Set<number>>(loadFavouriteSoundIds);
    // Local echo of the server's per-user cooldown so the grid tells the
    // user instead of letting them collect refusals.
    const [cooldownUntil, setCooldownUntil] = useState(0);
    const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
      if (!open) return;
      let cancelled = false;
      const trpc = getVoiceTRPCClient();
      if (!trpc) return;

      setError(null);
      trpc.voice.listSounds
        .query()
        .then((result) => {
          if (!cancelled) setListing(result);
        })
        .catch((err) => {
          if (!cancelled) setError(getTrpcError(err, 'Could not load the soundboard'));
        });

      return () => {
        cancelled = true;
      };
    }, [open, channelId]);

    useEffect(
      () => () => {
        if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
      },
      []
    );

    const visible = useMemo(() => {
      if (!listing) return [];
      return sortSounds(filterSounds(listing.sounds, query), favourites);
    }, [listing, query, favourites]);

    const handleToggleFavourite = useCallback((soundId: number) => {
      setFavourites((prev) => {
        const next = toggleFavourite(prev, soundId);
        saveFavouriteSoundIds(next);
        return next;
      });
    }, []);

    const handlePlay = useCallback(
      async (soundId: number) => {
        if (Date.now() < cooldownUntil) return;
        const ok = await playSound(soundId);
        if (!ok) return;
        const until = Date.now() + SOUND_USER_COOLDOWN_MS;
        setCooldownUntil(until);
        if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
        cooldownTimer.current = setTimeout(() => setCooldownUntil(0), SOUND_USER_COOLDOWN_MS);
      },
      [cooldownUntil, playSound]
    );

    if (!channelId || kind !== 'channel') return null;

    const coolingDown = cooldownUntil > Date.now();

    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'h-8 w-8 rounded-md transition-all duration-200',
              open
                ? 'bg-amber-500/15 text-amber-400'
                : 'bg-secondary hover:bg-secondary/80 text-muted-foreground hover:text-foreground',
              buttonClassName
            )}
            title="Soundboard"
            aria-label="Soundboard"
            data-testid="soundboard-button"
          >
            <AudioLines className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side={side}
          align="end"
          className="w-80 p-3"
          data-testid="soundboard-grid"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">Soundboard</span>
            {coolingDown && (
              <span className="text-[11px] text-muted-foreground">one moment…</span>
            )}
          </div>

          {error ? (
            <p className="text-sm text-destructive py-4">{error}</p>
          ) : !listing ? (
            <div className="flex justify-center py-6">
              <Spinner size="sm" />
            </div>
          ) : !listing.canPlay ? (
            <p className="text-sm text-muted-foreground py-4">
              You cannot use the soundboard in this community.
            </p>
          ) : listing.sounds.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              No sounds yet. A member with Manage sounds adds them under
              Server Settings → Sounds.
            </p>
          ) : (
            <>
              <div className="relative mb-2">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Find a sound"
                  className="h-8 pl-8 text-sm"
                  aria-label="Find a sound"
                />
              </div>
              <div className="grid grid-cols-3 gap-1.5 max-h-72 overflow-y-auto pr-0.5">
                {visible.map((sound) => {
                  const starred = favourites.has(sound.id);
                  return (
                    <div key={sound.id} className="relative group/sound">
                      <button
                        type="button"
                        onClick={() => void handlePlay(sound.id)}
                        disabled={coolingDown}
                        title={sound.name}
                        data-testid="soundboard-sound"
                        data-sound-id={sound.id}
                        className={cn(
                          'w-full h-16 rounded-md border border-border bg-card/60 hover:bg-accent/60 transition-colors',
                          'flex flex-col items-center justify-center gap-0.5 px-1 cursor-pointer',
                          'disabled:opacity-60 disabled:cursor-default'
                        )}
                      >
                        <span className="text-xl leading-none" aria-hidden>
                          {sound.emoji ?? '🔊'}
                        </span>
                        <span className="text-[11px] leading-tight truncate w-full text-center">
                          {sound.name}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggleFavourite(sound.id);
                        }}
                        title={starred ? 'Remove from favourites' : 'Add to favourites'}
                        aria-label={starred ? 'Remove from favourites' : 'Add to favourites'}
                        className={cn(
                          'absolute top-1 right-1 rounded p-0.5 transition-opacity cursor-pointer',
                          starred
                            ? 'text-amber-400 opacity-100'
                            : 'text-muted-foreground opacity-0 group-hover/sound:opacity-100 focus-visible:opacity-100'
                        )}
                      >
                        <Star className={cn('h-3 w-3', starred && 'fill-current')} />
                      </button>
                    </div>
                  );
                })}
                {visible.length === 0 && (
                  <p className="col-span-3 text-xs text-muted-foreground text-center py-4">
                    No sound matches.
                  </p>
                )}
              </div>
            </>
          )}
        </PopoverContent>
      </Popover>
    );
  }
);

export { SoundboardPopover };

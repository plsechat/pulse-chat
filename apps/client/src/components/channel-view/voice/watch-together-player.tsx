import { Button } from '@/components/ui/button';
import { applySinkId, useOutputSinkId } from '@/components/voice-provider/output-sink';
import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { useCan } from '@/features/server/hooks';
import { useOwnUserId } from '@/features/server/users/hooks';
import { useOwnVoiceState } from '@/features/server/voice/hooks';
import {
  decideSync,
  formatPlaybackTime,
  livePosition,
  needsCatchUp,
  youtubeVideoIdOf,
  type TSyncObservation
} from '@/features/server/voice/watch-together';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient, getVoiceTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import {
  loadYouTubeIframeApi,
  YOUTUBE_EMBED_HOST,
  YOUTUBE_PLAYER_STATE,
  type TYouTubePlayer,
  type TYouTubePlayerState
} from '@/lib/youtube-iframe-api';
import { Permission, type TExternalStreamMedia } from '@pulse/shared';
import { Pause, Play, Square } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

/**
 * Shared playback of a plugin stream's `media` descriptor. The room is
 * told WHAT plays and WHERE it is (position at `updatedAt`, playing or
 * not); this element plays it itself and keeps within a second of the
 * shared position, nudging its own clock when it drifts. The loop and
 * the controls talk to a small playback surface, so what sits under
 * them is interchangeable:
 *
 * - a `<video>` element for a file or an HLS playlist — Safari plays
 *   .m3u8 natively, elsewhere hls.js is loaded on demand (its own
 *   chunk, never on the critical path). Its audio goes through the
 *   call's output sink, follows the user's own stream volume and is
 *   silenced by deafening.
 * - YouTube's own embedded player for a `youtube` descriptor, driven
 *   through the IFrame Player API (loaded once, on demand): seekTo /
 *   playVideo / pauseVideo follow the room, setVolume follows the
 *   user's slider, mute follows deafening. A cross-origin iframe has
 *   no output-device selection, so that audio plays on the browser's
 *   default output.
 *
 * Controls (play / pause / seek / stop) belong to the host and the
 * room's moderators; they run the plugin's `watch` command, and the
 * plugin answers with one fan-out that moves everyone. Where the
 * command goes depends on the `source`: a voice room's stream sends it
 * on the voice session's connection; a text channel's watch card sends
 * it on the server's connection naming the card's channel, and the
 * fan-out is the card's MESSAGE_UPDATE. A browser that holds playback
 * until the page is touched gets the "Click to play" prompt, whichever
 * surface plays; a card viewer whose player trails the card gets
 * "Catch up" (the loop seats them anyway; the button is for a player
 * that cannot start on its own).
 */

const SYNC_INTERVAL_MS = 1_000;

/** How long the YouTube player may take to answer `playVideo` before it counts as held. */
const YOUTUBE_PLAY_WAIT_MS = 1_500;

/** What the sync loop and the controls need from whatever plays. */
type TPlaybackSurface = {
  observe: () => Omit<TSyncObservation, 'target' | 'wantPlaying'>;
  seek: (seconds: number) => void;
  /** Rejects when the browser holds playback (no user gesture yet). */
  play: () => Promise<void>;
  pause: () => void;
};

type TAttach = (surface: TPlaybackSurface | null) => void;

/** What the descriptor came from, which is where the controls go. */
export type TPlayerSource = { kind: 'room' } | { kind: 'card'; channelId: number };

const ROOM_SOURCE: TPlayerSource = { kind: 'room' };

type TWatchTogetherPlayerProps = {
  media: TExternalStreamMedia;
  /** 0–100, the user's own level for this stream. */
  volume: number;
  pluginId: string;
  /** Defaults to the voice room the viewer is in. */
  source?: TPlayerSource;
};

/** Ticks in a row the player must trail the card before "Catch up" shows. */
const CATCH_UP_TICKS = 2;

type TSurfaceProps = {
  media: TExternalStreamMedia;
  volume: number;
  muted: boolean;
  onAttach: TAttach;
};

/** A file or an HLS playlist in a `<video>` element. */
const VideoSurface = memo(({ media, volume, muted, onAttach }: TSurfaceProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<{ destroy: () => void } | null>(null);
  const sinkId = useOutputSinkId();

  // Source: set once per address; HLS through hls.js where the browser
  // does not speak it. Cleanup tears the hls instance down.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;

    const nativeHls =
      media.kind === 'hls' &&
      video.canPlayType('application/vnd.apple.mpegurl') !== '';

    if (media.kind === 'hls' && !nativeHls) {
      import('hls.js')
        .then(({ default: Hls }) => {
          if (cancelled || !Hls.isSupported()) {
            if (!cancelled) video.src = media.url;
            return;
          }
          const hls = new Hls({ enableWorker: true });
          hlsRef.current = hls;
          hls.loadSource(media.url);
          hls.attachMedia(video);
        })
        .catch(() => {
          if (!cancelled) video.src = media.url;
        });
    } else {
      video.src = media.url;
    }

    return () => {
      cancelled = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      video.removeAttribute('src');
      video.load();
    };
  }, [media.url, media.kind]);

  useEffect(() => {
    applySinkId(videoRef.current, sinkId);
  }, [sinkId]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = Math.min(1, Math.max(0, volume / 100));
    video.muted = muted;
  }, [volume, muted]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    onAttach({
      observe: () => ({
        currentTime: video.currentTime,
        playing: !video.paused && !video.ended,
        ended: video.ended,
        unstarted: false,
        duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null
      }),
      seek: (seconds) => {
        video.currentTime = seconds;
      },
      play: () => video.play(),
      pause: () => video.pause()
    });
    return () => onAttach(null);
  }, [onAttach]);

  return (
    <video
      ref={videoRef}
      playsInline
      preload="auto"
      className="absolute inset-0 w-full h-full object-contain"
    />
  );
});

VideoSurface.displayName = 'VideoSurface';

const isAdvancing = (state: TYouTubePlayerState) =>
  state === YOUTUBE_PLAYER_STATE.PLAYING || state === YOUTUBE_PLAYER_STATE.BUFFERING;

/** The player's error codes, in the viewer's words. */
const describeYoutubeError = (code: number): string => {
  switch (code) {
    case 100:
      return 'This video was removed or is private.';
    case 101:
    case 150:
      return 'The owner of this video does not allow it to be embedded.';
    default:
      return 'This video cannot be played here.';
  }
};

type TYouTubeSurfaceProps = TSurfaceProps & { videoId: string };

/**
 * YouTube's embedded player. The API replaces the element it is handed
 * with the iframe, so it gets a child of ours; the surface attaches on
 * `onReady`, when the player answers calls. The `start` position seats
 * the cued poster where the room is; later drift is the loop's job.
 */
const YouTubeSurface = memo(({ media, videoId, volume, muted, onAttach }: TYouTubeSurfaceProps) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<TYouTubePlayer | null>(null);
  const stateListeners = useRef(new Set<(state: TYouTubePlayerState) => void>());
  const level = useRef({ volume, muted });
  const initialStart = useRef(Math.floor(livePosition(media, Date.now())));
  const [failure, setFailure] = useState<string | null>(null);

  const applyLevel = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    // The embedded player treats volume 0 as its own mute and unMute()
    // brings the level back up, so a slider at 0 is a mute, and the
    // level is set only after unmuting.
    const silent = level.current.muted || level.current.volume <= 0;
    if (silent) {
      player.mute();
      return;
    }
    player.unMute();
    player.setVolume(Math.min(100, Math.max(1, level.current.volume)));
  }, []);

  useEffect(() => {
    level.current = { volume, muted };
    applyLevel();
  }, [volume, muted, applyLevel]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let player: TYouTubePlayer | null = null;
    const listeners = stateListeners.current;
    const mount = document.createElement('div');
    host.appendChild(mount);

    const waitForPlaying = () =>
      new Promise<void>((resolve, reject) => {
        const current = playerRef.current;
        if (current && isAdvancing(current.getPlayerState())) {
          resolve();
          return;
        }
        const timer = window.setTimeout(() => {
          listeners.delete(listener);
          reject(new Error('held'));
        }, YOUTUBE_PLAY_WAIT_MS);
        const listener = (state: TYouTubePlayerState) => {
          if (!isAdvancing(state)) return;
          window.clearTimeout(timer);
          listeners.delete(listener);
          resolve();
        };
        listeners.add(listener);
      });

    loadYouTubeIframeApi()
      .then((YT) => {
        if (cancelled) return;
        player = new YT.Player(mount, {
          videoId,
          width: '100%',
          height: '100%',
          host: YOUTUBE_EMBED_HOST,
          playerVars: {
            enablejsapi: 1,
            origin: window.location.origin,
            playsinline: 1,
            // The room's controls are ours; the player's own would let
            // one viewer wander off (the loop would pull them back).
            controls: 0,
            disablekb: 1,
            rel: 0,
            iv_load_policy: 3,
            fs: 0,
            start: initialStart.current
          },
          events: {
            onReady: ({ target }) => {
              if (cancelled) return;
              playerRef.current = target;
              applyLevel();
              onAttach({
                observe: () => {
                  const state = target.getPlayerState();
                  const duration = target.getDuration();
                  return {
                    currentTime: target.getCurrentTime() || 0,
                    playing: isAdvancing(state),
                    ended: state === YOUTUBE_PLAYER_STATE.ENDED,
                    unstarted:
                      state === YOUTUBE_PLAYER_STATE.UNSTARTED || state === YOUTUBE_PLAYER_STATE.CUED,
                    duration: Number.isFinite(duration) && duration > 0 ? duration : null
                  };
                },
                seek: (seconds) => target.seekTo(seconds, true),
                play: () => {
                  target.playVideo();
                  return waitForPlaying();
                },
                pause: () => target.pauseVideo()
              });
            },
            onStateChange: ({ data }) => {
              // Loading a video can reset the level; reassert it once sound runs.
              if (data === YOUTUBE_PLAYER_STATE.PLAYING) applyLevel();
              for (const listener of [...listeners]) listener(data);
            },
            onError: ({ data }) => {
              if (!cancelled) setFailure(describeYoutubeError(data));
            }
          }
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure(error instanceof Error ? error.message : 'The YouTube player could not be loaded');
      });

    return () => {
      cancelled = true;
      onAttach(null);
      playerRef.current = null;
      listeners.clear();
      player?.destroy();
      mount.remove();
    };
  }, [videoId, onAttach, applyLevel]);

  return (
    <>
      <div ref={hostRef} className="absolute inset-0 [&>iframe]:absolute [&>iframe]:inset-0 [&>iframe]:w-full [&>iframe]:h-full" />
      {failure && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/70 px-4 text-center text-sm text-white">
          {failure}
        </div>
      )}
    </>
  );
});

YouTubeSurface.displayName = 'YouTubeSurface';

const WatchTogetherPlayer = memo(
  ({ media, volume, pluginId, source = ROOM_SOURCE }: TWatchTogetherPlayerProps) => {
    const surfaceRef = useRef<TPlaybackSurface | null>(null);
    const mediaRef = useRef(media);
    const behindTicks = useRef(0);
    const ownVoiceState = useOwnVoiceState();
    const ownUserId = useOwnUserId();
    const can = useCan();
    const voiceChannelId = useCurrentVoiceChannelId();

    const [blocked, setBlocked] = useState(false);
    const [behind, setBehind] = useState(false);
    const [duration, setDuration] = useState<number | null>(null);
    const [shown, setShown] = useState(() => livePosition(media, Date.now()));
    const [busy, setBusy] = useState(false);

    const canControl =
      media.hostUserId === ownUserId || can(Permission.MANAGE_USERS);
    // A room's controls only work from inside the room; a card's work
    // from wherever the card is read.
    const inThisRoom = source.kind === 'card' || voiceChannelId !== undefined;
    const muted = ownVoiceState.soundMuted || ownVoiceState.serverDeafened;
    const videoId = youtubeVideoIdOf(media);

    useEffect(() => {
      mediaRef.current = media;
    }, [media]);

    const attach = useCallback<TAttach>((surface) => {
      surfaceRef.current = surface;
    }, []);

    const startPlayback = useCallback(() => {
      const surface = surfaceRef.current;
      if (!surface) return;
      surface.play().then(
        () => setBlocked(false),
        () => setBlocked(true)
      );
    }, []);

    /** The viewer asks to be seated where the card is and started. */
    const catchUp = useCallback(() => {
      const surface = surfaceRef.current;
      if (!surface) return;
      surface.seek(livePosition(mediaRef.current, Date.now()));
      if (mediaRef.current.playing) startPlayback();
      behindTicks.current = 0;
      setBehind(false);
    }, [startPlayback]);

    // The sync loop: follow the shared transport state, correct drift.
    // The surface may attach after the loop starts (the YouTube player
    // reports ready asynchronously); the loop simply picks it up then.
    useEffect(() => {
      const sync = () => {
        const current = mediaRef.current;
        const target = livePosition(current, Date.now());
        setShown(target);

        const surface = surfaceRef.current;
        if (!surface) return;

        const observed = surface.observe();
        if (observed.duration !== null) setDuration(observed.duration);

        // Trailing the card tick after tick means the loop's seek is
        // not taking (a player that cannot start without a gesture):
        // offer the viewer the catch-up button.
        if (source.kind === 'card' && current.playing && needsCatchUp(observed.currentTime, target)) {
          behindTicks.current += 1;
        } else {
          behindTicks.current = 0;
        }
        setBehind(behindTicks.current >= CATCH_UP_TICKS);

        const decision = decideSync({ ...observed, target, wantPlaying: current.playing });
        if (decision.seekTo !== undefined) surface.seek(decision.seekTo);
        if (decision.transport === 'play') startPlayback();
        else if (decision.transport === 'pause') surface.pause();
      };

      sync();
      const interval = window.setInterval(sync, SYNC_INTERVAL_MS);
      return () => window.clearInterval(interval);
    }, [media, startPlayback, source.kind]);

    const runControl = useCallback(
      async (action: 'play' | 'pause' | 'seek' | 'stop', position?: number) => {
        const trpc = source.kind === 'card' ? getTRPCClient() : getVoiceTRPCClient();
        if (!trpc || busy) return;
        setBusy(true);
        try {
          await trpc.plugins.executeCommand.mutate({
            pluginId,
            commandName: 'watch',
            args: {
              action,
              ...(position !== undefined ? { position } : {}),
              ...(source.kind === 'card' ? { channelId: source.channelId } : {})
            }
          });
        } catch (error) {
          toast.error(getTrpcError(error, 'Could not control playback'));
        } finally {
          setBusy(false);
        }
      },
      [pluginId, busy, source]
    );

    const seekMax = duration ?? Math.max(shown, 1);

    return (
      <div className="absolute inset-0 bg-black" data-testid="watch-together-player">
        {media.kind === 'youtube' ? (
          videoId ? (
            <YouTubeSurface
              key={videoId}
              media={media}
              videoId={videoId}
              volume={volume}
              muted={muted}
              onAttach={attach}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-white/80">
              This stream names no video to play.
            </div>
          )
        ) : (
          <VideoSurface media={media} volume={volume} muted={muted} onAttach={attach} />
        )}

        {blocked && (
          <button
            type="button"
            onClick={source.kind === 'card' ? catchUp : startPlayback}
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/60 text-white cursor-pointer"
          >
            <Play className="size-10" />
            <span className="text-sm">{source.kind === 'card' ? 'Catch up' : 'Click to play'}</span>
          </button>
        )}

        {!blocked && behind && (
          <button
            type="button"
            onClick={catchUp}
            data-testid="watch-catch-up"
            className="absolute right-2 top-2 z-10 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white backdrop-blur-sm hover:bg-black/75"
          >
            Catch up
          </button>
        )}

        <div
          className="absolute bottom-7 left-0 right-0 z-10 px-2 opacity-0 group-hover-or-touch:opacity-100 transition-opacity"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseMove={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 rounded-md bg-black/55 backdrop-blur-sm px-2 py-1">
            {canControl && inThisRoom ? (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-white hover:text-white hover:bg-white/15"
                  title={media.playing ? 'Pause for everyone' : 'Play for everyone'}
                  disabled={busy}
                  onClick={() =>
                    void runControl(
                      media.playing ? 'pause' : 'play',
                      surfaceRef.current?.observe().currentTime
                    )
                  }
                >
                  {media.playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-white hover:text-white hover:bg-white/15"
                  title="Stop for everyone"
                  disabled={busy}
                  onClick={() => void runControl('stop')}
                >
                  <Square className="size-3.5" />
                </Button>
              </>
            ) : (
              <span className="text-white/80">
                {media.playing ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
              </span>
            )}
            <span className="text-[11px] text-white tabular-nums">{formatPlaybackTime(shown)}</span>
            <input
              type="range"
              min={0}
              max={seekMax}
              step={1}
              value={Math.min(shown, seekMax)}
              disabled={!canControl || !inThisRoom || busy}
              aria-label="Position"
              className={cn(
                'flex-1 h-1 accent-sky-400',
                (!canControl || !inThisRoom) && 'opacity-70'
              )}
              onChange={(e) => void runControl('seek', Number(e.target.value))}
            />
            {duration !== null && (
              <span className="text-[11px] text-white/80 tabular-nums">{formatPlaybackTime(duration)}</span>
            )}
          </div>
        </div>
      </div>
    );
  }
);

WatchTogetherPlayer.displayName = 'WatchTogetherPlayer';

export { WatchTogetherPlayer };

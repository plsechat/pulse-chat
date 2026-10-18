import {
  pluginMessageData,
  type TExternalStreamMedia,
  type TMessageMetadata,
  type TWatchCard
} from '@pulse/shared';

/**
 * Shared-playback helpers for a plugin stream's `media` descriptor
 * (the watch-together plugin). The room is told the position at
 * `updatedAt` and whether it plays; each client derives the live
 * position itself, so late joiners and reconnects land in the right
 * place without a round trip.
 */

export const WATCH_TOGETHER_PLUGIN_ID = 'watch-together';

/** How far a client's own clock may wander before it is snapped back. */
export const WATCH_DRIFT_TOLERANCE_S = 1;

/**
 * How far before the end of the media the room must be for a player
 * that has ended to be started again. The room's position is the
 * server's clock read through the viewer's; a couple of seconds of
 * skew must not read as "the room went back" and replay the video
 * from the start.
 */
export const WATCH_END_SLACK_S = 3;

export const livePosition = (media: TExternalStreamMedia, now: number): number =>
  media.playing
    ? Math.max(0, media.position + (now - media.updatedAt) / 1000)
    : media.position;

/** Whether a player at `currentTime` must be re-seated on `target`. */
export const needsResync = (currentTime: number, target: number): boolean =>
  Math.abs(currentTime - target) > WATCH_DRIFT_TOLERANCE_S;

/** What the sync loop sees of a player, whatever plays underneath. */
export type TSyncObservation = {
  /** The player's own position, seconds. */
  currentTime: number;
  /** The player is advancing (or buffering to advance) right now. */
  playing: boolean;
  /** The player has run off the end of its media. */
  ended: boolean;
  /**
   * The player has not started yet — a cued poster. A seek there
   * would start playback, so while the room is paused it is left
   * alone; it is seated on the first play instead.
   */
  unstarted: boolean;
  /** The media length when known (null for a live stream). */
  duration: number | null;
  /**
   * How far the player can seek when the length is unknown — the live
   * edge of a stream. Null when the player does not know either.
   */
  seekableEnd: number | null;
  /** Where the room is right now. */
  target: number;
  /** Whether the room plays. */
  wantPlaying: boolean;
};

export type TSyncDecision = {
  seekTo?: number;
  transport?: 'play' | 'pause';
};

/**
 * Where this player's media ends, as far as it knows: its length, else
 * the live edge, else — for a player that has ended — where it stands,
 * which by definition is the end. Null while nothing is known.
 */
export const mediaEnd = (o: Pick<TSyncObservation, 'duration' | 'seekableEnd' | 'ended' | 'currentTime'>): number | null =>
  o.duration ?? o.seekableEnd ?? (o.ended ? o.currentTime : null);

/** The room's position clamped to what the media has: nobody is seated past the end. */
export const seatTarget = (target: number, end: number | null): number =>
  end === null ? target : Math.min(target, end);

/**
 * One tick of the sync loop as a pure decision: seat the player on the
 * room's position when it drifted, then match the room's transport.
 * The room's position keeps counting while it plays, so it runs past
 * the end of the media until the plugin hears that it ended: nothing
 * here seeks or starts a player past the end — a player that has
 * ended there stays ended (re-seating it would restart it every
 * second), one that stalled short of it is seated on the end at most
 * once, and the seek target is always within the media.
 */
export const decideSync = (o: TSyncObservation): TSyncDecision => {
  const decision: TSyncDecision = {};
  const end = mediaEnd(o);

  if (o.wantPlaying) {
    const roomAtTheEnd = end !== null && o.target >= end - WATCH_END_SLACK_S;
    if (o.ended && roomAtTheEnd) return decision;
    const goal = seatTarget(o.target, end);
    if (needsResync(o.currentTime, goal)) decision.seekTo = goal;
    if (!o.playing) decision.transport = 'play';
    return decision;
  }

  if (o.playing) decision.transport = 'pause';
  if (!o.unstarted && !o.ended && needsResync(o.currentTime, seatTarget(o.target, end))) {
    decision.seekTo = seatTarget(o.target, end);
  }
  return decision;
};

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The video a `youtube` descriptor names. The plugin sets `videoId`;
 * the canonical watch address it also sends is the fallback, so a
 * descriptor from a build that predates the field still plays.
 */
export const youtubeVideoIdOf = (media: Pick<TExternalStreamMedia, 'kind' | 'videoId' | 'url'>): string | null => {
  if (media.kind !== 'youtube') return null;
  if (media.videoId !== undefined && YOUTUBE_VIDEO_ID.test(media.videoId)) return media.videoId;
  try {
    const fromUrl = new URL(media.url).searchParams.get('v');
    return fromUrl !== null && YOUTUBE_VIDEO_ID.test(fromUrl) ? fromUrl : null;
  } catch {
    return null;
  }
};

/** m:ss, or h:mm:ss past the hour. */
export const formatPlaybackTime = (seconds: number): string => {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------------
// The watch card: the same session, carried on a text-channel message
// ---------------------------------------------------------------------------

/**
 * How often an open player tells the plugin it is still watched; the
 * plugin forgets a viewer after two and a half of these and ends a
 * card nobody has watched for ten minutes (packages/plugins/
 * watch-together/src/cards.ts keeps the matching HEARTBEAT_MS).
 */
export const WATCH_HEARTBEAT_MS = 60_000;

export type TWatchStatus = 'playing' | 'paused' | 'ended';

const MEDIA_KINDS = new Set(['file', 'hls', 'youtube']);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * The watch card a message carries, validated field by field: the
 * plugin writes it, but a future build or a hand-edited row must not
 * crash the channel. Null when the message is not a watch card.
 */
export const watchCardOf = (metadata: TMessageMetadata[] | null | undefined): TWatchCard | null => {
  const data = pluginMessageData(metadata, WATCH_TOGETHER_PLUGIN_ID);
  const raw = data?.watch;
  if (!raw || typeof raw !== 'object') return null;
  const card = raw as Record<string, unknown>;
  if (typeof card.kind !== 'string' || !MEDIA_KINDS.has(card.kind)) return null;
  if (typeof card.url !== 'string' || typeof card.title !== 'string') return null;
  if (!isFiniteNumber(card.startedBy) || typeof card.playing !== 'boolean') return null;
  if (!isFiniteNumber(card.position) || !isFiniteNumber(card.updatedAt)) return null;
  if (card.endedAt !== undefined && !isFiniteNumber(card.endedAt)) return null;
  return {
    kind: card.kind as TWatchCard['kind'],
    url: card.url,
    ...(typeof card.videoId === 'string' ? { videoId: card.videoId } : {}),
    title: card.title,
    startedBy: card.startedBy,
    playing: card.playing,
    position: card.position,
    updatedAt: card.updatedAt,
    viewers: isFiniteNumber(card.viewers) ? Math.max(0, Math.floor(card.viewers)) : 0,
    ...(card.endedAt !== undefined ? { endedAt: card.endedAt } : {})
  };
};

/** The card as the player's descriptor: an ended card is a paused one. */
export const cardMedia = (card: TWatchCard): TExternalStreamMedia => ({
  url: card.url,
  kind: card.kind,
  ...(card.videoId !== undefined ? { videoId: card.videoId } : {}),
  playing: card.playing && card.endedAt === undefined,
  position: card.position,
  updatedAt: card.updatedAt,
  hostUserId: card.startedBy
});

export const cardStatus = (card: TWatchCard): TWatchStatus =>
  card.endedAt !== undefined ? 'ended' : card.playing ? 'playing' : 'paused';

/** Where the card is now (seconds); frozen where it ended or paused. */
export const cardElapsed = (card: TWatchCard, now: number): number => livePosition(cardMedia(card), now);

/** The site's own default poster for a video; the card has no other image. */
export const youtubeThumbnailUrl = (videoId: string): string =>
  `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

/**
 * Whether a viewer's player trails the card by more than the tolerance
 * the sync loop uses: that is when the player offers "Catch up". Ahead
 * is never offered — the loop pulls it back on its own — and neither
 * is a player standing at the end of its media while the card's clock
 * has run past it: there is nothing left to catch up to.
 */
export const needsCatchUp = (currentTime: number, target: number, end: number | null = null): boolean =>
  seatTarget(target, end) - currentTime > WATCH_DRIFT_TOLERANCE_S;

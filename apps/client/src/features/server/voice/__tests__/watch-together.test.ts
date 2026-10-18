/**
 * The shared-playback math every watch-together card reproduces from
 * the stream's `media` descriptor.
 *
 * Run via:
 *   bun test apps/client/src/features/server/voice/__tests__/watch-together.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { TExternalStreamMedia } from '@pulse/shared';
import {
  cardElapsed,
  cardMedia,
  cardStatus,
  decideSync,
  formatPlaybackTime,
  livePosition,
  mediaEnd,
  needsCatchUp,
  needsResync,
  seatTarget,
  watchCardOf,
  youtubeThumbnailUrl,
  youtubeVideoIdOf,
  type TSyncObservation
} from '../watch-together';
import { pluginDataEntry, type TMessageMetadata, type TWatchCard } from '@pulse/shared';

const base: TExternalStreamMedia = {
  url: 'https://cdn.example.com/a.mp4',
  kind: 'file',
  playing: true,
  position: 30,
  updatedAt: 10_000,
  hostUserId: 1
};

describe('livePosition', () => {
  test('advances with wall time while playing', () => {
    expect(livePosition(base, 10_000)).toBe(30);
    expect(livePosition(base, 12_500)).toBe(32.5);
  });

  test('holds while paused', () => {
    expect(livePosition({ ...base, playing: false }, 99_000)).toBe(30);
  });

  test('never goes negative when the client clock trails the server', () => {
    expect(livePosition({ ...base, position: 0 }, 5_000)).toBe(0);
  });
});

describe('needsResync', () => {
  test('tolerates a second of drift, snaps beyond it', () => {
    expect(needsResync(30, 30.9)).toBe(false);
    expect(needsResync(30, 31.5)).toBe(true);
    expect(needsResync(33, 30)).toBe(true);
  });
});

const observed = (overrides: Partial<TSyncObservation> = {}): TSyncObservation => ({
  currentTime: 30,
  playing: true,
  ended: false,
  unstarted: false,
  duration: 300,
  seekableEnd: null,
  target: 30,
  wantPlaying: true,
  ...overrides
});

describe('decideSync', () => {
  test('in step and in the same transport state: nothing to do', () => {
    expect(decideSync(observed())).toEqual({});
    expect(decideSync(observed({ playing: false, wantPlaying: false }))).toEqual({});
    expect(decideSync(observed({ currentTime: 30.8 }))).toEqual({});
  });

  test('drift beyond a second is a seek; the transport follows the room', () => {
    expect(decideSync(observed({ currentTime: 25 }))).toEqual({ seekTo: 30 });
    expect(decideSync(observed({ playing: false }))).toEqual({ transport: 'play' });
    expect(decideSync(observed({ currentTime: 40, playing: false }))).toEqual({ seekTo: 30, transport: 'play' });
    expect(decideSync(observed({ wantPlaying: false }))).toEqual({ transport: 'pause' });
    expect(decideSync(observed({ wantPlaying: false, playing: false, currentTime: 10 }))).toEqual({ seekTo: 30 });
  });

  test('a cued player is not seeked while the room is paused (a seek would start it)', () => {
    expect(decideSync(observed({ wantPlaying: false, playing: false, unstarted: true, currentTime: 0 }))).toEqual({});
    // Once the room plays, it is seated and started.
    expect(decideSync(observed({ playing: false, unstarted: true, currentTime: 0 }))).toEqual({ seekTo: 30, transport: 'play' });
  });

  test('a player that ended while the room ran past the end stays ended', () => {
    expect(decideSync(observed({ ended: true, playing: false, currentTime: 300, target: 320 }))).toEqual({});
    expect(decideSync(observed({ ended: true, playing: false, currentTime: 300, target: 299.5 }))).toEqual({});
    // A couple of seconds of clock skew is not "the room went back".
    expect(decideSync(observed({ ended: true, playing: false, currentTime: 300, target: 297.5 }))).toEqual({});
    // The room went back: seek and play again.
    expect(decideSync(observed({ ended: true, playing: false, currentTime: 300, target: 120 }))).toEqual({ seekTo: 120, transport: 'play' });
    // Paused room, ended player: left alone.
    expect(decideSync(observed({ ended: true, playing: false, currentTime: 300, target: 120, wantPlaying: false }))).toEqual({});
  });

  test('an ended player with no known length is the end itself: never re-seated past where it stands', () => {
    // This was the loop: duration unknown → seek to 320 and play, every tick.
    expect(decideSync(observed({ ended: true, playing: false, currentTime: 300, target: 320, duration: null }))).toEqual({});
    // With a live edge known instead of a length, the same holds.
    expect(decideSync(observed({ ended: true, playing: false, currentTime: 300, target: 320, duration: null, seekableEnd: 300 }))).toEqual({});
    // The room clearly before the end still restarts it.
    expect(decideSync(observed({ ended: true, playing: false, currentTime: 300, target: 100, duration: null }))).toEqual({ seekTo: 100, transport: 'play' });
  });

  test('a player stalled short of the end is seated on the end at most once, never past it', () => {
    // Not ended, stalled at 299.5 with the room at 320: play on, no seek (the end is within tolerance).
    expect(decideSync(observed({ playing: false, currentTime: 299.5, target: 320 }))).toEqual({ transport: 'play' });
    // Stalled further back: one seek to the end, not to 320.
    expect(decideSync(observed({ playing: false, currentTime: 290, target: 320 }))).toEqual({ seekTo: 300, transport: 'play' });
    // Still playing the last second: nothing to do.
    expect(decideSync(observed({ currentTime: 299.6, target: 320 }))).toEqual({});
    // A live stream: the room's clock past the live edge seats the player on the edge.
    expect(decideSync(observed({ currentTime: 500, target: 620, duration: null, seekableEnd: 600 }))).toEqual({ seekTo: 600 });
    expect(decideSync(observed({ currentTime: 599.5, target: 620, duration: null, seekableEnd: 600 }))).toEqual({});
    // Paused room past the end: the seat is the end, not the room's figure.
    expect(decideSync(observed({ playing: false, wantPlaying: false, currentTime: 100, target: 320 }))).toEqual({ seekTo: 300 });
  });

  test('the ENDED edge: the first tick after the player ends does not start it again', () => {
    // The embedded player reports ENDED with the room's clock a hair short of the length (skew).
    expect(decideSync(observed({ ended: true, playing: false, currentTime: 212, duration: 212, target: 211.2 }))).toEqual({});
    // And exactly at it.
    expect(decideSync(observed({ ended: true, playing: false, currentTime: 212, duration: 212, target: 212 }))).toEqual({});
  });
});

describe('mediaEnd / seatTarget', () => {
  test('the length, else the live edge, else where an ended player stands', () => {
    expect(mediaEnd({ duration: 300, seekableEnd: 280, ended: false, currentTime: 10 })).toBe(300);
    expect(mediaEnd({ duration: null, seekableEnd: 280, ended: false, currentTime: 10 })).toBe(280);
    expect(mediaEnd({ duration: null, seekableEnd: null, ended: true, currentTime: 212 })).toBe(212);
    expect(mediaEnd({ duration: null, seekableEnd: null, ended: false, currentTime: 10 })).toBeNull();
    expect(seatTarget(320, 300)).toBe(300);
    expect(seatTarget(30, 300)).toBe(30);
    expect(seatTarget(320, null)).toBe(320);
  });
});

describe('youtubeVideoIdOf', () => {
  test('the descriptor id, else the canonical address, else nothing', () => {
    expect(youtubeVideoIdOf({ kind: 'youtube', videoId: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoIdOf({ kind: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoIdOf({ kind: 'youtube', videoId: 'bad', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoIdOf({ kind: 'youtube', url: 'https://www.youtube.com/watch?v=bad' })).toBeNull();
    expect(youtubeVideoIdOf({ kind: 'youtube', url: 'not a url' })).toBeNull();
    expect(youtubeVideoIdOf({ kind: 'file', videoId: 'dQw4w9WgXcQ', url: 'https://cdn.example.com/a.mp4' })).toBeNull();
  });
});

describe('formatPlaybackTime', () => {
  test('m:ss below the hour, h:mm:ss past it, junk as zero', () => {
    expect(formatPlaybackTime(0)).toBe('0:00');
    expect(formatPlaybackTime(65.9)).toBe('1:05');
    expect(formatPlaybackTime(3_725)).toBe('1:02:05');
    expect(formatPlaybackTime(-3)).toBe('0:00');
    expect(formatPlaybackTime(Number.NaN)).toBe('0:00');
  });
});

// ---------------------------------------------------------------------------
// The watch card
// ---------------------------------------------------------------------------

const card: TWatchCard = {
  kind: 'youtube',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  videoId: 'dQw4w9WgXcQ',
  title: 'Never Gonna Give You Up',
  startedBy: 7,
  playing: true,
  position: 30,
  updatedAt: 10_000,
  viewers: 2
};

const metadataWith = (watch: unknown, pluginId = 'watch-together'): TMessageMetadata[] => [
  { url: '', mediaType: 'webhook', title: 'Watch together', siteName: 'plugin', description: pluginId },
  pluginDataEntry(pluginId, { watch })
];

describe('watchCardOf', () => {
  test('reads the plugin-data entry next to the persona; nothing else is a card', () => {
    expect(watchCardOf(metadataWith(card))).toEqual(card);
    expect(watchCardOf(null)).toBeNull();
    expect(watchCardOf([])).toBeNull();
    expect(watchCardOf([{ url: 'https://x.example', mediaType: 'website', title: 'x' }])).toBeNull();
    expect(watchCardOf(metadataWith(card, 'another-plugin'))).toBeNull();
    expect(watchCardOf([pluginDataEntry('watch-together', { other: 1 })])).toBeNull();
  });

  test('validates every field and fills in what a sparse card lacks', () => {
    const { videoId: _videoId, viewers: _viewers, ...sparse } = card;
    expect(watchCardOf(metadataWith(sparse))).toEqual({ ...sparse, viewers: 0 });
    expect(watchCardOf(metadataWith({ ...card, endedAt: 12_000 }))).toMatchObject({ endedAt: 12_000 });
    expect(watchCardOf(metadataWith({ ...card, viewers: 2.9 }))).toMatchObject({ viewers: 2 });
    expect(watchCardOf(metadataWith({ ...card, viewers: 'many' }))).toMatchObject({ viewers: 0 });

    expect(watchCardOf(metadataWith({ ...card, kind: 'dvd' }))).toBeNull();
    expect(watchCardOf(metadataWith({ ...card, url: 4 }))).toBeNull();
    expect(watchCardOf(metadataWith({ ...card, title: undefined }))).toBeNull();
    expect(watchCardOf(metadataWith({ ...card, startedBy: '7' }))).toBeNull();
    expect(watchCardOf(metadataWith({ ...card, playing: 1 }))).toBeNull();
    expect(watchCardOf(metadataWith({ ...card, position: Number.NaN }))).toBeNull();
    expect(watchCardOf(metadataWith({ ...card, updatedAt: null }))).toBeNull();
    expect(watchCardOf(metadataWith({ ...card, endedAt: 'yesterday' }))).toBeNull();
    expect(watchCardOf(metadataWith('card'))).toBeNull();
    // A junk video id is dropped, so the url fallback decides.
    expect(watchCardOf(metadataWith({ ...card, videoId: 99 }))).toEqual({ ...card, videoId: undefined } as TWatchCard);
  });
});

describe('cardMedia / cardStatus / cardElapsed', () => {
  test('the card is the player descriptor with the starter as host; an ended card is paused', () => {
    expect(cardMedia(card)).toEqual({
      url: card.url,
      kind: 'youtube',
      videoId: 'dQw4w9WgXcQ',
      playing: true,
      position: 30,
      updatedAt: 10_000,
      hostUserId: 7
    });
    expect(cardMedia({ ...card, endedAt: 12_000 }).playing).toBe(false);
    expect(cardMedia({ ...card, kind: 'file', videoId: undefined })).not.toHaveProperty('videoId');
  });

  test('status and elapsed follow the card', () => {
    expect(cardStatus(card)).toBe('playing');
    expect(cardStatus({ ...card, playing: false })).toBe('paused');
    expect(cardStatus({ ...card, endedAt: 12_000 })).toBe('ended');
    expect(cardStatus({ ...card, playing: false, endedAt: 12_000 })).toBe('ended');

    expect(cardElapsed(card, 12_500)).toBe(32.5);
    expect(cardElapsed({ ...card, playing: false }, 99_000)).toBe(30);
    expect(cardElapsed({ ...card, endedAt: 12_000 }, 99_000)).toBe(30);
  });
});

describe('youtubeThumbnailUrl / needsCatchUp', () => {
  test('the poster comes from the known host; catch-up only when behind by more than the tolerance', () => {
    expect(youtubeThumbnailUrl('dQw4w9WgXcQ')).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    expect(needsCatchUp(30, 30.9)).toBe(false);
    expect(needsCatchUp(30, 31.5)).toBe(true);
    // Ahead of the card is the loop's business, never a button.
    expect(needsCatchUp(40, 30)).toBe(false);
    // Same rule as the loop's resync in the behind direction.
    expect(needsCatchUp(0, 5)).toBe(needsResync(0, 5));
    // At the end of the media with the card's clock past it: nothing to catch up to.
    expect(needsCatchUp(300, 320, 300)).toBe(false);
    expect(needsCatchUp(299.5, 320, 300)).toBe(false);
    // Short of the end it is still offered — to the end, not to the card's figure.
    expect(needsCatchUp(100, 320, 300)).toBe(true);
    expect(needsCatchUp(100, 320, null)).toBe(true);
  });
});

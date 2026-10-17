import type { TExternalStreamHandle, TExternalStreamMedia } from '@pulse/plugin-sdk';
import { describe, expect, test } from 'bun:test';
import { livePosition, SessionError, SessionManager } from '../sessions';

/**
 * The session manager with a hand-driven clock: lifecycle, who may
 * control, and the transport math every client reproduces.
 */

const build = () => {
  let now = 1_000_000;
  const created: Array<{ channelId: number; key: string; title: string; media: TExternalStreamMedia; updates: TExternalStreamMedia[]; removed: boolean }> = [];
  const logs: string[] = [];

  const manager = new SessionManager({
    createStream: (input) => {
      const record = { ...input, updates: [] as TExternalStreamMedia[], removed: false };
      created.push(record);
      const handle: TExternalStreamHandle = {
        streamId: created.length - 1,
        remove: () => {
          record.removed = true;
        },
        update: (u) => {
          if (u.media) record.updates.push(u.media);
        }
      };
      return handle;
    },
    now: () => now,
    log: (m) => logs.push(m)
  });

  return {
    manager,
    created,
    logs,
    tick: (ms: number) => {
      now += ms;
    },
    now: () => now
  };
};

const host = { userId: 7, canModerate: false };
const stranger = { userId: 8, canModerate: false };
const moderator = { userId: 9, canModerate: true };

const start = (h: ReturnType<typeof build>, channelId = 42) =>
  h.manager.start(
    { channelId, serverId: 1, userId: host.userId, url: 'https://x.example/a.mp4', kind: 'file', title: 'A' },
    host
  );

describe('SessionManager', () => {
  test('start creates one stream per room with a playing descriptor at position 0', () => {
    const h = build();
    const view = start(h);

    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ channelId: 42, key: 'watch:42', title: 'A' });
    expect(h.created[0]!.media).toEqual({
      url: 'https://x.example/a.mp4',
      kind: 'file',
      playing: true,
      position: 0,
      updatedAt: h.now(),
      hostUserId: 7
    });
    expect(view).toMatchObject({ channelId: 42, playing: true, position: 0, hostUserId: 7, title: 'A' });
    expect(h.manager.list()).toHaveLength(1);
  });

  test('a youtube session carries the video id on the descriptor and in every view', () => {
    const h = build();
    const view = h.manager.start(
      {
        channelId: 42,
        serverId: 1,
        userId: host.userId,
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        kind: 'youtube',
        videoId: 'dQw4w9WgXcQ',
        title: 'A song'
      },
      host
    );

    expect(h.created[0]!.media).toEqual({
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      kind: 'youtube',
      videoId: 'dQw4w9WgXcQ',
      playing: true,
      position: 0,
      updatedAt: h.now(),
      hostUserId: 7
    });
    expect(view).toMatchObject({ kind: 'youtube', videoId: 'dQw4w9WgXcQ', title: 'A song' });

    // Controls keep it: the same position math, the id along for the ride.
    h.tick(4_000);
    expect(h.manager.control(42, 'pause', host)).toMatchObject({ kind: 'youtube', videoId: 'dQw4w9WgXcQ', playing: false, position: 4 });
    expect(h.created[0]!.updates.at(-1)).toMatchObject({ kind: 'youtube', videoId: 'dQw4w9WgXcQ', playing: false, position: 4 });
    expect(h.manager.list()[0]).toMatchObject({ videoId: 'dQw4w9WgXcQ' });
  });

  test('pause freezes the live position; play resumes from it; seek moves it', () => {
    const h = build();
    start(h);

    h.tick(10_000);
    const paused = h.manager.control(42, 'pause', host);
    expect(paused).toMatchObject({ playing: false, position: 10 });
    expect(h.created[0]!.updates.at(-1)).toMatchObject({ playing: false, position: 10, updatedAt: h.now() });

    h.tick(5_000);
    // Paused: the position does not advance.
    expect(h.manager.list()[0]!.position).toBe(10);

    const played = h.manager.control(42, 'play', host);
    expect(played).toMatchObject({ playing: true, position: 10 });
    h.tick(2_500);
    expect(h.manager.list()[0]!.position).toBe(12.5);

    const sought = h.manager.control(42, 'seek', host, 90);
    expect(sought).toMatchObject({ playing: true, position: 90 });
    h.tick(1_000);
    expect(h.manager.list()[0]!.position).toBe(91);

    // play with an explicit position jumps there.
    expect(h.manager.control(42, 'play', host, 5)).toMatchObject({ playing: true, position: 5 });
    // Every control was one fan-out.
    expect(h.created[0]!.updates).toHaveLength(4);
  });

  test('positions are bounded and seek needs one', () => {
    const h = build();
    start(h);

    expect(() => h.manager.control(42, 'seek', host)).toThrow(SessionError);
    expect(() => h.manager.control(42, 'seek', host, Number.NaN)).toThrow('number of seconds');
    expect(h.manager.control(42, 'seek', host, -5)).toMatchObject({ position: 0 });
    expect(h.manager.control(42, 'seek', host, 10 ** 9)).toMatchObject({ position: 86_400 });
  });

  test('only the host or a moderator controls; a stranger cannot replace a session either', () => {
    const h = build();
    start(h);

    expect(() => h.manager.control(42, 'pause', stranger)).toThrow('Only the host or a moderator');
    expect(h.manager.control(42, 'pause', moderator)).toMatchObject({ playing: false });

    expect(() =>
      h.manager.start(
        { channelId: 42, serverId: 1, userId: stranger.userId, url: 'https://x.example/b.mp4', kind: 'file', title: 'B' },
        stranger
      )
    ).toThrow('Someone else is already playing');

    // A moderator (or the host) replaces it: the old stream is removed first.
    h.manager.start(
      { channelId: 42, serverId: 1, userId: moderator.userId, url: 'https://x.example/b.mp4', kind: 'file', title: 'B' },
      moderator
    );
    expect(h.created[0]!.removed).toBe(true);
    expect(h.created[1]).toMatchObject({ title: 'B' });
    expect(h.manager.list()).toHaveLength(1);
    expect(h.manager.list()[0]!.hostUserId).toBe(9);
  });

  test('stop removes the stream and is idempotent; a vanished runtime does not throw', () => {
    const h = build();
    start(h);

    expect(h.manager.control(42, 'stop', host)).toBeUndefined();
    expect(h.created[0]!.removed).toBe(true);
    expect(h.manager.list()).toHaveLength(0);
    expect(h.manager.stop(42)).toBe(false);
    expect(() => h.manager.control(42, 'pause', host)).toThrow('Nothing is playing');

    // A handle whose runtime is gone throws on remove; the session still ends.
    const g = build();
    start(g);
    const record = g.created[0]!;
    const original = g.manager.get(42)!.handle.remove;
    g.manager.get(42)!.handle.remove = () => {
      original();
      throw new Error('Voice runtime not found');
    };
    expect(g.manager.stop(42)).toBe(true);
    expect(record.removed).toBe(true);
    expect(g.logs.some((l) => l.includes('removal for channel 42 failed'))).toBe(true);
  });

  test('rooms are independent and endAll clears them', () => {
    const h = build();
    start(h, 1);
    start(h, 2);
    expect(h.manager.list().map((s) => s.channelId)).toEqual([1, 2]);

    h.manager.control(1, 'pause', host);
    expect(h.manager.list().find((s) => s.channelId === 2)!.playing).toBe(true);

    h.manager.endAll();
    expect(h.manager.list()).toHaveLength(0);
    expect(h.created.every((c) => c.removed)).toBe(true);
  });
});

describe('livePosition', () => {
  test('advances only while playing and never goes negative', () => {
    const base: TExternalStreamMedia = { url: 'u', kind: 'file', playing: true, position: 30, updatedAt: 1000, hostUserId: 1 };
    expect(livePosition(base, 1000)).toBe(30);
    expect(livePosition(base, 4000)).toBe(33);
    expect(livePosition({ ...base, playing: false }, 9000)).toBe(30);
    // A client whose clock is behind the server's sees no negative jump.
    expect(livePosition({ ...base, position: 0 }, 0)).toBe(0);
  });
});

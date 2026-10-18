import type { TWatchCard } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import {
  CardSessionManager,
  cardContent,
  cardLivePosition,
  EDIT_INTERVAL_MS,
  HEARTBEAT_MS,
  IDLE_MS,
  SWEEP_INTERVAL_MS,
  VIEWER_TTL_MS
} from '../cards';
import { SessionError } from '../sessions';

/**
 * Text-channel sessions with a hand-driven clock and scheduler: the
 * card is posted with the descriptor, controls edit it through the
 * one-a-second throttle (seeks coalesce), replacing and stopping mark
 * it ended, presence reports count viewers and nobody watching for ten
 * minutes ends the session, who may control, and unload.
 */

type TEdit = { messageId: number; content?: string; metadata: { watch: TWatchCard } };
type TTimer = { at: number; fn: () => void; cancelled: boolean };

const build = (options: { failEdits?: (edit: TEdit) => Error | undefined } = {}) => {
  let now = 1_000_000;
  const posts: Array<{ messageId: number; channelId: number; content: string; metadata: { watch: TWatchCard } }> = [];
  const edits: TEdit[] = [];
  const timers: TTimer[] = [];
  const logs: string[] = [];
  let nextMessageId = 500;

  const manager = new CardSessionManager({
    post: async (input) => {
      const messageId = nextMessageId++;
      posts.push({ messageId, ...input } as (typeof posts)[number]);
      return { messageId };
    },
    edit: async (input) => {
      const edit = input as TEdit;
      const failure = options.failEdits?.(edit);
      if (failure) throw failure;
      edits.push(edit);
    },
    isGone: (error) => error instanceof Error && error.message === 'gone',
    now: () => now,
    schedule: (fn, ms) => {
      const timer: TTimer = { at: now + ms, fn, cancelled: false };
      timers.push(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
        }
      };
    },
    log: (m) => logs.push(m)
  });

  /** Advance the clock, firing due timers in order (a fired timer may arm another). */
  const tick = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = timers
        .filter((t) => !t.cancelled && t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.cancelled = true;
      now = due.at;
      due.fn();
    }
    now = target;
  };

  const settle = () => new Promise((r) => setTimeout(r, 0));

  return { manager, posts, edits, timers, logs, tick, settle, now: () => now };
};

const host = { userId: 7, canModerate: false };
const stranger = { userId: 8, canModerate: false };
const moderator = { userId: 9, canModerate: true };

const start = (h: ReturnType<typeof build>, channelId = 12, userId = host.userId) =>
  h.manager.start(
    { channelId, serverId: 1, userId, url: 'https://x.example/a.mp4', kind: 'file', title: 'A' },
    { userId, canModerate: false }
  );

describe('cardLivePosition / cardContent', () => {
  test('the position advances while playing, holds while paused or ended', () => {
    const card: TWatchCard = { kind: 'file', url: 'u', title: 'A', startedBy: 7, playing: true, position: 30, updatedAt: 10_000, viewers: 0 };
    expect(cardLivePosition(card, 12_500)).toBe(32.5);
    expect(cardLivePosition({ ...card, playing: false }, 99_000)).toBe(30);
    expect(cardLivePosition({ ...card, endedAt: 11_000 }, 99_000)).toBe(30);
    expect(cardLivePosition({ ...card, position: 0 }, 5_000)).toBe(0);
    expect(cardContent(card)).toBe('Watching together: A');
    expect(cardContent({ ...card, endedAt: 1 })).toBe('Watched together: A');
  });
});

describe('CardSessionManager', () => {
  test('start posts one card per channel with a playing descriptor at position 0', async () => {
    const h = build();
    const view = await start(h);

    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toMatchObject({ channelId: 12, content: 'Watching together: A' });
    expect(h.posts[0]!.metadata.watch).toEqual({
      kind: 'file',
      url: 'https://x.example/a.mp4',
      title: 'A',
      startedBy: 7,
      playing: true,
      position: 0,
      updatedAt: h.now(),
      viewers: 0
    });
    expect(view).toMatchObject({ channelId: 12, messageId: 500, playing: true, position: 0, startedBy: 7, viewers: 0, title: 'A' });
    expect(h.manager.list()).toHaveLength(1);
    // A youtube card carries the id.
    const yt = await h.manager.start(
      { channelId: 13, serverId: 1, userId: 7, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', kind: 'youtube', videoId: 'dQw4w9WgXcQ', title: 'Y' },
      host
    );
    expect(yt).toMatchObject({ kind: 'youtube', videoId: 'dQw4w9WgXcQ' });
    expect(h.posts[1]!.metadata.watch).toMatchObject({ kind: 'youtube', videoId: 'dQw4w9WgXcQ' });
  });

  test('controls edit the card: the first lands at once, later ones within the second coalesce into one trailing edit', async () => {
    const h = build();
    await start(h);

    // Five seeks in 300 ms → one immediate edit, then one trailing edit with the final position.
    let lastSeekAt = 0;
    for (const position of [10, 20, 30, 40, 50]) {
      h.manager.control(12, 'seek', host, position);
      lastSeekAt = h.now();
      h.tick(60);
    }
    await h.settle();
    expect(h.edits).toHaveLength(1);
    expect(h.edits[0]!.metadata.watch).toMatchObject({ position: 10, playing: true });
    expect(h.edits[0]!.content).toBeUndefined();

    h.tick(EDIT_INTERVAL_MS);
    await h.settle();
    expect(h.edits).toHaveLength(2);
    expect(h.edits[1]!.metadata.watch).toMatchObject({ position: 50, playing: true, updatedAt: lastSeekAt });
    // The view already reflected the last seek before the edit went out.
    expect(h.manager.view(h.manager.get(12)!)).toMatchObject({ position: 50 + (h.now() - lastSeekAt) / 1000 });

    // A quiet second later a pause lands at once, with the live position.
    h.tick(EDIT_INTERVAL_MS);
    const paused = h.manager.control(12, 'pause', host);
    await h.settle();
    expect(paused).toMatchObject({ playing: false });
    expect(h.edits).toHaveLength(3);
    expect(h.edits[2]!.metadata.watch).toMatchObject({ playing: false, position: paused!.position });

    // Play from an explicit position.
    h.tick(EDIT_INTERVAL_MS);
    expect(h.manager.control(12, 'play', host, 100)).toMatchObject({ playing: true, position: 100 });
    expect(() => h.manager.control(12, 'seek', host)).toThrow(SessionError);
    expect(() => h.manager.control(12, 'seek', host, Number.NaN)).toThrow('must be a number');
  });

  test('a replace and a stop mark the card ended, bypassing the throttle', async () => {
    const h = build();
    await start(h);
    h.manager.control(12, 'seek', host, 10);
    h.manager.control(12, 'seek', host, 20); // pending behind the throttle
    await h.settle();
    expect(h.edits).toHaveLength(1);

    // Replace by the host: the old card ends now (its pending seek is superseded), a new card is posted.
    const replaced = await start(h, 12);
    await h.settle();
    expect(h.posts).toHaveLength(2);
    expect(replaced.messageId).toBe(501);
    expect(h.edits).toHaveLength(2);
    expect(h.edits[1]).toMatchObject({ messageId: 500, content: 'Watched together: A' });
    expect(h.edits[1]!.metadata.watch).toMatchObject({ playing: false, position: 20, endedAt: h.now(), viewers: 0 });
    // The old card's pending timer never fires an edit.
    h.tick(EDIT_INTERVAL_MS * 2);
    await h.settle();
    expect(h.edits).toHaveLength(2);
    expect(h.manager.list().map((v) => v.messageId)).toEqual([501]);

    // Stop by a moderator.
    expect(h.manager.control(12, 'stop', moderator)).toBeUndefined();
    await h.settle();
    expect(h.edits.at(-1)).toMatchObject({ messageId: 501, content: 'Watched together: A' });
    expect(h.edits.at(-1)!.metadata.watch.endedAt).toBe(h.now());
    expect(h.manager.list()).toHaveLength(0);
    expect(() => h.manager.control(12, 'pause', host)).toThrow('Nothing is playing in this channel.');
    expect(h.manager.end(12)).toBe(false);
  });

  test('a player reporting the end ends the card at the media length; a report from before the end is ignored', async () => {
    const h = build();
    await start(h);

    // The card is at 10 s: a 300 s media has not ended for this card — ignored.
    h.tick(10_000);
    expect(h.manager.ended(12, 300)).toMatchObject({ playing: true, position: 10 });
    await h.settle();
    expect(h.edits).toHaveLength(0);
    expect(h.manager.list()).toHaveLength(1);

    // The card's clock ran past the end; the first player to notice ends it AT the length, at once.
    h.tick(310_000);
    const view = h.manager.ended(12, 300);
    expect(view).toMatchObject({ playing: false, position: 300, endedAt: h.now() });
    await h.settle();
    expect(h.edits).toHaveLength(1);
    expect(h.edits[0]).toMatchObject({ messageId: 500, content: 'Watched together: A' });
    expect(h.edits[0]!.metadata.watch).toMatchObject({ playing: false, position: 300, endedAt: h.now(), viewers: 0 });
    expect(h.manager.list()).toHaveLength(0);
    // A second player's report finds nothing to end.
    expect(() => h.manager.ended(12, 300)).toThrow('Nothing is playing in this channel.');

    expect(() => h.manager.ended(12, 0)).toThrow('Nothing is playing in this channel.');
    await start(h, 13);
    expect(() => h.manager.ended(13, 0)).toThrow('positive number of seconds');
    expect(() => h.manager.ended(13, Number.NaN)).toThrow('must be a number');
  });

  test('who may control: the starter and moderators; a stranger is refused, including a replace', async () => {
    const h = build();
    await start(h);
    expect(() => h.manager.control(12, 'pause', stranger)).toThrow('Only the host or a moderator');
    await expect(start(h, 12, stranger.userId)).rejects.toThrow('Someone else is already playing something here');
    expect(h.manager.control(12, 'pause', moderator)).toMatchObject({ playing: false });
    expect(h.posts).toHaveLength(1);
  });

  test('presence: viewers are counted on the card, forgotten when they stop reporting, and nobody watching for ten minutes ends it', async () => {
    const h = build();
    await start(h);
    const session = h.manager.get(12)!;

    // Any member reports; only a changed count edits the card.
    expect(h.manager.presence(12, 'watching', 8)).toMatchObject({ viewers: 1 });
    await h.settle();
    expect(h.edits).toHaveLength(1);
    expect(h.edits[0]!.metadata.watch.viewers).toBe(1);
    h.tick(EDIT_INTERVAL_MS);
    expect(h.manager.presence(12, 'watching', 8)).toMatchObject({ viewers: 1 });
    expect(h.manager.presence(12, 'watching', 9)).toMatchObject({ viewers: 2 });
    await h.settle();
    expect(h.edits).toHaveLength(2);
    expect(h.edits[1]!.metadata.watch.viewers).toBe(2);

    // The sweep runs on its own timer while a session lives.
    expect(h.timers.some((t) => !t.cancelled && t.at === h.now() + SWEEP_INTERVAL_MS - EDIT_INTERVAL_MS)).toBe(true);

    // One keeps reporting, the other stops: after the TTL only one is counted.
    h.tick(HEARTBEAT_MS);
    h.manager.presence(12, 'watching', 8);
    h.tick(HEARTBEAT_MS);
    h.manager.presence(12, 'watching', 8);
    h.tick(VIEWER_TTL_MS - HEARTBEAT_MS);
    await h.settle();
    expect(session.viewers.size).toBe(1);
    expect(h.manager.view(session).viewers).toBe(1);
    expect(h.manager.list()).toHaveLength(1);

    // `left` drops a viewer at once.
    expect(h.manager.presence(12, 'left', 8)).toMatchObject({ viewers: 0 });

    // With nobody watching the idle clock runs from the last report;
    // the next sweep past the ten minutes ends it.
    h.tick(IDLE_MS - 1_000);
    expect(h.manager.list()).toHaveLength(1);
    h.tick(2 * SWEEP_INTERVAL_MS);
    await h.settle();
    expect(h.manager.list()).toHaveLength(0);
    expect(h.edits.at(-1)!.metadata.watch).toMatchObject({ endedAt: expect.any(Number), playing: false, viewers: 0 });
    expect(h.logs.some((l) => l.includes('Nobody has watched'))).toBe(true);
    // No sweep is left armed.
    expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(0);
  });

  test('a fresh card nobody opens ends after ten idle minutes; one that is watched does not', async () => {
    const h = build();
    await start(h, 1);
    await start(h, 2);
    h.manager.presence(2, 'watching', 8);
    h.tick(IDLE_MS / 2);
    h.manager.presence(2, 'watching', 8);
    h.tick(IDLE_MS / 2 + SWEEP_INTERVAL_MS);
    await h.settle();
    expect(h.manager.list().map((v) => v.channelId)).toEqual([2]);
    expect(h.edits.find((e) => e.messageId === 500)!.metadata.watch.endedAt).toBeDefined();
  });

  test('a card deleted under the session ends it quietly; other edit failures are logged and the session goes on', async () => {
    let gone = false;
    let flaky = false;
    const h = build({
      failEdits: () => (gone ? new Error('gone') : flaky ? new Error('boom') : undefined)
    });
    await start(h);

    flaky = true;
    h.manager.control(12, 'pause', host);
    await h.settle();
    expect(h.logs.some((l) => l.includes('Card edit for channel 12 failed'))).toBe(true);
    expect(h.manager.list()).toHaveLength(1);

    flaky = false;
    gone = true;
    h.tick(EDIT_INTERVAL_MS);
    h.manager.control(12, 'play', host);
    await h.settle();
    expect(h.manager.list()).toHaveLength(0);
    expect(h.logs.some((l) => l.includes('is gone'))).toBe(true);
  });

  test('endAll ends every card and resolves once the final edits landed', async () => {
    const h = build();
    await start(h, 1);
    await start(h, 2);
    await h.manager.endAll();
    expect(h.manager.list()).toHaveLength(0);
    expect(h.edits.map((e) => e.messageId).sort()).toEqual([500, 501]);
    expect(h.edits.every((e) => e.metadata.watch.endedAt !== undefined && e.content?.startsWith('Watched'))).toBe(true);
    expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(0);
  });
});

import { describe, expect, test } from 'bun:test';
import { getCards, getSessions, onLoad, onUnload } from '../index';
import { createFakeContext, invoker } from './harness';
import type { TWatchCard } from '@pulse/shared';

/**
 * The plugin entry through the fake SDK context: the command's start,
 * control and help paths, the probe (on and off), the HTTP routes and
 * the room-closed teardown.
 */

const MP4 = 'https://cdn.example.com/clips/intro.mp4';
const HLS = 'https://live.example.com/show/index.m3u8';
const VIDEO_ID = 'dQw4w9WgXcQ';
const WATCH = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const OEMBED = `https://www.youtube.com/oembed?url=${encodeURIComponent(WATCH)}&format=json`;

const loaded = async () => {
  const fake = createFakeContext();
  await onLoad(fake.ctx);
  return fake;
};

describe('/watch', () => {
  test('help when run without an address; refuses outside a voice channel', async () => {
    const fake = await loaded();
    try {
      expect(await fake.run(invoker(), {})).toMatch(/^Usage: \/watch play <link>/);
      await expect(fake.run(invoker({ currentVoiceChannelId: undefined }), { url: MP4 })).rejects.toThrow(
        'Run /watch in a text channel to post a card there, or join a voice channel'
      );
      await expect(fake.run(invoker({ currentVoiceChannelId: undefined }), { url: 'pause' })).rejects.toThrow(
        'Nothing is playing here'
      );
      expect(fake.streams).toHaveLength(0);
    } finally {
      await onUnload(fake.ctx);
    }
  });

  test('probes the address first and starts a playing session on a media answer', async () => {
    const fake = await loaded();
    try {
      fake.probes.set(MP4, { status: 206, contentType: 'video/mp4' });

      const view = await fake.run(invoker(), { url: MP4 });
      expect(view).toMatchObject({ channelId: 42, url: MP4, kind: 'file', playing: true, hostUserId: 7, title: 'intro' });

      expect(fake.fetches).toEqual([{ url: MP4, method: 'GET', headers: { Range: 'bytes=0-0' } }]);
      expect(fake.streams).toHaveLength(1);
      expect(fake.streams[0]).toMatchObject({ channelId: 42, key: 'watch:42', title: 'intro' });
      expect(fake.streams[0]!.media).toMatchObject({ url: MP4, kind: 'file', playing: true, position: 0, hostUserId: 7 });
    } finally {
      await onUnload(fake.ctx);
    }
  });

  test('the probe refuses dead links, pages and unreachable hosts in plain words', async () => {
    const fake = await loaded();
    try {
      fake.probes.set('https://cdn.example.com/missing.mp4', { status: 404, contentType: 'text/html' });
      await expect(fake.run(invoker(), { url: 'https://cdn.example.com/missing.mp4' })).rejects.toThrow(
        'answered 404'
      );

      fake.probes.set('https://cdn.example.com/page', { status: 200, contentType: 'text/html; charset=utf-8' });
      await expect(fake.run(invoker(), { url: 'https://cdn.example.com/page' })).rejects.toThrow(
        'serves text/html; charset=utf-8, not a media file'
      );

      fake.probes.set('https://down.example.com/a.mp4', new Error('fetch https://down.example.com/a.mp4 failed: DNS'));
      await expect(fake.run(invoker(), { url: 'https://down.example.com/a.mp4' })).rejects.toThrow(
        'Could not reach that address'
      );

      await expect(fake.run(invoker(), { url: 'https://vimeo.com/123456' })).rejects.toThrow('page with a player');
      await expect(fake.run(invoker(), { url: 'https://www.youtube.com/watch?v=abc' })).rejects.toThrow(
        'does not name a video'
      );
      expect(fake.streams).toHaveLength(0);
    } finally {
      await onUnload(fake.ctx);
    }
  });

  test('an HLS playlist is classified by its content type even when the extension is bare', async () => {
    const fake = await loaded();
    try {
      fake.probes.set('https://live.example.com/show', { status: 200, contentType: 'application/vnd.apple.mpegurl' });
      const view = await fake.run(invoker(), { url: 'https://live.example.com/show' });
      expect(view).toMatchObject({ kind: 'hls' });
    } finally {
      await onUnload(fake.ctx);
    }
  });

  test('a YouTube link starts a youtube session: no media probe, the oEmbed lookup names the card', async () => {
    const fake = await loaded();
    try {
      fake.probes.set(OEMBED, { status: 200, contentType: 'application/json', body: { title: '  Never Gonna Give You Up  ' } });

      const view = await fake.run(invoker(), { url: `https://youtu.be/${VIDEO_ID}?t=30` });
      expect(view).toMatchObject({
        channelId: 42,
        url: WATCH,
        kind: 'youtube',
        videoId: VIDEO_ID,
        playing: true,
        position: 0,
        hostUserId: 7,
        title: 'Never Gonna Give You Up'
      });

      // The only request is the oEmbed lookup — the video page itself is never fetched.
      expect(fake.fetches.map((f) => f.url)).toEqual([OEMBED]);
      expect(fake.streams[0]!.media).toMatchObject({ url: WATCH, kind: 'youtube', videoId: VIDEO_ID, playing: true, position: 0 });
      expect(fake.streams[0]!.title).toBe('Never Gonna Give You Up');

      // Controls are the same command as for a file.
      expect(await fake.run(invoker(), { action: 'seek', position: 61 })).toMatchObject({ kind: 'youtube', videoId: VIDEO_ID, position: 61 });
      expect(fake.streams[0]!.updates.at(-1)!.media).toMatchObject({ kind: 'youtube', videoId: VIDEO_ID, position: 61, playing: true });
    } finally {
      await onUnload(fake.ctx);
    }
  });

  test('the oEmbed lookup refuses an unavailable video and tolerates an unreachable site', async () => {
    const fake = await loaded();
    try {
      fake.probes.set(OEMBED, { status: 404, contentType: 'text/plain' });
      await expect(fake.run(invoker(), { url: WATCH })).rejects.toThrow('private, removed, or its owner does not allow embedding');
      fake.probes.set(OEMBED, { status: 401 });
      await expect(fake.run(invoker(), { url: `https://www.youtube.com/shorts/${VIDEO_ID}` })).rejects.toThrow('cannot be played here');
      expect(fake.streams).toHaveLength(0);

      // The server cannot reach the site: the room's browsers may, so it plays under the generic title.
      fake.probes.set(OEMBED, new Error(`fetch ${OEMBED} failed: DNS`));
      expect(await fake.run(invoker(), { url: WATCH })).toMatchObject({ kind: 'youtube', videoId: VIDEO_ID, title: 'YouTube video' });
      // A throttled or odd answer is not a refusal either.
      fake.probes.set(OEMBED, { status: 429 });
      expect(await fake.run(invoker(), { url: WATCH })).toMatchObject({ kind: 'youtube', title: 'YouTube video' });
      // A 200 without a title still plays.
      fake.probes.set(OEMBED, { status: 200, contentType: 'application/json', body: { author_name: 'x' } });
      expect(await fake.run(invoker(), { url: WATCH })).toMatchObject({ kind: 'youtube', title: 'YouTube video' });
      expect(fake.streams.filter((s) => !s.removed)).toHaveLength(1);
    } finally {
      await onUnload(fake.ctx);
    }
  });

  test('with verification off a YouTube link is not looked up at all', async () => {
    const fake = await loaded();
    try {
      fake.settings.verifyUrls = false;
      expect(await fake.run(invoker(), { url: `https://www.youtube-nocookie.com/embed/${VIDEO_ID}` })).toMatchObject({
        kind: 'youtube',
        videoId: VIDEO_ID,
        url: WATCH,
        title: 'YouTube video'
      });
      expect(fake.fetches).toHaveLength(0);
      expect((await fake.route('sessions', {})).body).toMatchObject({
        sessions: [{ channelId: 42, kind: 'youtube', videoId: VIDEO_ID, url: WATCH }]
      });
    } finally {
      await onUnload(fake.ctx);
    }
  });

  test('with verification off the extension decides and nothing is fetched', async () => {
    const fake = await loaded();
    try {
      fake.settings.verifyUrls = false;

      expect(await fake.run(invoker(), { url: HLS })).toMatchObject({ kind: 'hls' });
      expect(fake.fetches).toHaveLength(0);

      await expect(fake.run(invoker({ userId: 7 }), { url: 'https://cdn.example.com/stream' })).rejects.toThrow(
        'does not end in a media extension'
      );
    } finally {
      await onUnload(fake.ctx);
    }
  });

  test('controls: positional words from the composer and explicit args both work; others are refused', async () => {
    const fake = await loaded();
    try {
      fake.settings.verifyUrls = false;
      await fake.run(invoker(), { url: MP4 });

      // `/watch pause` → url slot holds the action.
      expect(await fake.run(invoker(), { url: 'pause' })).toMatchObject({ playing: false });
      // `/watch seek 90` → action slot holds the number.
      expect(await fake.run(invoker(), { url: 'seek', action: '90' })).toMatchObject({ position: 90 });
      // The card sends explicit args.
      expect(await fake.run(invoker(), { action: 'play', position: 100 })).toMatchObject({ playing: true, position: 100 });
      expect(await fake.run(invoker(), { url: 'status' })).toMatchObject({ playing: true });

      // Three fan-outs so far (pause, seek, play).
      expect(fake.streams[0]!.updates).toHaveLength(3);

      await expect(fake.run(invoker({ userId: 8 }), { url: 'pause' })).rejects.toThrow('Only the host or a moderator');
      expect(await fake.run(invoker({ userId: 9, canModerate: true }), { url: 'pause' })).toMatchObject({ playing: false });

      expect(await fake.run(invoker(), { action: 'stop' })).toBe('Stopped.');
      expect(fake.streams[0]!.removed).toBe(true);
      expect(await fake.run(invoker(), { url: 'status' })).toBe('Nothing is playing in this voice channel.');
      await expect(fake.run(invoker(), { url: 'pause' })).rejects.toThrow('Nothing is playing');
    } finally {
      await onUnload(fake.ctx);
    }
  });

  test('the declared sub-commands drive the same session: play <link> starts, play resumes, seek takes seconds', async () => {
    const fake = await loaded();
    try {
      fake.settings.verifyUrls = false;
      expect(fake.command).toMatchObject({ name: 'watch', description: 'Watch a video together — play, pause and seek in step' });
      // What the composer lists: the verbs, their arguments, the hidden presence reports.
      expect(fake.command!.subcommands!.map((s) => [s.name, s.hidden === true, (s.args ?? []).map((a) => a.name)])).toEqual([
        ['play', false, ['link']],
        ['pause', false, []],
        ['seek', false, ['seconds']],
        ['stop', false, []],
        ['status', false, []],
        ['watching', true, ['channel']],
        ['left', true, ['channel']]
      ]);
      expect(fake.command!.subcommands![0]!.args![0]!.placeholder).toBe('YouTube link, .mp4, .m3u8');

      // `/watch play <link>`
      const view = await fake.run(invoker({ subcommand: 'play' }), { link: ` ${MP4} ` });
      expect(view).toMatchObject({ channelId: 42, url: MP4, kind: 'file', playing: true, position: 0 });
      // `/watch pause`, `/watch seek 90`, `/watch play` (resume), `/watch status`, `/watch stop`
      expect(await fake.run(invoker({ subcommand: 'pause' }), {})).toMatchObject({ playing: false });
      expect(await fake.run(invoker({ subcommand: 'seek' }), { seconds: 90 })).toMatchObject({ position: 90, playing: false });
      expect(await fake.run(invoker({ subcommand: 'play' }), {})).toMatchObject({ playing: true, position: 90 });
      expect(await fake.run(invoker({ subcommand: 'status' }), {})).toMatchObject({ playing: true, hostUserId: 7 });
      // The card's buttons may send the structured form with the position they hold.
      expect(await fake.run(invoker({ subcommand: 'pause' }), { position: 12 })).toMatchObject({ playing: false, position: 12 });
      await expect(fake.run(invoker({ userId: 8, subcommand: 'pause' }), {})).rejects.toThrow('Only the host or a moderator');
      expect(await fake.run(invoker({ subcommand: 'stop' }), {})).toBe('Stopped.');
      expect(fake.streams[0]!.removed).toBe(true);
      // Presence through the hidden verbs is only for a card.
      await fake.run(invoker({ subcommand: 'play' }), { link: HLS });
      expect(await fake.run(invoker({ subcommand: 'watching' }), {})).toBe('Presence is only reported for a card.');
      // `/watch play` with nothing running is the old refusal, not a start.
      await fake.run(invoker({ subcommand: 'stop' }), {});
      await expect(fake.run(invoker({ subcommand: 'play' }), {})).rejects.toThrow('Nothing is playing');
    } finally {
      await onUnload(fake.ctx);
    }
  });

  test('HTTP routes list sessions and control them as a moderator; bodies are validated', async () => {
    const fake = await loaded();
    try {
      fake.settings.verifyUrls = false;
      await fake.run(invoker(), { url: MP4 });

      const list = await fake.route('sessions', {});
      expect(list.status).toBe(200);
      expect(list.body).toMatchObject({ sessions: [{ channelId: 42, url: MP4, playing: true }] });

      expect((await fake.route('control', { method: 'GET' })).status).toBe(405);
      expect((await fake.route('control', { method: 'POST', body: { action: 'pause' } })).status).toBe(400);
      expect((await fake.route('control', { method: 'POST', body: { channelId: 42, action: 'rewind' } })).status).toBe(400);
      expect((await fake.route('control', { method: 'POST', body: { channelId: 41, action: 'pause' } })).status).toBe(409);

      const paused = await fake.route('control', { method: 'POST', body: { channelId: 42, action: 'pause', position: 12 } });
      expect(paused.status).toBe(200);
      expect(paused.body).toMatchObject({ session: { playing: false, position: 12 } });

      const stopped = await fake.route('control', { method: 'POST', body: { channelId: 42, action: 'stop' } });
      expect(stopped.body).toEqual({ session: null });
      expect((await fake.route('sessions', {})).body).toEqual({ sessions: [], cards: [] });
    } finally {
      await onUnload(fake.ctx);
    }
  });

  test('the session ends when its room closes, and unload ends every session', async () => {
    const fake = await loaded();
    try {
      fake.settings.verifyUrls = false;
      await fake.run(invoker({ currentVoiceChannelId: 1 }), { url: MP4 });
      await fake.run(invoker({ currentVoiceChannelId: 2 }), { url: HLS });
      expect(getSessions()!.list()).toHaveLength(2);

      await fake.emit('voice:runtime_closed', { channelId: 1 });
      expect(getSessions()!.list().map((s) => s.channelId)).toEqual([2]);
      expect(fake.streams[0]!.removed).toBe(true);
      // An unrelated room closing changes nothing.
      await fake.emit('voice:runtime_closed', { channelId: 99 });
      expect(getSessions()!.list()).toHaveLength(1);
    } finally {
      await onUnload(fake.ctx);
    }
    expect(getSessions()).toBeNull();
    expect(fake.streams.every((s) => s.removed)).toBe(true);
  });
});

const settle = () => new Promise((r) => setTimeout(r, 0));
const cardOf = (fake: Awaited<ReturnType<typeof loaded>>, index = 0): TWatchCard =>
  (fake.messages[index]!.metadata as { watch: TWatchCard }).watch;

/** The composer of text channel 12 in server 1. */
const typed = (overrides: Parameters<typeof invoker>[0] = {}) =>
  invoker({ currentVoiceChannelId: undefined, channelId: 12, ...overrides });

describe('/watch from a text channel', () => {
  test('posts a watch card with the descriptor and answers with the channel; the text path wins over the voice room', async () => {
    const fake = await loaded();
    try {
      fake.settings.verifyUrls = false;
      fake.channels.push({
        id: 12, publicId: 'c12', serverId: 1, name: 'general', type: 'TEXT', categoryId: null,
        parentChannelId: null, topic: null, private: false, e2ee: false, archived: false, position: 0
      });

      // In a voice room AND typing into a text channel: the card wins.
      const reply = await fake.run(typed({ currentVoiceChannelId: 42 }), { url: MP4 });
      expect(reply).toBe('Playing in #general — press Watch on the card.');
      expect(fake.streams).toHaveLength(0);
      expect(fake.messages).toHaveLength(1);
      expect(fake.messages[0]).toMatchObject({
        channelId: 12,
        content: 'Watching together: intro',
        author: { name: 'Watch together' }
      });
      expect(cardOf(fake)).toEqual({
        kind: 'file',
        url: MP4,
        title: 'intro',
        startedBy: 7,
        playing: true,
        position: 0,
        updatedAt: expect.any(Number),
        viewers: 0
      });
      expect(getCards()!.list()).toMatchObject([{ channelId: 12, messageId: 100, serverId: 1 }]);
      expect(getSessions()!.list()).toHaveLength(0);

      // A YouTube link in another channel the lookup cannot name: a card under the generic title.
      expect(await fake.run(typed({ channelId: 13 }), { url: `https://youtu.be/${VIDEO_ID}` })).toBe(
        'Playing in this channel — press Watch on the card.'
      );
      expect(cardOf(fake, 1)).toMatchObject({ kind: 'youtube', videoId: VIDEO_ID, url: WATCH, title: 'YouTube video' });
    } finally {
      await onUnload(fake.ctx);
    }
  });

  test('controls typed in the channel and sent by the card edit the card; a stranger is refused; stop ends it', async () => {
    const fake = await loaded();
    try {
      fake.settings.verifyUrls = false;
      await fake.run(typed(), { url: MP4 });

      // `/watch pause` typed in the channel.
      expect(await fake.run(typed(), { url: 'pause' })).toMatch(/^Paused at 0:0\d\.$/);
      await settle();
      expect(fake.messages[0]!.edits).toHaveLength(1);
      expect(cardOf(fake)).toMatchObject({ playing: false });
      // Metadata-only: the text stays.
      expect(fake.messages[0]!.edits[0]!.content).toBeUndefined();
      expect(fake.messages[0]!.content).toBe('Watching together: intro');

      // The card's buttons name the channel instead (no composer).
      await new Promise((r) => setTimeout(r, 1_050));
      expect(await fake.run(invoker({ currentVoiceChannelId: undefined }), { action: 'seek', position: 90, channelId: 12 })).toBe('Jumped to 1:30.');
      await settle();
      expect(cardOf(fake)).toMatchObject({ playing: false, position: 90 });
      expect(await fake.run(invoker({ currentVoiceChannelId: undefined }), { url: 'status', channelId: 12 })).toMatchObject({
        channelId: 12, playing: false, position: 90, startedBy: 7
      });

      // A member who is in a voice room but presses the card's button still controls the card.
      await new Promise((r) => setTimeout(r, 1_050));
      expect(await fake.run(invoker({ currentVoiceChannelId: 42 }), { action: 'play', channelId: 12 })).toBe('Playing from 1:30.');
      expect(getSessions()!.list()).toHaveLength(0);

      // Strangers cannot control; moderators can.
      await expect(fake.run(typed({ userId: 8 }), { url: 'pause' })).rejects.toThrow('Only the host or a moderator');
      await expect(fake.run(invoker({ userId: 8, currentVoiceChannelId: undefined }), { action: 'pause', channelId: 12 })).rejects.toThrow('Only the host or a moderator');
      await new Promise((r) => setTimeout(r, 1_050));
      expect(await fake.run(typed({ userId: 9, canModerate: true }), { url: 'pause' })).toMatch(/^Paused at/);

      // A card named from another server is invisible; starting through a named channel is refused.
      await expect(fake.run(invoker({ activeServerId: 2, currentVoiceChannelId: undefined }), { action: 'pause', channelId: 12 })).rejects.toThrow('Nothing is playing in this channel.');
      expect(await fake.run(invoker({ activeServerId: 2, currentVoiceChannelId: undefined }), { url: 'status', channelId: 12 })).toBe('Nothing is playing in this channel.');
      await expect(fake.run(invoker({ currentVoiceChannelId: undefined }), { url: MP4, channelId: 12 })).rejects.toThrow('Start a watch from the channel');
      expect(fake.messages).toHaveLength(1);

      // Stop: the card reads ended, the text too.
      expect(await fake.run(typed(), { url: 'stop' })).toBe('Stopped.');
      await settle();
      expect(cardOf(fake)).toMatchObject({ playing: false, endedAt: expect.any(Number) });
      expect(fake.messages[0]!.content).toBe('Watched together: intro');
      expect(getCards()!.list()).toHaveLength(0);
      expect(await fake.run(typed(), { url: 'status' })).toBe('Nothing is playing in this channel.');
      await expect(fake.run(typed(), { url: 'pause' })).rejects.toThrow('Nothing is playing in this channel.');
    } finally {
      await onUnload(fake.ctx);
    }
  });

  test('a new address in the channel replaces the live card when its controller sends it', async () => {
    const fake = await loaded();
    try {
      fake.settings.verifyUrls = false;
      await fake.run(typed(), { url: MP4 });
      await expect(fake.run(typed({ userId: 8 }), { url: HLS })).rejects.toThrow('already playing something here');
      await fake.run(typed({ userId: 9, canModerate: true }), { url: HLS });
      await settle();
      expect(fake.messages).toHaveLength(2);
      expect(cardOf(fake, 0)).toMatchObject({ endedAt: expect.any(Number) });
      expect(cardOf(fake, 1)).toMatchObject({ kind: 'hls', startedBy: 9, playing: true });
      expect(getCards()!.list().map((c) => c.messageId)).toEqual([101]);
    } finally {
      await onUnload(fake.ctx);
    }
  });

  test('the declared sub-commands typed in the channel edit the card like the positional words', async () => {
    const fake = await loaded();
    try {
      fake.settings.verifyUrls = false;
      expect(await fake.run(typed({ subcommand: 'play' }), { link: MP4 })).toBe('Playing in this channel — press Watch on the card.');
      expect(fake.messages).toHaveLength(1);

      expect(await fake.run(typed({ subcommand: 'pause' }), {})).toMatch(/^Paused at 0:0\d\.$/);
      await settle();
      expect(cardOf(fake)).toMatchObject({ playing: false });

      await new Promise((r) => setTimeout(r, 1_050));
      expect(await fake.run(typed({ subcommand: 'seek' }), { seconds: 75 })).toBe('Jumped to 1:15.');
      await new Promise((r) => setTimeout(r, 1_050));
      expect(await fake.run(typed({ subcommand: 'play' }), {})).toBe('Playing from 1:15.');
      expect(await fake.run(typed({ subcommand: 'status' }), {})).toMatchObject({ channelId: 12, playing: true, position: 75 });

      // Presence as the hidden verbs, naming the channel (no composer).
      expect(await fake.run(invoker({ userId: 8, currentVoiceChannelId: undefined, subcommand: 'watching' }), { channel: 12 })).toMatchObject({ viewers: 1 });
      expect(await fake.run(invoker({ userId: 8, currentVoiceChannelId: undefined, subcommand: 'left' }), { channelId: 12 })).toMatchObject({ viewers: 0 });

      // `/watch play <link>` from elsewhere, naming the channel, may not start.
      await expect(fake.run(invoker({ currentVoiceChannelId: undefined, subcommand: 'play' }), { link: HLS, channelId: 12 })).rejects.toThrow(
        'Start a watch from the channel: type /watch play <link> in its composer.'
      );

      expect(await fake.run(typed({ subcommand: 'stop' }), {})).toBe('Stopped.');
      await settle();
      expect(cardOf(fake)).toMatchObject({ endedAt: expect.any(Number) });
    } finally {
      await onUnload(fake.ctx);
    }
  });

  test('viewers report presence through the command; the room path ignores it', async () => {
    const fake = await loaded();
    try {
      fake.settings.verifyUrls = false;
      await fake.run(typed(), { url: MP4 });
      // Any member, named channel, no control rights needed.
      expect(await fake.run(invoker({ userId: 8, currentVoiceChannelId: undefined }), { action: 'watching', channelId: 12 })).toMatchObject({ viewers: 1 });
      expect(await fake.run(invoker({ userId: 9, currentVoiceChannelId: undefined }), { action: 'watching', channelId: 12 })).toMatchObject({ viewers: 2 });
      await settle();
      expect(cardOf(fake)).toMatchObject({ viewers: 1 });
      expect(await fake.run(invoker({ userId: 8, currentVoiceChannelId: undefined }), { action: 'left', channelId: 12 })).toMatchObject({ viewers: 1 });

      await fake.run(invoker(), { url: MP4 });
      expect(await fake.run(invoker(), { url: 'watching' })).toBe('Presence is only reported for a card.');
    } finally {
      await onUnload(fake.ctx);
    }
  });

  test('a post the server refuses is reported in the command reply', async () => {
    const fake = await loaded();
    try {
      fake.settings.verifyUrls = false;
      const refusal = new Error('Plugins cannot post into end-to-end encrypted channels') as Error & { code: string };
      refusal.name = 'PluginActionError';
      refusal.code = 'BAD_REQUEST';
      fake.ctx.actions.messages.post = async () => {
        throw refusal;
      };
      await expect(fake.run(typed(), { url: MP4 })).rejects.toThrow(
        'The card could not be posted here: Plugins cannot post into end-to-end encrypted channels'
      );
      expect(getCards()!.list()).toHaveLength(0);
    } finally {
      await onUnload(fake.ctx);
    }
  });

  test('the HTTP routes list cards next to room sessions and control a card by its channel; unload ends every card', async () => {
    const fake = await loaded();
    try {
      fake.settings.verifyUrls = false;
      await fake.run(typed(), { url: MP4 });
      await fake.run(invoker(), { url: HLS });

      const list = await fake.route('sessions', {});
      expect(list.body).toMatchObject({
        sessions: [{ channelId: 42, kind: 'hls' }],
        cards: [{ channelId: 12, messageId: 100, kind: 'file', playing: true, viewers: 0 }]
      });

      const paused = await fake.route('control', { method: 'POST', body: { channelId: 12, action: 'pause', position: 7 } });
      expect(paused.status).toBe(200);
      expect(paused.body).toMatchObject({ card: { channelId: 12, playing: false, position: 7 } });
      expect((await fake.route('control', { method: 'POST', body: { channelId: 99, action: 'pause' } })).status).toBe(409);
    } finally {
      await onUnload(fake.ctx);
    }
    expect(getCards()).toBeNull();
    expect(cardOf(fake)).toMatchObject({ endedAt: expect.any(Number), playing: false });
    expect(fake.messages[0]!.content).toBe('Watched together: intro');
    expect(fake.streams.every((s) => s.removed)).toBe(true);
  });
});

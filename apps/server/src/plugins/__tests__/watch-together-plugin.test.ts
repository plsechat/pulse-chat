import type { TExternalStream } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import fs from 'node:fs/promises';
import path from 'path';
import {
  createEmptyTextChannel,
  createTestRole,
  grantTestUserRole,
  insertMemberUser,
  insertVoiceChannel,
  stageUserInVoice
} from '../../__tests__/fixtures';
import { firstSubscriptionEvent, initTest, waitUntil } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { messages, servers } from '../../db/schema';
import { pubsub } from '../../utils/pubsub';
import { ServerEvents, type TWatchCard } from '@pulse/shared';
import { spyOn, mock, afterEach } from 'bun:test';
import { PLUGINS_PATH } from '../../helpers/paths';
import { VoiceRuntime } from '../../runtimes/voice';
import { pluginManager } from '..';
import { pluginHttp } from '../http';
import { Permission } from '@pulse/shared';

/**
 * The official watch-together plugin, built from
 * packages/plugins/watch-together and loaded through the real loader
 * the way the image ships it. Address checking is switched off through
 * its setting (the test must not reach the network); the rest is the
 * real path: `/watch` as a member in a staged voice room → an external
 * stream with a `media` descriptor fanned out to the server's members,
 * controls as another fan-out, moderators vs strangers, the HTTP route
 * through the registry, a YouTube link replacing the session with a
 * `youtube` descriptor, and the room closing taking the session down.
 */

const PLUGIN_ID = 'watch-together';
const PACKAGE_DIR = path.resolve(process.cwd(), '..', '..', 'packages', 'plugins', PLUGIN_ID);
const MP4 = 'https://cdn.example.com/clips/intro.mp4';
const VIDEO_ID = 'dQw4w9WgXcQ';

const installRealPlugin = async () => {
  const dir = path.join(PLUGINS_PATH, PLUGIN_ID);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true });

  const built = await Bun.build({
    entrypoints: [path.join(PACKAGE_DIR, 'src', 'index.ts')],
    outdir: path.join(dir, 'dist'),
    target: 'bun',
    format: 'esm'
  });
  expect(built.success).toBe(true);

  await fs.copyFile(path.join(PACKAGE_DIR, 'package.json'), path.join(dir, 'package.json'));

  return async () => {
    await pluginManager.togglePlugin(PLUGIN_ID, false);
    await fs.rm(dir, { recursive: true, force: true });
  };
};

type TStreamEvent = { channelId: number; streamId: number; stream: TExternalStream };

describe('watch-together plugin through the real loader', () => {
  test('loads, starts a watch session from /watch, shares controls, ends with the room', async () => {
    const cleanup = await installRealPlugin();
    await getTestDb().update(servers).set({ enablePlugins: true }).where(eq(servers.id, 1));

    const channel = await insertVoiceChannel();
    const host = await insertMemberUser();
    const hostRole = await createTestRole({
      serverId: 1,
      name: 'Watchers',
      permissions: [Permission.JOIN_VOICE_CHANNELS, Permission.EXECUTE_PLUGIN_COMMANDS]
    });
    await grantTestUserRole(host.id, hostRole);
    const stranger = await insertMemberUser();
    await grantTestUserRole(stranger.id, hostRole);

    const runtime = stageUserInVoice(channel.id, host.id);
    runtime.addUser(stranger.id, { micMuted: false, soundMuted: false });

    try {
      const info = await pluginManager.getPluginInfo(PLUGIN_ID);
      expect(info.loadError).toBeUndefined();
      expect(info.enabled).toBe(false);

      await pluginManager.togglePlugin(PLUGIN_ID, true);
      expect(pluginManager.isPluginLoaded(PLUGIN_ID)).toBe(true);
      expect((await pluginManager.getPluginInfo(PLUGIN_ID)).loadError).toBeUndefined();
      expect(pluginManager.hasCommand(PLUGIN_ID, 'watch')).toBe(true);
      expect(pluginHttp.routeCount(PLUGIN_ID)).toBe(2);

      const settings = await pluginManager.getPluginSettings(PLUGIN_ID);
      expect(settings.values).toEqual({ verifyUrls: true });
      await pluginManager.updatePluginSetting(PLUGIN_ID, 'verifyUrls', false);

      const { caller: hostCaller, ctx: hostCtx } = await initTest(host.id);
      hostCtx.currentVoiceChannelId = channel.id;
      const { caller: strangerCaller, ctx: strangerCtx } = await initTest(stranger.id);
      strangerCtx.currentVoiceChannelId = channel.id;
      const { caller: owner } = await initTest(1);

      // Not in voice: the command says so (the loader rethrows the plugin's error).
      const { caller: idle } = await initTest(host.id);
      await expect(
        idle.plugins.executeCommand({ pluginId: PLUGIN_ID, commandName: 'watch', args: { url: MP4 } })
      ).rejects.toThrow('Run /watch in a text channel to post a card there, or join a voice channel');

      // Start: every server member learns of the stream and its media.
      const added = await firstSubscriptionEvent<TStreamEvent>(
        owner,
        'voice',
        'onAddExternalStream',
        () => hostCaller.plugins.executeCommand({ pluginId: PLUGIN_ID, commandName: 'watch', args: { url: MP4 } })
      );
      expect(added.channelId).toBe(channel.id);
      expect(added.stream).toMatchObject({
        pluginId: PLUGIN_ID,
        key: `watch:${channel.id}`,
        title: 'intro',
        tracks: { audio: false, video: false }
      });
      expect(added.stream.media).toMatchObject({ url: MP4, kind: 'file', playing: true, position: 0, hostUserId: host.id });

      // The room state carries it for late joiners.
      const streams = runtime.getState().externalStreams;
      expect(Object.values(streams)).toHaveLength(1);
      expect(Object.values(streams)[0]!.media?.url).toBe(MP4);
      expect(VoiceRuntime.getExternalStreamsMap(new Set([channel.id]))[channel.id]).toEqual(streams);

      // A stranger in the room cannot control it; the host can, and the
      // control is one VOICE_UPDATE_EXTERNAL_STREAM carrying the new descriptor.
      await expect(
        strangerCaller.plugins.executeCommand({ pluginId: PLUGIN_ID, commandName: 'watch', args: { url: 'pause' } })
      ).rejects.toThrow('Only the host or a moderator');

      const updated = await firstSubscriptionEvent<TStreamEvent>(
        owner,
        'voice',
        'onUpdateExternalStream',
        () =>
          hostCaller.plugins.executeCommand({
            pluginId: PLUGIN_ID,
            commandName: 'watch',
            args: { action: 'seek', position: 42 }
          })
      );
      expect(updated.streamId).toBe(added.streamId);
      expect(updated.stream.media).toMatchObject({ playing: true, position: 42, hostUserId: host.id });

      // The owner is a moderator (MANAGE_USERS) even without being in the room's host seat.
      const ownerInRoom = await initTest(1);
      ownerInRoom.ctx.currentVoiceChannelId = channel.id;
      const paused = await ownerInRoom.caller.plugins.executeCommand({
        pluginId: PLUGIN_ID,
        commandName: 'watch',
        args: { url: 'pause' }
      });
      expect(paused).toMatchObject({ playing: false });

      // The HTTP control route through the registry (the secret check is the mount's; see plugin-http.test).
      const control = pluginHttp.get(PLUGIN_ID, 'control')!;
      const answer = await control({
        method: 'POST',
        path: 'control',
        headers: {},
        query: {},
        body: { channelId: channel.id, action: 'play', position: 5 }
      });
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ session: { channelId: channel.id, playing: true, position: 5 } });
      expect(runtime.getState().externalStreams[added.streamId]!.media).toMatchObject({ playing: true, position: 5 });

      // A YouTube link from the host replaces the session: the old stream
      // goes, a new one arrives carrying the youtube descriptor (canonical
      // address + video id; no lookup with the check switched off), and
      // the same controls drive it.
      const replaced = await firstSubscriptionEvent<TStreamEvent>(
        owner,
        'voice',
        'onAddExternalStream',
        () =>
          hostCaller.plugins.executeCommand({
            pluginId: PLUGIN_ID,
            commandName: 'watch',
            args: { url: `https://youtu.be/${VIDEO_ID}?t=30` }
          })
      );
      expect(replaced.streamId).not.toBe(added.streamId);
      expect(replaced.stream).toMatchObject({ pluginId: PLUGIN_ID, key: `watch:${channel.id}`, title: 'YouTube video' });
      expect(replaced.stream.media).toEqual({
        url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
        kind: 'youtube',
        videoId: VIDEO_ID,
        playing: true,
        position: 0,
        updatedAt: expect.any(Number),
        hostUserId: host.id
      });
      expect(Object.keys(runtime.getState().externalStreams)).toEqual([String(replaced.streamId)]);

      const ytPaused = await firstSubscriptionEvent<TStreamEvent>(
        owner,
        'voice',
        'onUpdateExternalStream',
        () => hostCaller.plugins.executeCommand({ pluginId: PLUGIN_ID, commandName: 'watch', args: { action: 'pause', position: 12 } })
      );
      expect(ytPaused.streamId).toBe(replaced.streamId);
      expect(ytPaused.stream.media).toMatchObject({ kind: 'youtube', videoId: VIDEO_ID, playing: false, position: 12 });

      // The room closing (last member leaves → runtime destroyed) ends the session.
      const removed = await firstSubscriptionEvent<{ channelId: number; streamId: number }>(
        owner,
        'voice',
        'onRemoveExternalStream',
        () => runtime.destroy(),
        { timeoutMs: 3_000 }
      ).catch(() => undefined);
      // destroy() closes producers and emits voice:runtime_closed; the
      // plugin's remove() then finds no runtime (already deleted), so the
      // public fan-out may not fire — the session itself must be gone.
      const sessions = pluginHttp.get(PLUGIN_ID, 'sessions')!;
      const listing = await sessions({ method: 'GET', path: 'sessions', headers: {}, query: {}, body: null });
      expect(listing.body).toEqual({ sessions: [], cards: [] });
      expect(removed === undefined || removed.streamId === replaced.streamId).toBe(true);
      // The loader logs every refused command under the plugin; only the
      // two refusals this test provoked may be there.
      const errors = pluginManager.getLogs(PLUGIN_ID).filter((l) => l.type === 'error');
      expect(errors.map((l) => l.message)).toEqual([
        "Error executing command 'watch': Run /watch in a text channel to post a card there, or join a voice channel to play for the room.",
        "Error executing command 'watch': Only the host or a moderator can control playback."
      ]);

      await pluginManager.togglePlugin(PLUGIN_ID, false);
      expect(pluginManager.isPluginLoaded(PLUGIN_ID)).toBe(false);
      expect(pluginHttp.routeCount(PLUGIN_ID)).toBe(0);
      expect(pluginManager.hasCommand(PLUGIN_ID, 'watch')).toBe(false);
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
      await cleanup();
    }
  });
});

afterEach(() => {
  mock.restore();
});

/** The plugin's card on a message row, if it carries one. */
const cardOn = (metadata: { mediaType: string; pluginId?: string; data?: Record<string, unknown> }[] | null): TWatchCard | undefined =>
  metadata?.find((m) => m.mediaType === 'plugin-data' && m.pluginId === PLUGIN_ID)?.data?.watch as TWatchCard | undefined;

describe('watch-together plugin from a text channel', () => {
  test('/watch typed in a text channel posts a card; pause edits it; stop sets endedAt — all through the message fan-out', async () => {
    const cleanup = await installRealPlugin();
    const tdb = getTestDb();
    await tdb.update(servers).set({ enablePlugins: true }).where(eq(servers.id, 1));
    const channel = await createEmptyTextChannel('movie-night');

    const cardRows = async () => {
      const rows = await tdb.select().from(messages).where(eq(messages.channelId, channel.id));
      return rows.filter((row) => cardOn(row.metadata) !== undefined);
    };

    try {
      await pluginManager.togglePlugin(PLUGIN_ID, true);
      await pluginManager.updatePluginSetting(PLUGIN_ID, 'verifyUrls', false);
      const { caller: owner } = await initTest(1);
      // A viewer: may run plugin commands (presence goes through the
      // command), is nobody's moderator.
      const viewer = await insertMemberUser();
      const viewerRole = await createTestRole({
        serverId: 1,
        name: 'Viewers',
        permissions: [Permission.EXECUTE_PLUGIN_COMMANDS]
      });
      await grantTestUserRole(viewer.id, viewerRole);
      const { caller: member } = await initTest(viewer.id);
      const spy = spyOn(pubsub, 'publishFor');

      // The command message is posted at once; the card follows when the
      // command has run (the executor is fire-and-forget).
      const commandMessageId = await owner.messages.send({ channelId: channel.id, content: `/watch ${MP4}` });
      await waitUntil(async () => (await cardRows()).length === 1);
      const card = (await cardRows())[0]!;
      expect(card.content).toBe('Watching together: intro');
      expect(cardOn(card.metadata)).toEqual({
        kind: 'file',
        url: MP4,
        title: 'intro',
        startedBy: 1,
        playing: true,
        position: 0,
        updatedAt: expect.any(Number),
        viewers: 0
      });
      // Posted under the plugin's actor with its persona, not the owner.
      expect(card.userId).not.toBe(1);
      expect(card.metadata!.find((m) => m.mediaType === 'webhook')).toMatchObject({ title: 'Watch together' });
      // No room was touched.
      expect(spy.mock.calls.some(([, topic]) => topic === ServerEvents.VOICE_ADD_EXTERNAL_STREAM)).toBe(false);

      // The invoker's own command card names the channel.
      await waitUntil(async () => {
        const [row] = await tdb.select({ content: messages.content }).from(messages).where(eq(messages.id, commandMessageId));
        return row?.content?.includes('completed') === true;
      });
      const [commandRow] = await tdb.select({ content: messages.content }).from(messages).where(eq(messages.id, commandMessageId));
      expect(commandRow!.content).toContain('Playing in #movie-night');
      expect(commandRow!.content).toContain('press Watch on the card');

      // Pause from the composer: the card's metadata changes and goes out as MESSAGE_UPDATE.
      await owner.messages.send({ channelId: channel.id, content: '/watch pause' });
      await waitUntil(async () => cardOn((await cardRows())[0]!.metadata)?.playing === false);
      const paused = cardOn((await cardRows())[0]!.metadata)!;
      expect(paused).toMatchObject({ playing: false, position: expect.any(Number) });
      // The fan-out follows the row write; wait for it rather than racing it.
      const pausedUpdates = () =>
        spy.mock.calls.filter(
          ([, topic, payload]) =>
            topic === ServerEvents.MESSAGE_UPDATE &&
            (payload as { id: number }).id === card.id &&
            cardOn((payload as { metadata: typeof card.metadata }).metadata)?.playing === false
        );
      await waitUntil(() => pausedUpdates().length >= 1);
      const cardUpdates = pausedUpdates();
      expect(cardUpdates.length).toBeGreaterThanOrEqual(1);
      expect(cardUpdates[0]![0]).toEqual(expect.arrayContaining([1]));

      // A viewer pressing Watch reports presence through the command, naming the channel.
      const presence = await member.plugins.executeCommand({
        pluginId: PLUGIN_ID,
        commandName: 'watch',
        args: { action: 'watching', channelId: channel.id }
      });
      expect(presence).toMatchObject({ channelId: channel.id, viewers: 1 });
      // The declared (hidden) sub-command is the other spelling of the same report.
      expect(
        await member.plugins.executeCommand({
          pluginId: PLUGIN_ID,
          commandName: 'watch',
          subcommand: 'left',
          args: { channelId: channel.id }
        })
      ).toMatchObject({ channelId: channel.id, viewers: 0 });
      // The composer offers the verbs; the presence reports stay hidden.
      const listed = (await member.plugins.getCommands({ pluginId: PLUGIN_ID }))[PLUGIN_ID]!;
      expect(listed[0]!.subcommands!.map((s) => s.name)).toEqual(['play', 'pause', 'seek', 'stop', 'status']);
      // …but may not control it.
      await expect(
        member.plugins.executeCommand({ pluginId: PLUGIN_ID, commandName: 'watch', args: { action: 'play', channelId: channel.id } })
      ).rejects.toThrow('Only the host or a moderator');
      await expect(
        member.plugins.executeCommand({ pluginId: PLUGIN_ID, commandName: 'watch', subcommand: 'play', args: { channelId: channel.id } })
      ).rejects.toThrow('Only the host or a moderator');

      // `/watch seek 30` typed: the verb and its seconds, stored on the command row.
      const seekMessageId = await owner.messages.send({ channelId: channel.id, content: '/watch seek 30' });
      await waitUntil(async () => cardOn((await cardRows())[0]!.metadata)?.position === 30);
      await waitUntil(async () => {
        const [row] = await tdb.select({ content: messages.content }).from(messages).where(eq(messages.id, seekMessageId));
        return row?.content?.includes('completed') === true;
      });
      const [seekRow] = await tdb.select({ content: messages.content }).from(messages).where(eq(messages.id, seekMessageId));
      expect(seekRow!.content).toContain('data-command="watch" data-subcommand="seek"');
      expect(seekRow!.content).toContain('{"name":"seconds","value":"30","status":"completed"}');
      expect(seekRow!.content).toContain('Jumped to 0:30.');

      // Stop from the card's channel: ended, text and card alike; the session is gone.
      await owner.messages.send({ channelId: channel.id, content: '/watch stop' });
      await waitUntil(async () => cardOn((await cardRows())[0]!.metadata)?.endedAt !== undefined);
      const [ended] = await cardRows();
      expect(ended!.content).toBe('Watched together: intro');
      expect(cardOn(ended!.metadata)).toMatchObject({ playing: false, endedAt: expect.any(Number), viewers: 0 });
      const listing = await pluginHttp.get(PLUGIN_ID, 'sessions')!({ method: 'GET', path: 'sessions', headers: {}, query: {}, body: null });
      expect(listing.body).toEqual({ sessions: [], cards: [] });
      expect(await cardRows()).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});

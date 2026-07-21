import {
  ChannelType,
  STORAGE_MAX_FILE_SIZE,
  STORAGE_MIN_QUOTA_PER_USER,
  STORAGE_OVERFLOW_ACTION,
  STORAGE_QUOTA,
  VOICE_STREAM_PREVIEW_MAX_LENGTH,
  VOICE_STREAM_PREVIEW_PREFIX
} from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { channels, servers } from '../../db/schema';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { VoiceRuntime } from '../../runtimes/voice';

// Voice runtimes are pure in-memory state, so tests can stage an
// "in-voice" user by constructing a runtime directly (no mediasoup init
// needed — router creation only happens on real joins). Each test
// destroys the runtimes it creates: the module-level runtime map is NOT
// reset by the between-test TRUNCATE.

const validPreview = `${VOICE_STREAM_PREVIEW_PREFIX}dGVzdC1mcmFtZQ==`;

const insertVoiceChannel = async (serverId = 1) => {
  const [channel] = await db
    .insert(channels)
    .values({
      type: ChannelType.VOICE,
      name: `stream-preview-${randomUUIDv7()}`,
      fileAccessToken: randomUUIDv7(),
      fileAccessTokenUpdatedAt: Date.now(),
      position: 999,
      serverId,
      publicId: randomUUIDv7(),
      createdAt: Date.now()
    })
    .returning();
  return channel!;
};

const insertOtherServer = async () => {
  const [server] = await db
    .insert(servers)
    .values({
      name: 'Stream Preview Other Server',
      publicId: randomUUIDv7(),
      allowNewUsers: true,
      storageUploadEnabled: true,
      storageQuota: STORAGE_QUOTA,
      storageUploadMaxFileSize: STORAGE_MAX_FILE_SIZE,
      storageSpaceQuotaByUser: STORAGE_MIN_QUOTA_PER_USER,
      storageOverflowAction: STORAGE_OVERFLOW_ACTION,
      enablePlugins: false,
      createdAt: Date.now()
    })
    .returning();
  return server!;
};

const stageUserInVoice = (channelId: number, userId: number) => {
  const runtime = new VoiceRuntime(channelId);
  runtime.addUser(userId, { micMuted: false, soundMuted: false });
  return runtime;
};

describe('voice.updateStreamPreview', () => {
  test('refused when not in voice or not sharing', async () => {
    const { caller, ctx } = await initTest();
    const channel = await insertVoiceChannel();
    const runtime = stageUserInVoice(channel.id, 1);

    try {
      // Connection never joined voice
      await expect(
        caller.voice.updateStreamPreview({ preview: validPreview })
      ).rejects.toThrow('User is not in a voice channel');

      // In voice but not sharing
      ctx.currentVoiceChannelId = channel.id;
      await expect(
        caller.voice.updateStreamPreview({ preview: validPreview })
      ).rejects.toThrow('User is not sharing their screen');

      expect(runtime.getStreamPreview(1)).toBeNull();
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('oversized payload is refused', async () => {
    const { caller, ctx } = await initTest();
    const channel = await insertVoiceChannel();
    const runtime = stageUserInVoice(channel.id, 1);
    runtime.updateUserState(1, { sharingScreen: true });
    ctx.currentVoiceChannelId = channel.id;

    try {
      const oversized =
        VOICE_STREAM_PREVIEW_PREFIX +
        'A'.repeat(VOICE_STREAM_PREVIEW_MAX_LENGTH);

      await expect(
        caller.voice.updateStreamPreview({ preview: oversized })
      ).rejects.toThrow();

      expect(runtime.getStreamPreview(1)).toBeNull();
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });
});

describe('voice.getStreamPreview', () => {
  test('permitted member reads the stored preview; missing users return null', async () => {
    const { caller: sharer, ctx } = await initTest();
    const channel = await insertVoiceChannel();
    const runtime = stageUserInVoice(channel.id, 1);
    runtime.updateUserState(1, { sharingScreen: true });
    ctx.currentVoiceChannelId = channel.id;

    try {
      await sharer.voice.updateStreamPreview({ preview: validPreview });

      const { caller: viewer } = await initTest(2);
      const result = await viewer.voice.getStreamPreview({
        channelId: channel.id,
        userId: 1
      });
      expect(result.preview).toBe(validPreview);

      // A user without a stored preview yields null, not an error
      const empty = await viewer.voice.getStreamPreview({
        channelId: channel.id,
        userId: 2
      });
      expect(empty.preview).toBeNull();
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('requires VIEW_CHANNEL (cross-server channel is refused)', async () => {
    const otherServer = await insertOtherServer();
    const foreignChannel = await insertVoiceChannel(otherServer.id);
    const runtime = stageUserInVoice(foreignChannel.id, 1);
    runtime.updateUserState(1, { sharingScreen: true });
    runtime.setStreamPreview(1, validPreview);

    try {
      // Caller's active server is 1 — the foreign channel is out of
      // scope. channelProcedure reports it identically to a nonexistent
      // channel (no cross-server existence oracle).
      const { caller } = await initTest(2);
      await expect(
        caller.voice.getStreamPreview({
          channelId: foreignChannel.id,
          userId: 1
        })
      ).rejects.toThrow('Channel not found');
    } finally {
      await VoiceRuntime.findById(foreignChannel.id)?.destroy();
    }
  });

  test('refused for a preview (read-only) session', async () => {
    const { caller: owner } = await initTest();
    const target = await owner.servers.create({ name: 'Preview Stream' });
    await getTestDb()
      .update(servers)
      .set({ discoverable: true })
      .where(eq(servers.id, target.id));
    const voiceChannel = await insertVoiceChannel(target.id);
    const runtime = stageUserInVoice(voiceChannel.id, 1);
    runtime.updateUserState(1, { sharingScreen: true });
    runtime.setStreamPreview(1, validPreview);

    try {
      const { caller: previewer } = await initTest(2);
      await previewer.servers.preview({ serverId: target.id });

      // channelProcedure scopes to ACTIVE membership, so a preview
      // session is refused as out-of-scope (same shape as nonexistent)
      // before any preview-specific carve-out could apply.
      await expect(
        previewer.voice.getStreamPreview({
          channelId: voiceChannel.id,
          userId: 1
        })
      ).rejects.toThrow('Channel not found');
    } finally {
      await VoiceRuntime.findById(voiceChannel.id)?.destroy();
    }
  });

  test('preview is cleared when sharing stops', async () => {
    const { caller: sharer, ctx } = await initTest();
    const channel = await insertVoiceChannel();
    const runtime = stageUserInVoice(channel.id, 1);
    runtime.updateUserState(1, { sharingScreen: true });
    ctx.currentVoiceChannelId = channel.id;

    try {
      await sharer.voice.updateStreamPreview({ preview: validPreview });
      expect(runtime.getStreamPreview(1)).toBe(validPreview);

      // Stopping the share (via the real route) drops the thumbnail
      await sharer.voice.updateState({ sharingScreen: false });
      expect(runtime.getStreamPreview(1)).toBeNull();

      const { caller: viewer } = await initTest(2);
      const afterStop = await viewer.voice.getStreamPreview({
        channelId: channel.id,
        userId: 1
      });
      expect(afterStop.preview).toBeNull();
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('a preview older than the stale window reads as null', async () => {
    const channel = await insertVoiceChannel();
    const runtime = stageUserInVoice(channel.id, 1);
    runtime.updateUserState(1, { sharingScreen: true });
    // Set up the viewer BEFORE skewing the clock — initTest touches the db
    const { caller: viewer } = await initTest(2);

    runtime.setStreamPreview(1, validPreview);

    const originalNow = Date.now;
    try {
      const stored = originalNow();
      // getStreamPreview compares against Date.now(); jump it 46s ahead
      Date.now = () => stored + 46_000;
      expect(runtime.getStreamPreview(1)).toBeNull();

      const result = await viewer.voice.getStreamPreview({
        channelId: channel.id,
        userId: 1
      });
      expect(result.preview).toBeNull();
    } finally {
      Date.now = originalNow;
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('no runtime for the channel returns null', async () => {
    const channel = await insertVoiceChannel();
    const { caller } = await initTest(2);

    const result = await caller.voice.getStreamPreview({
      channelId: channel.id,
      userId: 1
    });
    expect(result.preview).toBeNull();
  });
});

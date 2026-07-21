import {
  ChannelType,
  STORAGE_MAX_FILE_SIZE,
  STORAGE_MIN_QUOTA_PER_USER,
  STORAGE_OVERFLOW_ACTION,
  STORAGE_QUOTA
} from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { describe, expect, test } from 'bun:test';
import { db } from '../../db';
import { channels, serverMembers, servers, users } from '../../db/schema';
import { initTest } from '../../__tests__/helpers';
import { VoiceRuntime } from '../../runtimes/voice';

// Voice runtimes are pure in-memory state, so tests can stage an
// "in-voice" user by constructing a runtime directly (no mediasoup init
// needed — router creation only happens on real joins). Each test
// destroys the runtimes it creates: the module-level runtime map is NOT
// reset by the between-test TRUNCATE.

const insertVoiceChannel = async (serverId = 1) => {
  const [channel] = await db
    .insert(channels)
    .values({
      type: ChannelType.VOICE,
      name: `voice-mod-${randomUUIDv7()}`,
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

const insertMemberUser = async () => {
  const suffix = randomUUIDv7();
  const [user] = await db
    .insert(users)
    .values({
      supabaseId: `voice-mod-supa-${suffix}`,
      name: `VoiceModUser-${suffix.slice(0, 8)}`,
      publicId: `voice-mod-pid-${suffix}`,
      createdAt: Date.now()
    })
    .returning();

  await db.insert(serverMembers).values({
    userId: user!.id,
    serverId: 1,
    nickname: null,
    joinedAt: Date.now()
  });

  return user!;
};

const insertOtherServer = async () => {
  const [server] = await db
    .insert(servers)
    .values({
      name: 'Voice Mod Other Server',
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

describe('voice.disconnectUser', () => {
  test('moderator disconnects a user from a voice channel of the active server', async () => {
    const { caller } = await initTest(); // user 1 = owner (MANAGE_USERS)
    const target = await insertMemberUser();
    const channel = await insertVoiceChannel();
    stageUserInVoice(channel.id, target.id);

    try {
      expect(VoiceRuntime.findRuntimeByUserId(target.id)?.id).toBe(channel.id);

      await caller.voice.disconnectUser({ userId: target.id });

      expect(VoiceRuntime.findRuntimeByUserId(target.id)).toBeUndefined();
      // The emptied runtime is destroyed to free mediasoup resources.
      expect(VoiceRuntime.findById(channel.id)).toBeUndefined();
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('requires MANAGE_USERS', async () => {
    const actor = await insertMemberUser();
    const target = await insertMemberUser();
    const channel = await insertVoiceChannel();
    stageUserInVoice(channel.id, target.id);

    try {
      const { caller } = await initTest(actor.id);

      await expect(
        caller.voice.disconnectUser({ userId: target.id })
      ).rejects.toThrow('Insufficient permissions');

      // Target is untouched.
      expect(VoiceRuntime.findRuntimeByUserId(target.id)?.id).toBe(channel.id);
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('rejects a target not in any voice channel', async () => {
    const { caller } = await initTest();
    const target = await insertMemberUser();

    await expect(
      caller.voice.disconnectUser({ userId: target.id })
    ).rejects.toThrow('User is not in a voice channel');
  });

  test('rejects disconnecting yourself', async () => {
    const { caller } = await initTest();

    await expect(
      caller.voice.disconnectUser({ userId: 1 })
    ).rejects.toThrow('Use leave to disconnect yourself');
  });

  test('cannot reach a voice channel of another server (cross-server scope)', async () => {
    const { caller } = await initTest(); // active server = 1
    const target = await insertMemberUser();
    const otherServer = await insertOtherServer();
    const foreignChannel = await insertVoiceChannel(otherServer.id);
    stageUserInVoice(foreignChannel.id, target.id);

    try {
      // Same opaque message as not-in-voice — no cross-server probing.
      await expect(
        caller.voice.disconnectUser({ userId: target.id })
      ).rejects.toThrow('User is not in a voice channel');

      expect(VoiceRuntime.findRuntimeByUserId(target.id)?.id).toBe(
        foreignChannel.id
      );
    } finally {
      await VoiceRuntime.findById(foreignChannel.id)?.destroy();
    }
  });
});

describe('voice.moderateMember (server mute / deafen)', () => {
  test('moderator server-mutes and unmutes a member', async () => {
    const { caller } = await initTest();
    const target = await insertMemberUser();
    const channel = await insertVoiceChannel();
    stageUserInVoice(channel.id, target.id);

    try {
      await caller.voice.moderateMember({
        userId: target.id,
        serverMuted: true
      });
      expect(
        VoiceRuntime.findById(channel.id)?.getUserState(target.id).serverMuted
      ).toBe(true);

      await caller.voice.moderateMember({
        userId: target.id,
        serverMuted: false
      });
      expect(
        VoiceRuntime.findById(channel.id)?.getUserState(target.id).serverMuted
      ).toBe(false);
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('server-deafen sets the flag independently of mute', async () => {
    const { caller } = await initTest();
    const target = await insertMemberUser();
    const channel = await insertVoiceChannel();
    stageUserInVoice(channel.id, target.id);

    try {
      await caller.voice.moderateMember({
        userId: target.id,
        serverDeafened: true
      });
      const state = VoiceRuntime.findById(channel.id)?.getUserState(target.id);
      expect(state?.serverDeafened).toBe(true);
      expect(state?.serverMuted).toBe(false);
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('requires MANAGE_USERS', async () => {
    const actor = await insertMemberUser();
    const target = await insertMemberUser();
    const channel = await insertVoiceChannel();
    stageUserInVoice(channel.id, target.id);

    try {
      const { caller } = await initTest(actor.id);
      await expect(
        caller.voice.moderateMember({ userId: target.id, serverMuted: true })
      ).rejects.toThrow('Insufficient permissions');
      expect(
        VoiceRuntime.findById(channel.id)?.getUserState(target.id).serverMuted
      ).toBe(false);
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('cannot moderate a member in another server (cross-server scope)', async () => {
    const { caller } = await initTest();
    const target = await insertMemberUser();
    const otherServer = await insertOtherServer();
    const foreignChannel = await insertVoiceChannel(otherServer.id);
    stageUserInVoice(foreignChannel.id, target.id);

    try {
      await expect(
        caller.voice.moderateMember({ userId: target.id, serverMuted: true })
      ).rejects.toThrow('User is not in a voice channel');
    } finally {
      await VoiceRuntime.findById(foreignChannel.id)?.destroy();
    }
  });

  test('refused on a connection with no active server (serverProcedure gate)', async () => {
    const { caller, ctx } = await initTest();
    const target = await insertMemberUser();
    const channel = await insertVoiceChannel();
    stageUserInVoice(channel.id, target.id);

    try {
      // A connection that never joined a server (e.g. home/DM-only)
      // must be refused by the builder before any permission logic.
      ctx.activeServerId = undefined;
      await expect(
        caller.voice.moderateMember({ userId: target.id, serverMuted: true })
      ).rejects.toThrow('No active server');
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });
});

describe('voice.leave runtime fallback', () => {
  test('leave removes a stale session when the connection context has no channel', async () => {
    // Simulates the post-refresh state: the user's old session is still
    // in the runtime, but the NEW connection never joined voice, so
    // ctx.currentVoiceChannelId is undefined. Before the fix this threw
    // 'User is not in a voice channel' and the user could never leave.
    const { caller } = await initTest();
    const channel = await insertVoiceChannel();
    stageUserInVoice(channel.id, 1);

    try {
      await caller.voice.leave();

      expect(VoiceRuntime.findRuntimeByUserId(1)).toBeUndefined();
      expect(VoiceRuntime.findById(channel.id)).toBeUndefined();
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('leave still rejects when the user is in no runtime at all', async () => {
    const { caller } = await initTest();

    await expect(caller.voice.leave()).rejects.toThrow(
      'User is not in a voice channel'
    );
  });
});



import { Permission, StreamKind } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'bun:test';
import {
  createTestRole,
  grantTestUserRole,
  insertMemberUser,
  insertOtherServer,
  insertVoiceChannel,
  stageUserInVoice
} from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { serverMembers, users } from '../../db/schema';
import { VoiceRuntime } from '../../runtimes/voice';

// A browser-shaped opus producer: what mediasoup-client sends on the
// first `produce` after the mic starts. Accepted by the router's opus
// codec regardless of DTLS state (the transport need not be connected).
const OPUS_RTP_PARAMETERS = {
  codecs: [
    { mimeType: 'audio/opus', payloadType: 100, clockRate: 48000, channels: 2 }
  ],
  encodings: [{ ssrc: 31_000_001 }],
  rtcp: { cname: 'moderation-test', reducedSize: true }
};

/** A plain member (seeded user 2) holding a MANAGE_USERS role. */
const grantManageUsers = async (userId: number) => {
  const roleId = await createTestRole({
    serverId: 1,
    name: 'Mods',
    permissions: [Permission.MANAGE_USERS]
  });
  await grantTestUserRole(userId, roleId);
};

// Voice runtimes are pure in-memory state, so tests can stage an
// "in-voice" user by constructing a runtime directly (no mediasoup init
// needed — router creation only happens on real joins). Each test
// destroys the runtimes it creates: the module-level runtime map is NOT
// reset by the between-test TRUNCATE.

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

describe('owner protection — the server owner is never a moderation target', () => {
  // MANAGE_USERS is delegated by the owner; a delegate who could silence,
  // disconnect, kick or ban the owner would own the server in practice.
  // One assertion (assertModerationTarget) backs all four actions.
  test('moderateMember refuses the owner', async () => {
    await grantManageUsers(2);
    const { caller: mod } = await initTest(2);
    const channel = await insertVoiceChannel();
    stageUserInVoice(channel.id, 1);

    try {
      await expect(
        mod.voice.moderateMember({ userId: 1, serverMuted: true })
      ).rejects.toThrow('The server owner cannot be moderated');
      expect(
        VoiceRuntime.findById(channel.id)?.getUserState(1).serverMuted
      ).toBe(false);
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('disconnectUser refuses the owner', async () => {
    await grantManageUsers(2);
    const { caller: mod } = await initTest(2);
    const channel = await insertVoiceChannel();
    stageUserInVoice(channel.id, 1);

    try {
      await expect(mod.voice.disconnectUser({ userId: 1 })).rejects.toThrow(
        'The server owner cannot be moderated'
      );
      expect(VoiceRuntime.findRuntimeByUserId(1)?.id).toBe(channel.id);
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('kick and ban refuse the owner (shared core)', async () => {
    await grantManageUsers(2);
    const { caller: mod } = await initTest(2);

    await expect(mod.users.kick({ userId: 1 })).rejects.toThrow(
      'The server owner cannot be moderated'
    );
    await expect(mod.users.ban({ userId: 1 })).rejects.toThrow(
      'The server owner cannot be moderated'
    );

    const tdb = getTestDb();
    const [membership] = await tdb
      .select()
      .from(serverMembers)
      .where(eq(serverMembers.userId, 1));
    expect(membership?.serverId).toBe(1);
    const [owner] = await tdb.select().from(users).where(eq(users.id, 1));
    expect(owner?.banned).toBe(false);
  });

  test('a regular member is still a valid target', async () => {
    await grantManageUsers(2);
    const { caller: mod } = await initTest(2);
    const channel = await insertVoiceChannel();
    stageUserInVoice(channel.id, 3);

    try {
      await mod.voice.moderateMember({ userId: 3, serverMuted: true });
      expect(
        VoiceRuntime.findById(channel.id)?.getUserState(3).serverMuted
      ).toBe(true);
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });
});

describe('moderation overrides survive leave/rejoin and are enforced at the SFU', () => {
  test('server-mute persists across leave → rejoin and pauses the producer created afterwards', async () => {
    const { caller: owner } = await initTest(1);
    const channel = await insertVoiceChannel();
    const first = await initTest(2);

    try {
      await first.caller.voice.join({ channelId: channel.id, state: {} });
      await owner.voice.moderateMember({ userId: 2, serverMuted: true });

      // Keep the room alive while user 2 is out, so the override lives
      // in a runtime that still exists (joined via the route: staging a
      // runtime by hand would replace the live one under the same key).
      const bystander = await initTest(3);
      await bystander.caller.voice.join({ channelId: channel.id, state: {} });

      await first.caller.voice.leave();
      expect(VoiceRuntime.findById(channel.id)?.getUser(2)).toBeUndefined();

      // A fresh connection (page refresh) rejoins: the mute is still on,
      // and the published state says so (peers' rosters agree).
      const second = await initTest(2);
      await second.caller.voice.join({ channelId: channel.id, state: {} });
      const runtime = VoiceRuntime.findById(channel.id)!;
      expect(runtime.getUserState(2).serverMuted).toBe(true);

      const params = await second.caller.voice.createProducerTransport();
      await second.caller.voice.produce({
        transportId: params.id,
        kind: StreamKind.AUDIO,
        rtpParameters: OPUS_RTP_PARAMETERS
      });
      expect(runtime.getProducer(StreamKind.AUDIO, 2)?.paused).toBe(true);

      // Lifting the mute resumes the producer and drops the override.
      await owner.voice.moderateMember({ userId: 2, serverMuted: false });
      expect(runtime.getProducer(StreamKind.AUDIO, 2)?.paused).toBe(false);
      expect(runtime.getUserState(2).serverMuted).toBe(false);
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('the override is dropped with the runtime (an emptied room resets)', async () => {
    const { caller: owner } = await initTest(1);
    const channel = await insertVoiceChannel();
    const first = await initTest(2);

    try {
      await first.caller.voice.join({ channelId: channel.id, state: {} });
      await owner.voice.moderateMember({ userId: 2, serverMuted: true });
      await first.caller.voice.leave();
      // Last occupant gone → runtime destroyed, override gone with it.
      expect(VoiceRuntime.findById(channel.id)).toBeUndefined();

      const second = await initTest(2);
      await second.caller.voice.join({ channelId: channel.id, state: {} });
      expect(
        VoiceRuntime.findById(channel.id)?.getUserState(2).serverMuted
      ).toBe(false);
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('server-deafen pauses the target\'s audio consumers and new consumers are born paused', async () => {
    const { caller: owner } = await initTest(1);
    const channel = await insertVoiceChannel();
    const speaker = await initTest(2);
    const listener = await initTest(3);

    try {
      const { routerRtpCapabilities } = await speaker.caller.voice.join({
        channelId: channel.id,
        state: {}
      });
      const sendParams = await speaker.caller.voice.createProducerTransport();
      await speaker.caller.voice.produce({
        transportId: sendParams.id,
        kind: StreamKind.AUDIO,
        rtpParameters: OPUS_RTP_PARAMETERS
      });

      await listener.caller.voice.join({ channelId: channel.id, state: {} });
      await listener.caller.voice.createConsumerTransport();
      await listener.caller.voice.consume({
        kind: StreamKind.AUDIO,
        remoteId: 2,
        rtpCapabilities: routerRtpCapabilities
      });

      const runtime = VoiceRuntime.findById(channel.id)!;
      expect(runtime.getConsumers(3)).toHaveLength(1);
      expect(runtime.getConsumers(3)[0]!.paused).toBe(false);

      await owner.voice.moderateMember({ userId: 3, serverDeafened: true });
      expect(runtime.getConsumers(3)[0]!.paused).toBe(true);
      expect(runtime.getUserState(3).serverDeafened).toBe(true);

      // Rejoin while deafened: the override holds and a consumer created
      // now starts paused — a modified client cannot hear anything.
      await listener.caller.voice.leave();
      const again = await initTest(3);
      await again.caller.voice.join({ channelId: channel.id, state: {} });
      expect(runtime.getUserState(3).serverDeafened).toBe(true);
      await again.caller.voice.createConsumerTransport();
      await again.caller.voice.consume({
        kind: StreamKind.AUDIO,
        remoteId: 2,
        rtpCapabilities: routerRtpCapabilities
      });
      expect(runtime.getConsumers(3)[0]!.paused).toBe(true);

      await owner.voice.moderateMember({ userId: 3, serverDeafened: false });
      expect(runtime.getConsumers(3)[0]!.paused).toBe(false);
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('a deafened user cannot lift it through updateState', async () => {
    const { caller: owner } = await initTest(1);
    const channel = await insertVoiceChannel();
    const target = await initTest(2);

    try {
      await target.caller.voice.join({ channelId: channel.id, state: {} });
      await owner.voice.moderateMember({ userId: 2, serverDeafened: true });
      await target.caller.voice.updateState({ soundMuted: false });
      const state = VoiceRuntime.findById(channel.id)!.getUserState(2);
      expect(state.serverDeafened).toBe(true);
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });
});

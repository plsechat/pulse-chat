import { ServerEvents } from '@pulse/shared';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  createTestServer,
  insertOtherServer,
  insertVoiceChannel,
  stageUserInVoice
} from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { dmChannelMembers, dmChannels, serverMembers } from '../../db/schema';
import { VoiceRuntime } from '../../runtimes/voice';
import { pubsub } from '../../utils/pubsub';

// Deleting a channel/DM/server with a live call, leaving a server or a
// group, or being removed from a group must end the affected sessions
// the way a voluntary leave does: USER_LEAVE_VOICE (and DM_CALL_ENDED)
// reach the audience and the runtime is torn down. A bare destroy left
// clients "connected" to a room that no longer existed.

type PublishCall = [number | number[], string, Record<string, unknown>];

const callsFor = (spy: { mock: { calls: unknown[][] } }, topic: string) =>
  (spy.mock.calls as PublishCall[]).filter(([, t]) => t === topic);

let publishSpy: ReturnType<typeof spyOn> | undefined;

const spyPublish = () => {
  publishSpy = spyOn(pubsub, 'publishFor');
  return publishSpy;
};

afterEach(() => {
  publishSpy?.mockRestore();
  publishSpy = undefined;
});

const makeGroup = async (ownerId: number, memberIds: number[]) => {
  const tdb = getTestDb();
  const now = Date.now();
  const [row] = await tdb
    .insert(dmChannels)
    .values({ ownerId, isGroup: true, createdAt: now })
    .returning();
  await tdb.insert(dmChannelMembers).values(
    memberIds.map((userId) => ({ dmChannelId: row!.id, userId, createdAt: now }))
  );
  return row!.id;
};

describe('channels.delete with a live call', () => {
  test('occupants get USER_LEAVE_VOICE (kind channel) and the runtime is gone', async () => {
    const { caller: owner } = await initTest(1);
    const channel = await insertVoiceChannel();
    const member = await initTest(2);
    await member.caller.voice.join({ channelId: channel.id, state: {} });

    const spy = spyPublish();

    try {
      await owner.channels.delete({ channelId: channel.id });

      const leaves = callsFor(spy, ServerEvents.USER_LEAVE_VOICE);
      expect(leaves).toHaveLength(1);
      expect(leaves[0]![2]).toMatchObject({
        channelId: channel.id,
        kind: 'channel',
        userId: 2
      });
      // Delivered to the server's members (the leaver included).
      expect(leaves[0]![0]).toContain(2);
      expect(VoiceRuntime.findById(channel.id)).toBeUndefined();
      expect(VoiceRuntime.findRuntimeByUserId(2)).toBeUndefined();

      // The evicted connection still carries its markers; it must not be
      // able to publish state for the room it is no longer in.
      await expect(
        member.caller.voice.updateState({ micMuted: true })
      ).rejects.toThrow('User is not in a voice channel');
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('a channel of another server is not deletable (scope) and its call is untouched', async () => {
    const { caller: owner } = await initTest(1);
    const otherServer = await insertOtherServer();
    const foreign = await insertVoiceChannel(otherServer.id);
    stageUserInVoice(foreign.id, 3);

    try {
      await expect(
        owner.channels.delete({ channelId: foreign.id })
      ).rejects.toThrow('Channel not found');
      expect(VoiceRuntime.findRuntimeByUserId(3)?.id).toBe(foreign.id);
    } finally {
      await VoiceRuntime.findById(foreign.id)?.destroy();
    }
  });
});

describe('dms.deleteChannel with a live call', () => {
  test('participants get USER_LEAVE_VOICE (kind dm) and DM_CALL_ENDED', async () => {
    const { caller: caller1 } = await initTest(1);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const member = await initTest(2);
    await member.caller.dms.voiceJoin({ dmChannelId: channel.id, state: {} });
    expect(VoiceRuntime.findById(channel.id, 'dm')).toBeDefined();

    const spy = spyPublish();

    try {
      await caller1.dms.deleteChannel({ dmChannelId: channel.id });

      const leaves = callsFor(spy, ServerEvents.USER_LEAVE_VOICE);
      expect(leaves).toHaveLength(1);
      expect(leaves[0]![2]).toMatchObject({
        channelId: channel.id,
        kind: 'dm',
        userId: 2
      });
      const ended = callsFor(spy, ServerEvents.DM_CALL_ENDED);
      expect(ended).toHaveLength(1);
      expect(ended[0]![2]).toEqual({ dmChannelId: channel.id });
      expect(VoiceRuntime.findById(channel.id, 'dm')).toBeUndefined();
    } finally {
      await VoiceRuntime.findById(channel.id, 'dm')?.destroy();
    }
  });
});

describe('servers.delete with live calls', () => {
  test('every voice channel of the server is evicted before the rows go', async () => {
    const { caller: owner } = await initTest(1);
    const serverId = await createTestServer({ ownerId: 1 });
    await getTestDb()
      .insert(serverMembers)
      .values([
        { serverId, userId: 1, joinedAt: Date.now(), position: 0 },
        { serverId, userId: 2, joinedAt: Date.now(), position: 0 }
      ]);
    const channelA = await insertVoiceChannel(serverId);
    const channelB = await insertVoiceChannel(serverId);
    stageUserInVoice(channelA.id, 2);
    stageUserInVoice(channelB.id, 3);

    const spy = spyPublish();

    try {
      await owner.servers.delete({ serverId });

      const leaves = callsFor(spy, ServerEvents.USER_LEAVE_VOICE);
      expect(leaves.map((c) => c[2].userId).sort()).toEqual([2, 3]);
      expect(leaves[0]![2].kind).toBe('channel');
      // The audience was resolved while the server rows still existed.
      expect(leaves[0]![0]).toEqual(expect.arrayContaining([1, 2]));
      expect(VoiceRuntime.findById(channelA.id)).toBeUndefined();
      expect(VoiceRuntime.findById(channelB.id)).toBeUndefined();
    } finally {
      await VoiceRuntime.findById(channelA.id)?.destroy();
      await VoiceRuntime.findById(channelB.id)?.destroy();
    }
  });
});

describe('servers.leave', () => {
  test('leaving the server leaves its voice channel and clears the connection markers', async () => {
    const channel = await insertVoiceChannel();
    const member = await initTest(2);
    await member.caller.voice.join({ channelId: channel.id, state: {} });
    expect(member.ctx.currentVoiceChannelId).toBe(channel.id);

    const spy = spyPublish();

    try {
      await member.caller.servers.leave({ serverId: 1 });

      const leaves = callsFor(spy, ServerEvents.USER_LEAVE_VOICE);
      expect(leaves).toHaveLength(1);
      expect(leaves[0]![2]).toMatchObject({
        channelId: channel.id,
        kind: 'channel',
        userId: 2
      });
      // Resolved before the membership went: the leaver is in the audience.
      expect(leaves[0]![0]).toContain(2);
      expect(VoiceRuntime.findRuntimeByUserId(2)).toBeUndefined();
      expect(member.ctx.currentVoiceChannelId).toBeUndefined();
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });

  test('leaving another server leaves a session elsewhere alone', async () => {
    const channel = await insertVoiceChannel();
    const otherServer = await insertOtherServer();
    await getTestDb()
      .insert(serverMembers)
      .values({ serverId: otherServer.id, userId: 2, joinedAt: Date.now() });
    const member = await initTest(2);
    await member.caller.voice.join({ channelId: channel.id, state: {} });

    const spy = spyPublish();

    try {
      await member.caller.servers.leave({ serverId: otherServer.id });

      expect(callsFor(spy, ServerEvents.USER_LEAVE_VOICE)).toHaveLength(0);
      expect(VoiceRuntime.findRuntimeByUserId(2)?.id).toBe(channel.id);
      expect(member.ctx.currentVoiceChannelId).toBe(channel.id);
    } finally {
      await VoiceRuntime.findById(channel.id)?.destroy();
    }
  });
});

describe('dms.leave (group) and dms.removeMember', () => {
  test('leaving the group leaves its call', async () => {
    const groupId = await makeGroup(1, [1, 2, 3]);
    const member = await initTest(2);
    await member.caller.dms.voiceJoin({ dmChannelId: groupId, state: {} });
    expect(member.ctx.currentDmVoiceChannelId).toBe(groupId);

    const spy = spyPublish();

    try {
      await member.caller.dms.leave({ dmChannelId: groupId });

      const leaves = callsFor(spy, ServerEvents.USER_LEAVE_VOICE);
      expect(leaves).toHaveLength(1);
      expect(leaves[0]![2]).toMatchObject({
        channelId: groupId,
        kind: 'dm',
        userId: 2
      });
      expect(leaves[0]![0]).toEqual(expect.arrayContaining([1, 2, 3]));
      expect(callsFor(spy, ServerEvents.DM_CALL_ENDED)).toHaveLength(1);
      expect(VoiceRuntime.findById(groupId, 'dm')).toBeUndefined();
      expect(member.ctx.currentDmVoiceChannelId).toBeUndefined();
      expect(member.ctx.currentVoiceChannelId).toBeUndefined();
    } finally {
      await VoiceRuntime.findById(groupId, 'dm')?.destroy();
    }
  });

  test('leaving a group while in a different call leaves that call alone', async () => {
    const groupId = await makeGroup(1, [1, 2, 3]);
    const otherGroupId = await makeGroup(1, [1, 2]);
    const member = await initTest(2);
    await member.caller.dms.voiceJoin({ dmChannelId: otherGroupId, state: {} });

    const spy = spyPublish();

    try {
      await member.caller.dms.leave({ dmChannelId: groupId });

      expect(callsFor(spy, ServerEvents.USER_LEAVE_VOICE)).toHaveLength(0);
      expect(VoiceRuntime.findRuntimeByUserId(2)?.id).toBe(otherGroupId);
    } finally {
      await VoiceRuntime.findById(otherGroupId, 'dm')?.destroy();
    }
  });

  test('a removed member is evicted from the group call', async () => {
    const { caller: owner } = await initTest(1);
    const groupId = await makeGroup(1, [1, 2, 3]);
    const member = await initTest(2);
    const other = await initTest(3);
    await member.caller.dms.voiceJoin({ dmChannelId: groupId, state: {} });
    await other.caller.dms.voiceJoin({ dmChannelId: groupId, state: {} });

    const spy = spyPublish();

    try {
      await owner.dms.removeMember({ dmChannelId: groupId, userId: 2 });

      const leaves = callsFor(spy, ServerEvents.USER_LEAVE_VOICE);
      expect(leaves).toHaveLength(1);
      expect(leaves[0]![2]).toMatchObject({
        channelId: groupId,
        kind: 'dm',
        userId: 2
      });
      // Resolved before the member row went: the removed user hears it.
      expect(leaves[0]![0]).toContain(2);
      expect(callsFor(spy, ServerEvents.DM_CALL_USER_LEFT)).toHaveLength(1);
      // The call goes on for the remaining participant.
      const runtime = VoiceRuntime.findById(groupId, 'dm');
      expect(runtime?.getUser(2)).toBeUndefined();
      expect(runtime?.getUser(3)).toBeDefined();
    } finally {
      await VoiceRuntime.findById(groupId, 'dm')?.destroy();
    }
  });
});

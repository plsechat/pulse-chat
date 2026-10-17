import { ServerEvents } from '@pulse/shared';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { firstSubscriptionEvent, initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { dmChannelMembers, dmChannels, friendships } from '../../db/schema';
import { VoiceRuntime } from '../../runtimes/voice';
import { pubsub } from '../../utils/pubsub';

/**
 * DM calls: voiceJoin / voiceLeave / getActiveCalls / declineCall
 * against the real mediasoup worker the preload loads (membership,
 * idempotent rejoin, leave-when-not-joined, call lifecycle events),
 * plus the one-line `on*` subscription tests for the dms namespace.
 *
 * Not repeated here (already probed elsewhere): declineCall membership
 * gating (dms.test.ts), pins/deleteMessage (dms-messages.test.ts),
 * markChannelAsRead/markAllAsRead (dms-read-state.test.ts),
 * updateGroup/leave (dms-group.test.ts), call eviction on
 * delete/leave/remove (voice-eviction.test.ts), the capacity cap
 * (voice-capacity.test.ts).
 *
 * Voice runtimes are module-level state the TRUNCATE does not touch:
 * every test that joins destroys what it created in `finally`.
 */

type PublishCall = [number | number[], string, Record<string, unknown>];

const callsFor = (spy: { mock: { calls: unknown[][] } }, topic: string) =>
  (spy.mock.calls as PublishCall[]).filter(([, t]) => t === topic);

const befriend = async (a: number, b: number) => {
  await getTestDb()
    .insert(friendships)
    .values({ userId: a, friendId: b, createdAt: Date.now() });
};

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

const destroyDmRuntime = async (dmChannelId: number) => {
  await VoiceRuntime.findById(dmChannelId, 'dm')?.destroy();
};

afterEach(() => {
  mock.restore();
});

describe('dms voice routes — id bounds', () => {
  test('declineCall rejects non-integer and non-positive ids', async () => {
    const { caller } = await initTest(1);

    await expect(caller.dms.declineCall({ dmChannelId: 1.5 })).rejects.toThrow();
    await expect(caller.dms.declineCall({ dmChannelId: 0 })).rejects.toThrow();
  });

  test('voiceJoin rejects non-integer and non-positive ids', async () => {
    const { caller } = await initTest(1);

    await expect(
      caller.dms.voiceJoin({ dmChannelId: 2.5, state: {} })
    ).rejects.toThrow();
    await expect(
      caller.dms.voiceJoin({ dmChannelId: -3, state: {} })
    ).rejects.toThrow();
  });
});

describe('dms.voiceJoin', () => {
  test('non-member and unknown channel are refused; no runtime is created', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);
    const { caller: caller3 } = await initTest(3);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });

    await expect(
      caller3.dms.voiceJoin({ dmChannelId: channel.id, state: {} })
    ).rejects.toThrow('Not a member of this DM channel');
    await expect(
      caller3.dms.voiceJoin({ dmChannelId: 999_999, state: {} })
    ).rejects.toThrow('DM channel not found');

    expect(VoiceRuntime.findById(channel.id, 'dm')).toBeUndefined();
    expect(VoiceRuntime.findRuntimeByUserId(3)).toBeUndefined();
  });

  test('first join starts the call (STARTED + USER_JOINED to every member), second join only USER_JOINED', async () => {
    const { caller: caller1 } = await initTest(1);
    const member = await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const spy = spyOn(pubsub, 'publishFor');

    try {
      const result = await member.caller.dms.voiceJoin({
        dmChannelId: channel.id,
        state: { micMuted: true }
      });
      expect(result.routerRtpCapabilities.codecs?.length).toBeGreaterThan(0);
      expect(member.ctx.currentDmVoiceChannelId).toBe(channel.id);
      expect(member.ctx.currentVoiceChannelId).toBe(channel.id);

      const started = callsFor(spy, ServerEvents.DM_CALL_STARTED);
      expect(started).toHaveLength(1);
      expect([...(started[0]![0] as number[])].sort()).toEqual([1, 2]);
      expect(started[0]![2]).toEqual({ dmChannelId: channel.id, startedBy: 2 });

      const joined = callsFor(spy, ServerEvents.DM_CALL_USER_JOINED);
      expect(joined).toHaveLength(1);
      expect([...(joined[0]![0] as number[])].sort()).toEqual([1, 2]);
      expect(joined[0]![2]).toMatchObject({
        dmChannelId: channel.id,
        userId: 2,
        state: { micMuted: true, soundMuted: false }
      });

      await caller1.dms.voiceJoin({ dmChannelId: channel.id, state: {} });
      expect(callsFor(spy, ServerEvents.DM_CALL_STARTED)).toHaveLength(1);
      const joinedAll = callsFor(spy, ServerEvents.DM_CALL_USER_JOINED);
      expect(joinedAll).toHaveLength(2);
      expect(joinedAll[1]![2]).toMatchObject({ dmChannelId: channel.id, userId: 1 });

      const runtime = VoiceRuntime.findById(channel.id, 'dm')!;
      expect(runtime.getState().users.map((u) => u.userId).sort()).toEqual([1, 2]);
    } finally {
      await destroyDmRuntime(channel.id);
    }
  });

  test('joining twice is idempotent: one session, one runtime, markers unchanged', async () => {
    const { caller: caller1 } = await initTest(1);
    const member = await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });

    try {
      await member.caller.dms.voiceJoin({ dmChannelId: channel.id, state: {} });
      await member.caller.dms.voiceJoin({
        dmChannelId: channel.id,
        state: { soundMuted: true }
      });

      const runtime = VoiceRuntime.findById(channel.id, 'dm')!;
      expect(runtime.getState().users.filter((u) => u.userId === 2)).toHaveLength(1);
      // The rejoin's state wins (self-heal replaces the stale session).
      expect(runtime.getUserState(2)).toMatchObject({ soundMuted: true });
      expect(VoiceRuntime.findRuntimeByUserId(2)?.id).toBe(channel.id);
      expect(member.ctx.currentDmVoiceChannelId).toBe(channel.id);
    } finally {
      await destroyDmRuntime(channel.id);
    }
  });

  test('joining a second DM call moves the user out of the first one', async () => {
    const { caller: caller1 } = await initTest(1);
    const member = await initTest(2);
    await initTest(3);
    const first = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const second = await makeGroup(1, [1, 2, 3]);

    try {
      await member.caller.dms.voiceJoin({ dmChannelId: first.id, state: {} });
      const spy = spyOn(pubsub, 'publishFor');
      await member.caller.dms.voiceJoin({ dmChannelId: second, state: {} });

      // The lone session in the first room is ended, not left dangling.
      expect(VoiceRuntime.findById(first.id, 'dm')).toBeUndefined();
      expect(callsFor(spy, ServerEvents.DM_CALL_ENDED)[0]![2]).toEqual({
        dmChannelId: first.id
      });
      expect(VoiceRuntime.findRuntimeByUserId(2)?.id).toBe(second);
      expect(member.ctx.currentDmVoiceChannelId).toBe(second);
    } finally {
      await destroyDmRuntime(first.id);
      await destroyDmRuntime(second);
    }
  });
});

describe('dms.voiceLeave', () => {
  test('leaving without a call is refused and touches nothing', async () => {
    const { caller: caller1 } = await initTest(1);
    const member = await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const spy = spyOn(pubsub, 'publishFor');

    await expect(member.caller.dms.voiceLeave()).rejects.toThrow(
      'Not in a DM voice call'
    );
    expect(callsFor(spy, ServerEvents.USER_LEAVE_VOICE)).toHaveLength(0);
    expect(VoiceRuntime.findById(channel.id, 'dm')).toBeUndefined();
  });

  test('last participant leaving ends the call: USER_LEAVE_VOICE + DM_CALL_ENDED, runtime gone, markers cleared', async () => {
    const { caller: caller1 } = await initTest(1);
    const member = await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });

    try {
      await member.caller.dms.voiceJoin({ dmChannelId: channel.id, state: {} });
      const spy = spyOn(pubsub, 'publishFor');

      await member.caller.dms.voiceLeave();

      const leaves = callsFor(spy, ServerEvents.USER_LEAVE_VOICE);
      expect(leaves).toHaveLength(1);
      expect([...(leaves[0]![0] as number[])].sort()).toEqual([1, 2]);
      expect(leaves[0]![2]).toMatchObject({
        channelId: channel.id,
        kind: 'dm',
        userId: 2
      });
      const ended = callsFor(spy, ServerEvents.DM_CALL_ENDED);
      expect(ended).toHaveLength(1);
      expect(ended[0]![2]).toEqual({ dmChannelId: channel.id });
      expect(callsFor(spy, ServerEvents.DM_CALL_USER_LEFT)).toHaveLength(0);

      expect(VoiceRuntime.findById(channel.id, 'dm')).toBeUndefined();
      expect(member.ctx.currentDmVoiceChannelId).toBeUndefined();
      expect(member.ctx.currentVoiceChannelId).toBeUndefined();

      // A second leave has nothing to leave.
      await expect(member.caller.dms.voiceLeave()).rejects.toThrow(
        'Not in a DM voice call'
      );
    } finally {
      await destroyDmRuntime(channel.id);
    }
  });

  test('leaving with others still in the call publishes DM_CALL_USER_LEFT and keeps the runtime', async () => {
    const owner = await initTest(1);
    const member = await initTest(2);
    const channel = await owner.caller.dms.getOrCreateChannel({ userId: 2 });

    try {
      await owner.caller.dms.voiceJoin({ dmChannelId: channel.id, state: {} });
      await member.caller.dms.voiceJoin({ dmChannelId: channel.id, state: {} });
      const spy = spyOn(pubsub, 'publishFor');

      await member.caller.dms.voiceLeave();

      const left = callsFor(spy, ServerEvents.DM_CALL_USER_LEFT);
      expect(left).toHaveLength(1);
      expect(left[0]![2]).toEqual({ dmChannelId: channel.id, userId: 2 });
      expect(callsFor(spy, ServerEvents.DM_CALL_ENDED)).toHaveLength(0);

      const runtime = VoiceRuntime.findById(channel.id, 'dm')!;
      expect(runtime.getUser(2)).toBeUndefined();
      expect(runtime.getUser(1)).toBeDefined();
      expect(owner.ctx.currentDmVoiceChannelId).toBe(channel.id);
    } finally {
      await destroyDmRuntime(channel.id);
    }
  });

  test('a fresh connection can still leave the stale session (runtime fallback)', async () => {
    const { caller: caller1 } = await initTest(1);
    const stale = await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });

    try {
      await stale.caller.dms.voiceJoin({ dmChannelId: channel.id, state: {} });

      // Same user, new WS context: no channel marker on this connection.
      const fresh = await initTest(2);
      expect(fresh.ctx.currentDmVoiceChannelId).toBeUndefined();

      await fresh.caller.dms.voiceLeave();
      expect(VoiceRuntime.findById(channel.id, 'dm')).toBeUndefined();
      expect(VoiceRuntime.findRuntimeByUserId(2)).toBeUndefined();
    } finally {
      await destroyDmRuntime(channel.id);
    }
  });
});

describe('dms.getActiveCalls', () => {
  test('lists live calls in the caller\'s channels only, with participant state', async () => {
    const { caller: caller1 } = await initTest(1);
    const member = await initTest(2);
    const { caller: caller3 } = await initTest(3);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });

    expect(await caller1.dms.getActiveCalls()).toEqual([]);

    try {
      await member.caller.dms.voiceJoin({
        dmChannelId: channel.id,
        state: { micMuted: true }
      });

      const forOwner = await caller1.dms.getActiveCalls();
      expect(forOwner).toHaveLength(1);
      expect(forOwner[0]!.dmChannelId).toBe(channel.id);
      expect(forOwner[0]!.users).toHaveLength(1);
      expect(forOwner[0]!.users[0]).toMatchObject({
        userId: 2,
        state: { micMuted: true, soundMuted: false }
      });
      // The participant sees it too; a non-member never does.
      expect(await member.caller.dms.getActiveCalls()).toHaveLength(1);
      expect(await caller3.dms.getActiveCalls()).toEqual([]);

      await member.caller.dms.voiceLeave();
      expect(await caller1.dms.getActiveCalls()).toEqual([]);
    } finally {
      await destroyDmRuntime(channel.id);
    }
  });

  test('a call in a group the caller belongs to is listed next to a 1:1 call', async () => {
    const { caller: caller1 } = await initTest(1);
    const member = await initTest(2);
    const other = await initTest(3);
    const direct = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const groupId = await makeGroup(1, [1, 2, 3]);

    try {
      await member.caller.dms.voiceJoin({ dmChannelId: direct.id, state: {} });
      await other.caller.dms.voiceJoin({ dmChannelId: groupId, state: {} });

      const calls = await caller1.dms.getActiveCalls();
      expect(calls.map((c) => c.dmChannelId).sort()).toEqual(
        [direct.id, groupId].sort()
      );
      // User 3 is not in the 1:1 — only the group call shows for them.
      expect((await other.caller.dms.getActiveCalls()).map((c) => c.dmChannelId)).toEqual([
        groupId
      ]);
    } finally {
      await destroyDmRuntime(direct.id);
      await destroyDmRuntime(groupId);
    }
  });
});

describe('dms.declineCall', () => {
  test('publishes DM_CALL_DECLINED once per member, decliner included', async () => {
    await initTest(1);
    const { caller: caller2 } = await initTest(2);
    await initTest(3);
    const groupId = await makeGroup(1, [1, 2, 3]);
    const spy = spyOn(pubsub, 'publishFor');

    await caller2.dms.declineCall({ dmChannelId: groupId });

    const declined = callsFor(spy, ServerEvents.DM_CALL_DECLINED);
    expect(declined.map(([userIds]) => userIds).sort()).toEqual([1, 2, 3]);
    for (const [, , payload] of declined) {
      expect(payload).toEqual({ dmChannelId: groupId, userId: 2 });
    }
    // Pure notification: nothing else fires and no runtime appears.
    expect(callsFor(spy, ServerEvents.DM_CALL_ENDED)).toHaveLength(0);
    expect(VoiceRuntime.findById(groupId, 'dm')).toBeUndefined();
  });
});

describe('dms subscriptions', () => {
  test('onCallStarted', async () => {
    const { caller: caller1 } = await initTest(1);
    const member = await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    try {
      const event = await firstSubscriptionEvent(caller1, 'dms', 'onCallStarted', () =>
        member.caller.dms.voiceJoin({ dmChannelId: channel.id, state: {} })
      );
      expect(event).toEqual({ dmChannelId: channel.id, startedBy: 2 });
    } finally {
      await destroyDmRuntime(channel.id);
    }
  });

  test('onCallUserJoined', async () => {
    const { caller: caller1 } = await initTest(1);
    const member = await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    try {
      const event = await firstSubscriptionEvent(caller1, 'dms', 'onCallUserJoined', () =>
        member.caller.dms.voiceJoin({
          dmChannelId: channel.id,
          state: { micMuted: true }
        })
      );
      expect(event).toMatchObject({
        dmChannelId: channel.id,
        userId: 2,
        state: { micMuted: true }
      });
    } finally {
      await destroyDmRuntime(channel.id);
    }
  });

  test('onCallUserLeft', async () => {
    const owner = await initTest(1);
    const member = await initTest(2);
    const channel = await owner.caller.dms.getOrCreateChannel({ userId: 2 });
    try {
      await owner.caller.dms.voiceJoin({ dmChannelId: channel.id, state: {} });
      await member.caller.dms.voiceJoin({ dmChannelId: channel.id, state: {} });
      const event = await firstSubscriptionEvent(owner.caller, 'dms', 'onCallUserLeft', () =>
        member.caller.dms.voiceLeave()
      );
      expect(event).toEqual({ dmChannelId: channel.id, userId: 2 });
    } finally {
      await destroyDmRuntime(channel.id);
    }
  });

  test('onCallEnded', async () => {
    const { caller: caller1 } = await initTest(1);
    const member = await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    try {
      await member.caller.dms.voiceJoin({ dmChannelId: channel.id, state: {} });
      const event = await firstSubscriptionEvent(caller1, 'dms', 'onCallEnded', () =>
        member.caller.dms.voiceLeave()
      );
      expect(event).toEqual({ dmChannelId: channel.id });
    } finally {
      await destroyDmRuntime(channel.id);
    }
  });

  test('onCallDeclined', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const event = await firstSubscriptionEvent(caller1, 'dms', 'onCallDeclined', () =>
      caller2.dms.declineCall({ dmChannelId: channel.id })
    );
    expect(event).toEqual({ dmChannelId: channel.id, userId: 2 });
  });

  test('onNewMessage', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const event = await firstSubscriptionEvent<{ content: string; userId: number }>(
      caller1,
      'dms',
      'onNewMessage',
      () => caller2.dms.sendMessage({ dmChannelId: channel.id, content: 'hi' })
    );
    expect(event).toMatchObject({ dmChannelId: channel.id, userId: 2, content: 'hi' });
  });

  test('onMessageUpdate (pin)', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const dmMessageId = await caller2.dms.sendMessage({
      dmChannelId: channel.id,
      content: 'pin me'
    });
    const event = await firstSubscriptionEvent<{ id: number; pinned: boolean }>(
      caller1,
      'dms',
      'onMessageUpdate',
      () => caller2.dms.pinMessage({ dmMessageId })
    );
    expect(event).toMatchObject({ id: dmMessageId, pinned: true, pinnedBy: 2 });
  });

  test('onMessageDelete', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const messageId = await caller2.dms.sendMessage({
      dmChannelId: channel.id,
      content: 'gone'
    });
    const event = await firstSubscriptionEvent(caller1, 'dms', 'onMessageDelete', () =>
      caller2.dms.deleteMessage({ messageId })
    );
    // The row stays as a tombstone, so the event says who deleted it and when.
    expect(event).toEqual({
      dmMessageId: messageId,
      dmChannelId: channel.id,
      deletedBy: 2,
      deletedAt: expect.any(Number)
    });
  });

  test('onTyping (other members only)', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const event = await firstSubscriptionEvent(caller1, 'dms', 'onTyping', () =>
      caller2.dms.signalTyping({ dmChannelId: channel.id })
    );
    expect(event).toEqual({ dmChannelId: channel.id, userId: 2 });
    await expect(
      firstSubscriptionEvent(
        caller2,
        'dms',
        'onTyping',
        () => caller2.dms.signalTyping({ dmChannelId: channel.id }),
        { timeoutMs: 150 }
      )
    ).rejects.toThrow('yielded no event');
  });

  test('onReadStateUpdate (self-scoped)', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const newest = await caller2.dms.sendMessage({
      dmChannelId: channel.id,
      content: 'unread'
    });
    const event = await firstSubscriptionEvent(caller1, 'dms', 'onReadStateUpdate', () =>
      caller1.dms.markChannelAsRead({ dmChannelId: channel.id })
    );
    expect(event).toEqual({ dmChannelId: channel.id, lastReadMessageId: newest });
  });

  test('onChannelUpdate (group rename reaches a member)', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const groupId = await makeGroup(1, [1, 2]);
    const event = await firstSubscriptionEvent(caller2, 'dms', 'onChannelUpdate', () =>
      caller1.dms.updateGroup({ dmChannelId: groupId, name: 'renamed' })
    );
    expect(event).toEqual({ dmChannelId: groupId, name: 'renamed', iconFileId: null });
  });

  test('onMemberAdd', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    await initTest(3);
    await befriend(1, 3);
    const groupId = await makeGroup(1, [1, 2]);
    const event = await firstSubscriptionEvent(caller2, 'dms', 'onMemberAdd', () =>
      caller1.dms.addMember({ dmChannelId: groupId, userIds: [3] })
    );
    expect(event).toEqual({ dmChannelId: groupId, userId: 3 });
  });

  test('onMemberRemove (leave reaches the remaining members)', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    await initTest(3);
    const groupId = await makeGroup(1, [1, 2, 3]);
    const event = await firstSubscriptionEvent(caller1, 'dms', 'onMemberRemove', () =>
      caller2.dms.leave({ dmChannelId: groupId })
    );
    expect(event).toEqual({ dmChannelId: groupId, userId: 2 });
  });

  test('onChannelDelete (the leaver is told to drop the channel)', async () => {
    await initTest(1);
    const { caller: caller2 } = await initTest(2);
    await initTest(3);
    const groupId = await makeGroup(1, [1, 2, 3]);
    const event = await firstSubscriptionEvent(caller2, 'dms', 'onChannelDelete', () =>
      caller2.dms.leave({ dmChannelId: groupId })
    );
    expect(event).toEqual({ dmChannelId: groupId });
  });
});

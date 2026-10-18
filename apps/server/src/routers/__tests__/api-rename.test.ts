/**
 * tRPC API rename (audit A9-22, owner decision D30): the session
 * bootstrap is `others.openSession`, the invite join is
 * `servers.joinByInvite`, the "member's session connected" event is
 * `users.onConnected` / USER_CONNECTED, and becoming a member is
 * SERVER_MEMBER_JOIN fanned out to every member. The old names answer
 * as aliases for one release (v0.4.0 ships them, v0.5.0 deletes them):
 * federated peers on the previous release call `others.joinServer`
 * over remote tRPC.
 */
import { ServerEvents } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import {
  firstSubscriptionEvent,
  getCaller,
  initTest
} from '../../__tests__/helpers';
import { appRouter } from '..';
import { pubsub } from '../../utils/pubsub';

type TPublished = { userIds: unknown; topic: string; payload: unknown };

const capturePublishes = () => {
  const published: TPublished[] = [];
  const original = pubsub.publishFor.bind(pubsub);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pubsub as any).publishFor = (userIds: unknown, topic: string, payload: unknown) => {
    published.push({ userIds, topic, payload });
    return original(userIds as never, topic as never, payload as never);
  };
  return {
    published,
    restore: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pubsub as any).publishFor = original;
    }
  };
};

/** A member who left server 1 and holds an invite back in. */
const leaveAndGetInvite = async () => {
  const owner = await initTest(1);
  const invite = await owner.caller.invites.add({ serverId: 1 });
  const member = await initTest(2);
  await member.caller.servers.leave({ serverId: 1 });
  return { owner, member, inviteCode: invite.code };
};

describe('renamed procedures and their one-release aliases', () => {
  test('both names of every renamed procedure are registered', () => {
    const procedures = Object.keys(appRouter._def.procedures);
    for (const name of [
      'others.openSession',
      'others.joinServer',
      'servers.joinByInvite',
      'servers.join',
      'users.onConnected',
      'users.onJoin'
    ]) {
      expect(procedures).toContain(name);
    }
  });

  test('others.openSession bootstraps the session; others.joinServer answers the same', async () => {
    const { caller } = await getCaller(1);
    const { handshakeHash } = await caller.others.handshake();

    const viaNew = await caller.others.openSession({ handshakeHash });
    expect(viaNew.ownUserId).toBe(1);
    expect(viaNew.serverDbId).toBe(1);
    expect(viaNew).toHaveProperty('channels');

    const viaAlias = await caller.others.joinServer({ handshakeHash });
    expect(Object.keys(viaAlias).sort()).toEqual(Object.keys(viaNew).sort());
    expect(viaAlias.serverId).toBe(viaNew.serverId);
  });

  test('others.openSession rejects a bad handshake exactly like the alias did', async () => {
    const { caller } = await getCaller(1);
    await expect(
      caller.others.openSession({ handshakeHash: '' })
    ).rejects.toThrow('Invalid handshake hash');
    await expect(
      caller.others.joinServer({ handshakeHash: '' })
    ).rejects.toThrow('Invalid handshake hash');
  });

  test('servers.joinByInvite joins by invite code', async () => {
    const { member, inviteCode } = await leaveAndGetInvite();
    const summary = await member.caller.servers.joinByInvite({ inviteCode });
    expect(summary.id).toBe(1);
    expect((await member.caller.servers.getAll()).map((s) => s.id)).toContain(1);
  });

  test('servers.join still joins by invite code (alias)', async () => {
    const { member, inviteCode } = await leaveAndGetInvite();
    const summary = await member.caller.servers.join({ inviteCode });
    expect(summary.id).toBe(1);
    expect((await member.caller.servers.getAll()).map((s) => s.id)).toContain(1);
  });
});

describe('USER_CONNECTED vs SERVER_MEMBER_JOIN', () => {
  test('the session bootstrap publishes USER_CONNECTED to the members, never SERVER_MEMBER_JOIN', async () => {
    const capture = capturePublishes();
    try {
      await initTest(2);
    } finally {
      capture.restore();
    }

    const connected = capture.published.filter(
      (e) => e.topic === ServerEvents.USER_CONNECTED
    );
    expect(connected).toHaveLength(1);
    expect(connected[0]!.payload).toMatchObject({
      serverId: 1,
      user: { id: 2 }
    });
    expect(connected[0]!.userIds).toContain(1);
    expect(
      capture.published.some((e) => e.topic === ServerEvents.SERVER_MEMBER_JOIN)
    ).toBe(false);
  });

  test('an invite join publishes SERVER_MEMBER_JOIN to every member (joiner included) and no USER_CONNECTED', async () => {
    const { member, inviteCode } = await leaveAndGetInvite();

    const capture = capturePublishes();
    try {
      await member.caller.servers.joinByInvite({ inviteCode });
    } finally {
      capture.restore();
    }

    const joins = capture.published.filter(
      (e) => e.topic === ServerEvents.SERVER_MEMBER_JOIN
    );
    expect(joins).toHaveLength(1);
    const recipients = joins[0]!.userIds as number[];
    expect(recipients).toContain(1);
    expect(recipients).toContain(2);
    expect(joins[0]!.payload).toMatchObject({
      serverId: 1,
      serverPublicId: expect.any(String),
      userId: 2,
      server: { id: 1 },
      user: { id: 2 }
    });
    expect(
      capture.published.some((e) => e.topic === ServerEvents.USER_CONNECTED)
    ).toBe(false);
  });

  test('an existing member receives the invite join on servers.onMemberJoin with the joiner', async () => {
    const { owner, member, inviteCode } = await leaveAndGetInvite();

    const event = await firstSubscriptionEvent<{
      userId: number;
      serverId: number;
      user?: { id: number };
    }>(owner.caller, 'servers', 'onMemberJoin', () =>
      member.caller.servers.joinByInvite({ inviteCode })
    );

    expect(event).toMatchObject({ serverId: 1, userId: 2, user: { id: 2 } });
  });

  test('users.onConnected yields the bootstrap of another member; users.onJoin is its alias', async () => {
    const { caller } = await initTest(1);

    const viaNew = await firstSubscriptionEvent<{ serverId: number; user: { id: number } }>(
      caller,
      'users',
      'onConnected',
      () => initTest(2)
    );
    expect(viaNew).toMatchObject({ serverId: 1, user: { id: 2 } });

    const viaAlias = await firstSubscriptionEvent<{ serverId: number; user: { id: number } }>(
      caller,
      'users',
      'onJoin',
      () => initTest(3)
    );
    expect(viaAlias).toMatchObject({ serverId: 1, user: { id: 3 } });
  });
});

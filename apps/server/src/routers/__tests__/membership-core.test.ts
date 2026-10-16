import { ServerEvents } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import fs from 'node:fs/promises';
import path from 'path';
import {
  createTestServer,
  createTestServerMember,
  createTestUser
} from '../../__tests__/fixtures';
import { getCaller, initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { testsBaseUrl } from '../../__tests__/setup';
import {
  channels,
  files,
  invites,
  messageFiles,
  messages,
  servers,
  users
} from '../../db/schema';
import { generateFileToken } from '../../helpers/files-crypto';
import { PUBLIC_PATH } from '../../helpers/paths';
import { appRouter } from '..';
import { pubsub } from '../../utils/pubsub';
import { getUserRoles } from '../users/get-user-roles';

const GUEST_ROLE = 3;
const DEFAULT_ROLE = 2;

/** An authenticated caller for a user that may hold no membership at all. */
const connectWithoutServer = async (userId: number) => {
  const { caller, ctx } = await getCaller(userId);
  const { handshakeHash } = await caller.others.handshake();
  await caller.others.joinServer({ handshakeHash });
  return { caller, ctx };
};

const capturePublishes = () => {
  const published: { userIds: unknown; topic: string; payload: unknown }[] = [];
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

const channelSalt = async (channelId: number) =>
  (
    await getTestDb()
      .select({ fileAccessToken: channels.fileAccessToken })
      .from(channels)
      .where(eq(channels.id, channelId))
  )[0]!.fileAccessToken;

/**
 * Channel 1 made private with one attachment on disk and in the DB,
 * plus the signed URL a member would hold for it.
 */
const seedPrivateAttachment = async () => {
  const tdb = getTestDb();
  const now = Date.now();
  const name = `kicked-${now}.png`;

  await tdb.update(channels).set({ private: true }).where(eq(channels.id, 1));
  await fs.writeFile(path.join(PUBLIC_PATH, name), 'png-bytes');

  const [file] = await tdb
    .insert(files)
    .values({
      name,
      originalName: 'kicked.png',
      md5: `md5-${name}`,
      userId: 1,
      size: 9,
      mimeType: 'image/png',
      extension: '.png',
      createdAt: now
    })
    .returning();
  const [message] = await tdb
    .insert(messages)
    .values({ userId: 1, channelId: 1, content: 'seeded', createdAt: now })
    .returning();
  await tdb.insert(messageFiles).values({
    messageId: message!.id,
    fileId: file!.id,
    createdAt: now
  });

  const salt = await channelSalt(1);
  const url = `${testsBaseUrl}/public/${name}?accessToken=${generateFileToken(file!.id, salt)}`;

  return { name, salt, url };
};

describe('membership removal re-keys private channels', () => {
  test('a kicked member\'s attachment links stop resolving', async () => {
    const { name, salt, url } = await seedPrivateAttachment();

    try {
      expect((await fetch(url)).status).toBe(200);

      const owner = await initTest(1);
      await owner.caller.users.kick({ userId: 2, reason: 'bye' });

      expect(await channelSalt(1)).not.toBe(salt);
      expect((await fetch(url)).status).toBe(403);
    } finally {
      await fs.rm(path.join(PUBLIC_PATH, name), { force: true });
    }
  });

  test('leaving rotates the private channels of the server left', async () => {
    const tdb = getTestDb();
    await tdb.update(channels).set({ private: true }).where(eq(channels.id, 1));
    const before = await channelSalt(1);

    const { caller } = await initTest(2);
    await caller.servers.leave({ serverId: 1 });

    expect(await channelSalt(1)).not.toBe(before);
  });
});

describe('membership removal strips roles', () => {
  test('a kicked member rejoining by invite holds only the default role', async () => {
    const owner = await initTest(1);
    const invite = await owner.caller.invites.add({ serverId: 1 });
    await owner.caller.users.addRole({ userId: 2, roleId: GUEST_ROLE });
    expect((await getUserRoles(2, 1)).map((r) => r.id).sort()).toEqual([DEFAULT_ROLE, GUEST_ROLE]);

    await owner.caller.users.kick({ userId: 2, reason: 'bye' });
    expect(await getUserRoles(2, 1)).toEqual([]);

    const rejoin = await connectWithoutServer(2);
    const summary = await rejoin.caller.servers.join({ inviteCode: invite.code });
    expect(summary.id).toBe(1);
    expect((await getUserRoles(2, 1)).map((r) => r.id)).toEqual([DEFAULT_ROLE]);
  });

  test('leaving the active server ends access on that connection', async () => {
    const { caller, ctx } = await initTest(2);
    expect(ctx.activeServerId).toBe(1);

    await caller.servers.leave({ serverId: 1 });

    expect(ctx.activeServerId).toBeUndefined();
    await expect(
      caller.messages.get({ channelId: 1, cursor: null, limit: 50 })
    ).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|NOT_FOUND/) });
    expect(await getUserRoles(2, 1)).toEqual([]);
  });

  test('the owner cannot leave their own server', async () => {
    const { caller } = await initTest(1);
    await expect(caller.servers.leave({ serverId: 1 })).rejects.toMatchObject({
      code: 'FORBIDDEN'
    });
  });
});

describe('servers.join consumes the invite only after every check', () => {
  const seedClosedServerInvite = async (maxUses: number, allowNewUsers = true) => {
    const serverId = await createTestServer({ name: 'Closed', ownerId: 1 });
    await createTestServerMember({ serverId, userId: 1 });
    await getTestDb()
      .update(servers)
      .set({ allowNewUsers })
      .where(eq(servers.id, serverId));
    await getTestDb().insert(invites).values({
      code: 'closed-invite',
      creatorId: 1,
      serverId,
      maxUses,
      uses: 0,
      expiresAt: null,
      createdAt: Date.now()
    });
    return serverId;
  };

  const usesOf = async (code: string) => {
    const [row] = await getTestDb()
      .select({ uses: invites.uses })
      .from(invites)
      .where(eq(invites.code, code));
    return row!.uses;
  };

  test('a closed server refuses the join and the invite keeps its uses', async () => {
    await seedClosedServerInvite(1, false);

    const { caller } = await initTest(3);
    await expect(caller.servers.join({ inviteCode: 'closed-invite' })).rejects.toMatchObject({
      code: 'FORBIDDEN'
    });
    expect(await usesOf('closed-invite')).toBe(0);
  });

  test('an exhausted invite is refused before any membership is created', async () => {
    const serverId = await seedClosedServerInvite(1);
    await getTestDb()
      .update(invites)
      .set({ uses: 1 })
      .where(eq(invites.code, 'closed-invite'));

    const { caller } = await initTest(3);
    await expect(caller.servers.join({ inviteCode: 'closed-invite' })).rejects.toThrow(
      /maximum uses/
    );
    expect(await caller.servers.getAll()).not.toContainEqual(
      expect.objectContaining({ id: serverId })
    );
    expect(await usesOf('closed-invite')).toBe(1);
  });

  test('a successful join consumes exactly one use; a member re-joining consumes none', async () => {
    await seedClosedServerInvite(5);
    const { caller } = await initTest(3);

    await caller.servers.join({ inviteCode: 'closed-invite' });
    expect(await usesOf('closed-invite')).toBe(1);

    await caller.servers.join({ inviteCode: 'closed-invite' });
    expect(await usesOf('closed-invite')).toBe(1);
  });
});

describe('servers.transferOwner', () => {
  test('refuses self, banned, deleted and federated targets', async () => {
    const { caller } = await initTest(1);

    await expect(
      caller.servers.transferOwner({ serverId: 1, newOwnerId: 1 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const tdb = getTestDb();
    const banned = await createTestUser({ name: 'banned', banned: true });
    const deleted = await createTestUser({ name: 'deleted' });
    const federated = await createTestUser({ name: 'remote' });
    await tdb.update(users).set({ deletedAt: Date.now() }).where(eq(users.id, deleted));
    await tdb.update(users).set({ isFederated: true }).where(eq(users.id, federated));
    for (const userId of [banned, deleted, federated]) {
      await createTestServerMember({ serverId: 1, userId });
      await expect(
        caller.servers.transferOwner({ serverId: 1, newOwnerId: userId })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }

    const outsider = await createTestUser({ name: 'outsider' });
    await expect(
      caller.servers.transferOwner({ serverId: 1, newOwnerId: outsider })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('the new owner can act immediately on an already-open connection, and clients are told', async () => {
    const owner = await initTest(1);
    const next = await initTest(2);

    // Prime user 2's permission cache with "no MANAGE_ROLES".
    await expect(next.caller.roles.add({ serverId: 1 })).rejects.toMatchObject({
      code: 'FORBIDDEN'
    });

    await new Promise((r) => setTimeout(r, 50));
    const capture = capturePublishes();
    try {
      await owner.caller.servers.transferOwner({ serverId: 1, newOwnerId: 2 });
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      capture.restore();
    }

    const topics = capture.published.map((e) => e.topic);
    expect(topics).toContain(ServerEvents.SERVER_SETTINGS_UPDATE);
    const updatedUserIds = capture.published
      .filter((e) => e.topic === ServerEvents.USER_UPDATE)
      .map((e) => (e.payload as { id: number }).id);
    expect(updatedUserIds).toContain(1);
    expect(updatedUserIds).toContain(2);

    // Same connection, no reconnect: owner powers are live.
    const roleId = await next.caller.roles.add({ serverId: 1 });
    expect(roleId).toBeGreaterThan(0);

    // And the previous owner lost them.
    await expect(
      owner.caller.servers.transferOwner({ serverId: 1, newOwnerId: 1 })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('servers router additions', () => {
  test('servers.update no longer exists (others.updateSettings is the one route)', async () => {
    const procedures = Object.keys(appRouter._def.procedures);
    expect(procedures).not.toContain('servers.update');
    expect(procedures).toContain('others.updateSettings');
  });

  test('delete is owner-only, and the bootstrap server is never deletable', async () => {
    const member = await initTest(2);
    await expect(member.caller.servers.delete({ serverId: 1 })).rejects.toMatchObject({
      code: 'FORBIDDEN'
    });

    const owner = await initTest(1);
    await expect(owner.caller.servers.delete({ serverId: 1 })).rejects.toThrow();

    const extra = await owner.caller.servers.create({ name: 'Disposable' });
    await owner.caller.servers.delete({ serverId: extra.id });
    expect((await owner.caller.servers.getAll()).map((s) => s.id)).not.toContain(extra.id);
  });

  test('reorder moves the caller\'s own list and rejects duplicates', async () => {
    const { caller } = await initTest(1);
    const extra = await caller.servers.create({ name: 'Second' });

    await expect(
      caller.servers.reorder({ serverIds: [extra.id, extra.id] })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await caller.servers.reorder({ serverIds: [extra.id, 1] });
    expect((await caller.servers.getAll()).map((s) => s.id)).toEqual([extra.id, 1]);
  });

  test('getAll lists memberships only; getMembers is member-scoped', async () => {
    const hidden = await createTestServer({ name: 'Hidden', ownerId: 3 });
    await createTestServerMember({ serverId: hidden, userId: 3 });

    const { caller } = await initTest(2);
    expect((await caller.servers.getAll()).map((s) => s.id)).toEqual([1]);

    await expect(caller.servers.getMembers({ serverId: hidden })).rejects.toMatchObject({
      code: 'FORBIDDEN'
    });
    expect((await caller.servers.getMembers({ serverId: 1 })).sort()).toEqual([1, 2, 3]);
  });
});

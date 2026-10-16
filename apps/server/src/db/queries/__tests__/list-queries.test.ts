/**
 * Query-count guards for the list projections that used to be N+1:
 * friends, pending requests, blocked users, the caller's server list,
 * the discover list, and the single public-user lookup. Each test
 * asserts the statement count through the application `db` handle
 * (see __tests__/query-count.ts) alongside the shape of the result.
 *
 * Setup is inline per test (no beforeEach) — see delete-account.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUIDv7 } from 'bun';
import { eq, inArray } from 'drizzle-orm';
import {
  createTestRole,
  createTestServer,
  createTestServerMember,
  createTestUser,
  grantTestUserRole
} from '../../../__tests__/fixtures';
import { getTestDb } from '../../../__tests__/mock-db';
import { countQueries } from '../../../__tests__/query-count';
import {
  federationInstances,
  files,
  friendRequests,
  friendships,
  servers,
  userBlocks,
  users
} from '../../schema';
import { getBlockedUsers } from '../blocks';
import { getFriends, getPendingRequests } from '../friends';
import {
  getDiscoverableServers,
  getServerById,
  getServersByUserId
} from '../servers';
import { getPublicUserById } from '../users';

const insertUsers = async (n: number) => {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) ids.push(await createTestUser());
  return ids;
};

const insertLogo = async () => {
  const [row] = await getTestDb()
    .insert(files)
    .values({
      name: `logo-${randomUUIDv7()}.png`,
      originalName: 'logo.png',
      md5: randomUUIDv7(),
      userId: 1,
      size: 1,
      mimeType: 'image/png',
      extension: 'png',
      createdAt: Date.now()
    })
    .returning();
  return row!;
};

describe('list queries are not N+1', () => {
  test('getFriends: 20 friends in at most 3 statements, roles and avatars resolved', async () => {
    const tdb = getTestDb();
    const friendIds = await insertUsers(20);
    await tdb.insert(friendships).values(
      friendIds.map((friendId, i) =>
        // Both orientations of the pair must be found.
        i % 2 === 0
          ? { userId: 1, friendId, createdAt: Date.now() }
          : { userId: friendId, friendId: 1, createdAt: Date.now() }
      )
    );
    const role = await createTestRole({ serverId: 1, name: 'tagged' });
    await grantTestUserRole(friendIds[0]!, role);
    const avatar = await insertLogo();
    await tdb
      .update(users)
      .set({ avatarId: avatar.id })
      .where(eq(users.id, friendIds[1]!));

    const { result, queries } = await countQueries(() => getFriends(1));

    expect(queries).toBeLessThanOrEqual(3);
    expect(result.map((u) => u.id).sort()).toEqual([...friendIds].sort());
    expect(result.find((u) => u.id === friendIds[0])!.roleIds).toEqual([role]);
    expect(result.find((u) => u.id === friendIds[2])!.roleIds).toEqual([]);
    expect(result.find((u) => u.id === friendIds[1])!.avatar).toEqual({
      id: avatar.id,
      name: avatar.name
    });
  });

  test('getPendingRequests: 10 requests in at most 3 statements', async () => {
    const senders = await insertUsers(10);
    await getTestDb().insert(friendRequests).values(
      senders.map((senderId) => ({
        senderId,
        receiverId: 1,
        status: 'pending',
        createdAt: Date.now()
      }))
    );

    const { result, queries } = await countQueries(() => getPendingRequests(1));

    expect(queries).toBeLessThanOrEqual(3);
    expect(result).toHaveLength(10);
    expect(result.map((r) => r.sender.id).sort()).toEqual([...senders].sort());
    expect(result.every((r) => r.receiver.id === 1)).toBe(true);
  });

  test('getBlockedUsers: 10 blocks in at most 3 statements', async () => {
    const blocked = await insertUsers(10);
    await getTestDb().insert(userBlocks).values(
      blocked.map((blockedUserId) => ({
        blockerId: 1,
        blockedUserId,
        createdAt: Date.now()
      }))
    );

    const { result, queries } = await countQueries(() => getBlockedUsers(1));

    expect(queries).toBeLessThanOrEqual(3);
    expect(result.map((u) => u.id).sort()).toEqual([...blocked].sort());
  });

  test('getPublicUserById is one statement and resolves the federated identity', async () => {
    const tdb = getTestDb();
    const [instance] = await tdb
      .insert(federationInstances)
      .values({
        domain: 'remote.example',
        direction: 'outbound',
        status: 'active',
        createdAt: Date.now()
      })
      .returning();
    const [shadow] = await tdb
      .insert(users)
      .values({
        name: 'remote-friend',
        supabaseId: `fed-${randomUUIDv7()}`,
        publicId: randomUUIDv7(),
        isFederated: true,
        federatedInstanceId: instance!.id,
        createdAt: Date.now()
      })
      .returning();

    const local = await countQueries(() => getPublicUserById(2));
    expect(local.queries).toBe(1);
    expect(local.result!.id).toBe(2);
    expect(local.result!._identity).toBeUndefined();
    // User 2 holds the seeded default role.
    expect(local.result!.roleIds.length).toBeGreaterThan(0);

    const remote = await countQueries(() => getPublicUserById(shadow!.id));
    expect(remote.queries).toBe(1);
    expect(remote.result!._identity).toBe('remote-friend@remote.example');

    expect((await countQueries(() => getPublicUserById(999_999))).result).toBeUndefined();
  });

  test('getServersByUserId: logo and member count ride in one statement', async () => {
    const tdb = getTestDb();
    const extra: number[] = [];
    for (let i = 0; i < 4; i++) {
      const id = await createTestServer({ ownerId: 1 });
      await createTestServerMember({ serverId: id, userId: 1, position: i + 1 });
      extra.push(id);
    }
    await createTestServerMember({ serverId: extra[0]!, userId: 2 });
    const logo = await insertLogo();
    await tdb
      .update(servers)
      .set({ logoId: logo.id })
      .where(eq(servers.id, extra[1]!));

    const { result, queries } = await countQueries(() => getServersByUserId(1));

    expect(queries).toBe(1);
    expect(result.map((s) => s.id)).toEqual([1, ...extra]);
    expect(result[0]!.memberCount).toBe(3);
    expect(result.find((s) => s.id === extra[0])!.memberCount).toBe(2);
    expect(result.find((s) => s.id === extra[1])!.logo?.name).toBe(logo.name);
    expect(result.find((s) => s.id === extra[2])!.logo).toBeNull();
  });

  test('getDiscoverableServers: joined flag, counts, password flag in one statement', async () => {
    const tdb = getTestDb();
    const other = await createTestServer({ ownerId: 1 });
    await createTestServerMember({ serverId: other, userId: 1 });
    await tdb
      .update(servers)
      .set({ discoverable: true })
      .where(inArray(servers.id, [1, other]));
    await tdb
      .update(servers)
      .set({ password: 'hunter2' })
      .where(eq(servers.id, other));

    const { result, queries } = await countQueries(() =>
      getDiscoverableServers(2)
    );

    expect(queries).toBe(1);
    const byId = new Map(result.map((s) => [s.id, s]));
    expect(byId.get(1)).toMatchObject({ joined: true, memberCount: 3, hasPassword: false });
    expect(byId.get(other)).toMatchObject({ joined: false, memberCount: 1, hasPassword: true });
  });

  test('getServerById joins the logo in one statement', async () => {
    const logo = await insertLogo();
    await getTestDb()
      .update(servers)
      .set({ logoId: logo.id })
      .where(eq(servers.id, 1));

    const { result, queries } = await countQueries(() => getServerById(1));

    expect(queries).toBe(1);
    expect(result!.logo?.id).toBe(logo.id);
    expect((await countQueries(() => getServerById(999_999))).result).toBeUndefined();
  });
});

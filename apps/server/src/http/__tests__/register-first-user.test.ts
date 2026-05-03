import { OWNER_ROLE_ID } from '@pulse/shared';
import { beforeEach, describe, expect, test } from 'bun:test';
import { and, eq, gt } from 'drizzle-orm';
import { login } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { serverMembers, servers, userRoles, users } from '../../db/schema';

const BOOTSTRAP_SERVER_ID = 1;

/**
 * Reset the bootstrap server back to "no owner" state so the next-registered
 * user qualifies as the first user. The setup.ts beforeEach has already
 * truncated everything and reseeded a Test Owner — we leave seeded rows
 * alone (truncating users with CASCADE would blow away the bootstrap
 * server itself via the owner_id FK), and only clear the owner-claim
 * markers so the unclaimed-server path is exercised.
 */
async function unclaimBootstrapServer() {
  const tdb = getTestDb();

  await tdb.update(servers).set({ ownerId: null }).where(eq(servers.id, BOOTSTRAP_SERVER_ID));
  await tdb.delete(userRoles).where(eq(userRoles.roleId, OWNER_ROLE_ID));
}

/**
 * Snapshot the highest existing user id so test assertions can ignore
 * seeded users (TestOwner, TestUser, TestUser2) and only reason about
 * the users created by the test's own `login` calls.
 */
async function maxExistingUserId(): Promise<number> {
  const tdb = getTestDb();
  const rows = await tdb.select({ id: users.id }).from(users);
  return rows.reduce((m, r) => (r.id > m ? r.id : m), 0);
}

describe('first-user-becomes-owner registration', () => {
  beforeEach(async () => {
    await unclaimBootstrapServer();
  });

  test('first registered user is granted ownership of server 1', async () => {
    const tdb = getTestDb();
    const baseline = await maxExistingUserId();

    const response = await login('firstuser@pulse.local', 'password123');
    expect(response.status).toBe(200);

    const [user] = await tdb
      .select()
      .from(users)
      .where(eq(users.name, 'firstuser'))
      .limit(1);
    expect(user).toBeDefined();
    expect(user!.id).toBeGreaterThan(baseline);

    const [server] = await tdb
      .select({ ownerId: servers.ownerId })
      .from(servers)
      .where(eq(servers.id, BOOTSTRAP_SERVER_ID))
      .limit(1);
    expect(server?.ownerId).toBe(user!.id);

    const [membership] = await tdb
      .select()
      .from(serverMembers)
      .where(
        and(
          eq(serverMembers.serverId, BOOTSTRAP_SERVER_ID),
          eq(serverMembers.userId, user!.id)
        )
      )
      .limit(1);
    expect(membership).toBeDefined();

    const ownerRole = await tdb
      .select()
      .from(userRoles)
      .where(
        and(
          eq(userRoles.userId, user!.id),
          eq(userRoles.roleId, OWNER_ROLE_ID)
        )
      )
      .limit(1);
    expect(ownerRole.length).toBe(1);
  });

  test('second registered user does not get ownership', async () => {
    const tdb = getTestDb();

    const firstResponse = await login('firstuser@pulse.local', 'password123');
    expect(firstResponse.status).toBe(200);

    const [firstUser] = await tdb
      .select()
      .from(users)
      .where(eq(users.name, 'firstuser'))
      .limit(1);
    expect(firstUser).toBeDefined();

    const secondResponse = await login('seconduser@pulse.local', 'password123');
    expect(secondResponse.status).toBe(200);

    const [secondUser] = await tdb
      .select()
      .from(users)
      .where(eq(users.name, 'seconduser'))
      .limit(1);
    expect(secondUser).toBeDefined();

    const [server] = await tdb
      .select({ ownerId: servers.ownerId })
      .from(servers)
      .where(eq(servers.id, BOOTSTRAP_SERVER_ID))
      .limit(1);
    expect(server?.ownerId).toBe(firstUser!.id);

    const secondUserOwnerRole = await tdb
      .select()
      .from(userRoles)
      .where(
        and(
          eq(userRoles.userId, secondUser!.id),
          eq(userRoles.roleId, OWNER_ROLE_ID)
        )
      )
      .limit(1);
    expect(secondUserOwnerRole.length).toBe(0);

    const secondMembership = await tdb
      .select()
      .from(serverMembers)
      .where(
        and(
          eq(serverMembers.serverId, BOOTSTRAP_SERVER_ID),
          eq(serverMembers.userId, secondUser!.id)
        )
      )
      .limit(1);
    expect(secondMembership.length).toBe(0);
  });

  test('concurrent first registrations: only one wins ownership', async () => {
    const tdb = getTestDb();
    const baseline = await maxExistingUserId();

    const [a, b, c] = await Promise.all([
      login('racea@pulse.local', 'password123'),
      login('raceb@pulse.local', 'password123'),
      login('racec@pulse.local', 'password123')
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(c.status).toBe(200);

    const [server] = await tdb
      .select({ ownerId: servers.ownerId })
      .from(servers)
      .where(eq(servers.id, BOOTSTRAP_SERVER_ID))
      .limit(1);
    expect(server?.ownerId).toBeDefined();
    expect(server!.ownerId).toBeGreaterThan(baseline);

    // Only the user that won the race should hold OWNER_ROLE_ID. Filter
    // by id > baseline so seeded users are excluded — `unclaimBootstrapServer`
    // already cleared seeded OWNER_ROLE_ID grants, but be explicit.
    const newOwners = await tdb
      .select()
      .from(userRoles)
      .where(
        and(eq(userRoles.roleId, OWNER_ROLE_ID), gt(userRoles.userId, baseline))
      );
    expect(newOwners.length).toBe(1);
    expect(newOwners[0]!.userId).toBe(server!.ownerId!);
  });
});

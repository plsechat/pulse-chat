import { OWNER_ROLE_ID } from '@pulse/shared';
import { beforeEach, describe, expect, test } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { login } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { serverMembers, servers, userRoles, users } from '../../db/schema';

const BOOTSTRAP_SERVER_ID = 1;

/**
 * Reset the bootstrap server back to "no owner" state so the next-registered
 * user qualifies as the first user. The `beforeEach` test seed creates a Test
 * Owner already, so we wipe it here to exercise the unclaimed-server path.
 */
async function unclaimBootstrapServer() {
  const tdb = getTestDb();

  // Wipe everything that references users/roles for server 1 so the FKs
  // don't block the users TRUNCATE below. The setup.ts beforeEach has
  // already truncated and re-seeded; this is per-test surgical cleanup.
  await tdb.execute(sql`TRUNCATE TABLE
    server_members,
    user_roles,
    users
    RESTART IDENTITY CASCADE`);

  await tdb
    .update(servers)
    .set({ ownerId: null })
    .where(eq(servers.id, BOOTSTRAP_SERVER_ID));
}

describe('first-user-becomes-owner registration', () => {
  beforeEach(async () => {
    await unclaimBootstrapServer();
  });

  test('first registered user is granted ownership of server 1', async () => {
    const tdb = getTestDb();

    const response = await login('firstuser@pulse.local', 'password123');
    expect(response.status).toBe(200);

    const [user] = await tdb
      .select()
      .from(users)
      .where(eq(users.name, 'firstuser'))
      .limit(1);
    expect(user).toBeDefined();

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

    const owners = await tdb
      .select()
      .from(userRoles)
      .where(eq(userRoles.roleId, OWNER_ROLE_ID));
    expect(owners.length).toBe(1);
    expect(owners[0]!.userId).toBe(server!.ownerId!);
  });
});

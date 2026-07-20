import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { channels, roles, userRoles } from '../../db/schema';

/**
 * Owner-role lockdown + mod-view cross-server scoping. Seeded user 1 owns
 * server 1; user 2 is a plain member of it.
 */
describe('owner role security', () => {
  test('the owner role cannot be granted or removed via role routes', async () => {
    await initTest(2);
    const { caller } = await initTest(1);

    // Server 1's owner role is id 1 (bootstrap). add-role has a dedicated
    // id guard; remove-role relies on the capability guard (persistent +
    // non-default) — both must refuse.
    await expect(
      caller.users.addRole({ userId: 2, roleId: 1 })
    ).rejects.toThrow();
    await expect(
      caller.users.removeRole({ userId: 1, roleId: 1 })
    ).rejects.toThrow('ownership transfer');
  });

  test('transferOwner moves the owner ROLE to the new owner', async () => {
    const { caller: owner } = await initTest(1);
    const server2 = await owner.servers.create({ name: 'Transfer Test' });
    await owner.invites.add({ serverId: server2.id, code: 'xfer-invite' });

    const { caller: member } = await initTest(2);
    await member.servers.join({ inviteCode: 'xfer-invite' });

    await owner.servers.transferOwner({
      serverId: server2.id,
      newOwnerId: 2
    });

    const tdb = getTestDb();
    const [ownerRole] = await tdb
      .select({ id: roles.id })
      .from(roles)
      .where(
        and(
          eq(roles.serverId, server2.id),
          eq(roles.isPersistent, true),
          eq(roles.isDefault, false)
        )
      )
      .limit(1);
    expect(ownerRole).toBeDefined();

    const holders = await tdb
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(eq(userRoles.roleId, ownerRole!.id));
    const holderIds = holders.map((h) => h.userId);
    expect(holderIds).toContain(2);
    expect(holderIds).not.toContain(1);
  });

  test('mod view listings are scoped to the active server', async () => {
    await initTest(2);
    const { caller } = await initTest(1);

    const tdb = getTestDb();

    // A message from user 2 in the ACTIVE server (1)…
    await tdb.insert(await import('../../db/schema').then((m) => m.messages)).values({
      content: 'visible-in-server-1',
      userId: 2,
      channelId: 1,
      createdAt: Date.now()
    });

    // …and one in a DIFFERENT server the mod is not viewing.
    const server2 = await caller.servers.create({ name: 'Other Server' });
    const [otherChannel] = await tdb
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.serverId, server2.id), eq(channels.type, 'TEXT')))
      .limit(1);
    expect(otherChannel).toBeDefined();
    await tdb.insert(await import('../../db/schema').then((m) => m.messages)).values({
      content: 'MUST-NOT-LEAK-from-server-2',
      userId: 2,
      channelId: otherChannel!.id,
      createdAt: Date.now()
    });

    const info = await caller.users.getInfo({ userId: 2 });
    const contents = info.messages.map((m) => m.content);
    expect(contents).toContain('visible-in-server-1');
    expect(contents).not.toContain('MUST-NOT-LEAK-from-server-2');
  });
});

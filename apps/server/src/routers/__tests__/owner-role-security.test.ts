import { Permission } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import path from 'node:path';
import { createTestRole } from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { channels, rolePermissions, roles, userRoles } from '../../db/schema';

/** The backfill statement exactly as migration 0043 ships it. */
const ownerBackfillSql = async () => {
  const file = path.join(
    import.meta.dir,
    '../../db/migrations/0043_planner_switch_owner_permissions.sql'
  );
  const statements = (await Bun.file(file).text()).split('--> statement-breakpoint');
  const insert = statements.find((s) => s.includes('INSERT INTO "role_permissions"'));
  if (!insert) throw new Error('migration 0043 lost its owner backfill');
  return insert;
};

const permissionsOf = async (roleId: number) =>
  (
    await getTestDb()
      .select({ permission: rolePermissions.permission })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, roleId))
  ).map((row) => row.permission);

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

  test('migration 0043 gives every owner role the permissions added after it was created', async () => {
    const tdb = getTestDb();
    const { caller: owner } = await initTest(1);
    const created = await owner.servers.create({ name: 'Old guild' });
    const [guildOwnerRole] = await tdb
      .select()
      .from(roles)
      .where(
        and(eq(roles.serverId, created.id), eq(roles.isPersistent, true), eq(roles.isDefault, false))
      );
    const [guildMemberRole] = await tdb
      .select()
      .from(roles)
      .where(and(eq(roles.serverId, created.id), eq(roles.isDefault, true)));
    const customRole = await createTestRole({
      serverId: created.id,
      name: 'Raider',
      permissions: [Permission.SEND_MESSAGES]
    });

    // A community created before MANAGE_EVENTS / MANAGE_SOUNDS existed:
    // its owner role never got them and update-role refuses to add them.
    const added = [Permission.MANAGE_EVENTS, Permission.MANAGE_SOUNDS, Permission.USE_SOUNDBOARD];
    for (const roleId of [1, guildOwnerRole!.id]) {
      await tdb
        .delete(rolePermissions)
        .where(and(eq(rolePermissions.roleId, roleId), inArray(rolePermissions.permission, added)));
      expect(await permissionsOf(roleId)).not.toContain(Permission.MANAGE_EVENTS);
    }

    const statement = await ownerBackfillSql();
    await tdb.execute(sql.raw(statement));
    // Replay-safe: CI applies every migration twice.
    await tdb.execute(sql.raw(statement));

    const all = Object.values(Permission).sort();
    expect((await permissionsOf(1)).sort()).toEqual(all);
    expect((await permissionsOf(guildOwnerRole!.id)).sort()).toEqual(all);
    // Only owner roles: the default role and a custom role are left alone.
    expect(await permissionsOf(guildMemberRole!.id)).not.toContain(Permission.MANAGE_EVENTS);
    expect(await permissionsOf(customRole)).toEqual([Permission.SEND_MESSAGES]);

    // Hand-check that the migration's list is the full enum, so the next
    // permission added without extending it fails here, not in the field.
    const listed = [...statement.matchAll(/\('([A-Z_]+)'\)/g)].map((m) => m[1]).sort();
    expect(listed).toEqual(all);
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

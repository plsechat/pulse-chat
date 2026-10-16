import { Permission } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  createTestRole,
  createTestServer,
  createTestServerMember,
  createTestUser,
  grantTestUserRole
} from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { roles, userRoles } from '../../db/schema';
import { getUserRoles } from '../users/get-user-roles';

const OWNER_ROLE = 1;
const DEFAULT_ROLE = 2;
const GUEST_ROLE = 3;

const setPosition = (roleId: number, position: number) =>
  getTestDb().update(roles).set({ position }).where(eq(roles.id, roleId));

/**
 * Server 1 hierarchy: Owner(10) > Admin(7) > Moderator(5) > Guest(1) >
 * Member/default(0). User 2 holds Moderator (MANAGE_ROLES + MANAGE_USERS).
 */
const seedHierarchy = async (modPermissions: Permission[] = [
  Permission.MANAGE_ROLES,
  Permission.MANAGE_USERS
]) => {
  await setPosition(OWNER_ROLE, 10);
  await setPosition(DEFAULT_ROLE, 0);
  await setPosition(GUEST_ROLE, 1);

  const modRoleId = await createTestRole({
    serverId: 1,
    name: 'Moderator',
    permissions: modPermissions
  });
  await setPosition(modRoleId, 5);

  const adminRoleId = await createTestRole({
    serverId: 1,
    name: 'Admin',
    permissions: [Permission.MANAGE_ROLES, Permission.MANAGE_CHANNELS]
  });
  await setPosition(adminRoleId, 7);

  await grantTestUserRole(2, modRoleId);

  return { modRoleId, adminRoleId };
};

const positionOf = async (roleId: number) => {
  const [row] = await getTestDb()
    .select({ position: roles.position })
    .from(roles)
    .where(eq(roles.id, roleId));
  return row!.position;
};

describe('role hierarchy', () => {
  test('a MANAGE_ROLES holder cannot widen their own role', async () => {
    const { modRoleId } = await seedHierarchy([Permission.MANAGE_ROLES]);
    const { caller } = await initTest(2);

    await expect(
      caller.roles.update({
        roleId: modRoleId,
        name: 'Moderator',
        color: '#ffffff',
        permissions: [Permission.MANAGE_ROLES, Permission.MANAGE_USERS]
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const [row] = await getUserRoles(2, 1).then((r) =>
      r.filter((x) => x.id === modRoleId)
    );
    expect(row!.permissions).toEqual([Permission.MANAGE_ROLES]);
  });

  test('a role below the ceiling may only receive permissions the caller holds', async () => {
    await seedHierarchy([Permission.MANAGE_ROLES]);
    const { caller } = await initTest(2);

    await expect(
      caller.roles.update({
        roleId: GUEST_ROLE,
        name: 'Guest',
        color: '#ffffff',
        permissions: [Permission.MANAGE_USERS]
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await caller.roles.update({
      roleId: GUEST_ROLE,
      name: 'Guest+',
      color: '#ffffff',
      permissions: [Permission.MANAGE_ROLES]
    });

    const all = await caller.roles.getAll({ serverId: 1 });
    const guest = all.find((r) => r.id === GUEST_ROLE)!;
    expect(guest.name).toBe('Guest+');
    expect(guest.permissions).toEqual([Permission.MANAGE_ROLES]);
    expect(typeof guest.position).toBe('number');
  });

  test('roles at or above the ceiling cannot be edited or deleted', async () => {
    const { adminRoleId } = await seedHierarchy();
    const { caller } = await initTest(2);

    for (const roleId of [adminRoleId, OWNER_ROLE]) {
      await expect(
        caller.roles.update({
          roleId,
          name: 'x',
          color: '#000000',
          permissions: []
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }

    await expect(
      caller.roles.delete({ roleId: adminRoleId })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Below the ceiling: fine.
    await caller.roles.delete({ roleId: GUEST_ROLE });
    const all = await caller.roles.getAll({ serverId: 1 });
    expect(all.find((r) => r.id === GUEST_ROLE)).toBeUndefined();
  });

  test('reorder only moves the roles below the ceiling and compacts positions', async () => {
    const { modRoleId, adminRoleId } = await seedHierarchy();
    const { caller } = await initTest(2);

    // Trying to include a role above the ceiling is refused.
    await expect(
      caller.roles.reorder({ orderedRoleIds: [adminRoleId, GUEST_ROLE, DEFAULT_ROLE] })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Listing only a subset of the movable roles is refused too.
    await expect(
      caller.roles.reorder({ orderedRoleIds: [GUEST_ROLE] })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await expect(
      caller.roles.reorder({ orderedRoleIds: [GUEST_ROLE, GUEST_ROLE] })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    // Put the default role above Guest.
    await caller.roles.reorder({ orderedRoleIds: [DEFAULT_ROLE, GUEST_ROLE] });

    expect(await positionOf(GUEST_ROLE)).toBe(1);
    expect(await positionOf(DEFAULT_ROLE)).toBe(2);
    expect(await positionOf(modRoleId)).toBe(3);
    expect(await positionOf(adminRoleId)).toBe(4);
    expect(await positionOf(OWNER_ROLE)).toBe(5);
  });

  test('the server owner bypasses the ceiling; the owner role stays on top', async () => {
    const { modRoleId, adminRoleId } = await seedHierarchy();
    const { caller } = await initTest(1);

    await caller.roles.update({
      roleId: adminRoleId,
      name: 'Admin',
      color: '#123456',
      permissions: Object.values(Permission)
    });

    await caller.roles.reorder({
      orderedRoleIds: [GUEST_ROLE, modRoleId, adminRoleId, DEFAULT_ROLE]
    });

    expect(await positionOf(DEFAULT_ROLE)).toBe(1);
    expect(await positionOf(adminRoleId)).toBe(2);
    expect(await positionOf(modRoleId)).toBe(3);
    expect(await positionOf(GUEST_ROLE)).toBe(4);
    expect(await positionOf(OWNER_ROLE)).toBe(5);

    // The owner role is never part of the movable set.
    await expect(
      caller.roles.reorder({
        orderedRoleIds: [OWNER_ROLE, GUEST_ROLE, modRoleId, adminRoleId, DEFAULT_ROLE]
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('roles.add inserts directly below the caller\'s highest role', async () => {
    const { modRoleId, adminRoleId } = await seedHierarchy();

    const mod = await initTest(2);
    const newByMod = await mod.caller.roles.add({ serverId: 1 });
    expect(await positionOf(newByMod)).toBe(5);
    expect(await positionOf(modRoleId)).toBe(6);
    expect(await positionOf(adminRoleId)).toBe(8);
    expect(await positionOf(OWNER_ROLE)).toBe(11);

    // Inside the ceiling, so the creator can edit it.
    await mod.caller.roles.update({
      roleId: newByMod,
      name: 'Helper',
      color: '#00ff00',
      permissions: [Permission.MANAGE_USERS]
    });

    const owner = await initTest(1);
    const newByOwner = await owner.caller.roles.add({ serverId: 1 });
    const ownerPos = await positionOf(OWNER_ROLE);
    expect(await positionOf(newByOwner)).toBe(ownerPos - 1);
    expect(ownerPos).toBeGreaterThan(await positionOf(adminRoleId));
  });

  test('users.addRole / removeRole respect the ceiling and membership', async () => {
    const { adminRoleId } = await seedHierarchy();
    const { caller } = await initTest(2);

    await expect(
      caller.users.addRole({ userId: 3, roleId: adminRoleId })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const outsider = await createTestUser({ name: 'outsider' });
    await expect(
      caller.users.addRole({ userId: outsider, roleId: GUEST_ROLE })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await caller.users.addRole({ userId: 3, roleId: GUEST_ROLE });
    expect((await getUserRoles(3, 1)).map((r) => r.id)).toContain(GUEST_ROLE);

    await grantTestUserRole(3, adminRoleId);
    await expect(
      caller.users.removeRole({ userId: 3, roleId: adminRoleId })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await caller.users.removeRole({ userId: 3, roleId: GUEST_ROLE });
    expect((await getUserRoles(3, 1)).map((r) => r.id)).not.toContain(GUEST_ROLE);
  });

  test('setDefault requires the role to be at or below the ceiling and never the owner role', async () => {
    const { adminRoleId } = await seedHierarchy();
    const mod = await initTest(2);

    await expect(
      mod.caller.roles.setDefault({ roleId: adminRoleId })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await mod.caller.roles.setDefault({ roleId: GUEST_ROLE });
    const all = await mod.caller.roles.getAll({ serverId: 1 });
    expect(all.find((r) => r.id === GUEST_ROLE)!.isDefault).toBe(true);
    expect(all.find((r) => r.id === DEFAULT_ROLE)!.isDefault).toBe(false);

    const owner = await initTest(1);
    await expect(
      owner.caller.roles.setDefault({ roleId: OWNER_ROLE })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('default role is server-scoped', () => {
  /** A second server owned by user 1 with its own default role + one custom role. */
  const createServerB = async () => {
    const serverB = await createTestServer({ name: 'Server B', ownerId: 1 });
    await createTestServerMember({ serverId: serverB, userId: 1 });
    const defaultB = await createTestRole({
      serverId: serverB,
      name: 'B Member',
      isPersistent: true,
      isDefault: true,
      permissions: [Permission.SEND_MESSAGES]
    });
    const customB = await createTestRole({ serverId: serverB, name: 'B Custom' });
    return { serverB, defaultB, customB };
  };

  const activate = async (caller: Awaited<ReturnType<typeof initTest>>['caller'], serverId: number) => {
    const { handshakeHash } = await caller.others.handshake();
    await caller.others.joinServer({ handshakeHash, serverId });
  };

  test('setDefault in server B leaves server A\'s default untouched', async () => {
    const { serverB, defaultB, customB } = await createServerB();
    const { caller } = await initTest(1);
    await activate(caller, serverB);

    await caller.roles.setDefault({ roleId: customB });

    const rows = await getTestDb()
      .select({ id: roles.id, isDefault: roles.isDefault })
      .from(roles);
    const byId = new Map(rows.map((r) => [r.id, r.isDefault]));
    expect(byId.get(DEFAULT_ROLE)).toBe(true);
    expect(byId.get(defaultB)).toBe(false);
    expect(byId.get(customB)).toBe(true);
  });

  test('deleteRole in server B falls users back to B\'s default only', async () => {
    const { serverB, defaultB, customB } = await createServerB();
    const member = await createTestUser({ name: 'b-only' });
    await createTestServerMember({ serverId: serverB, userId: member });
    await grantTestUserRole(member, customB);

    const { caller } = await initTest(1);
    await activate(caller, serverB);

    await caller.roles.delete({ roleId: customB });

    const held = await getTestDb()
      .select({ roleId: userRoles.roleId })
      .from(userRoles)
      .where(eq(userRoles.userId, member));
    expect(held.map((r) => r.roleId)).toEqual([defaultB]);
  });
});

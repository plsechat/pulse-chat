import { describe, expect, test } from 'bun:test';
import { initTest } from '../../__tests__/helpers';

describe('invites router', () => {
  test('should throw when user lacks permissions (getAll)', async () => {
    const { caller } = await initTest(2);

    await expect(caller.invites.getAll({ serverId: 1 })).rejects.toThrow(
      'Insufficient permissions'
    );
  });

  test('should throw when user lacks permissions (add)', async () => {
    const { caller } = await initTest(2);

    await expect(
      caller.invites.add({
        serverId: 1,
        maxUses: 10
      })
    ).rejects.toThrow('Insufficient permissions');
  });

  test('should throw when user lacks permissions (delete)', async () => {
    const { caller } = await initTest(2);

    await expect(
      caller.invites.delete({
        inviteId: 1
      })
    ).rejects.toThrow('Insufficient permissions');
  });

  test('should get all invites', async () => {
    const { caller } = await initTest();

    const invites = await caller.invites.getAll({ serverId: 1 });

    expect(invites).toBeDefined();
    expect(Array.isArray(invites)).toBe(true);
  });

  test('expiresAt 0 means "never expires" (what the client sends)', async () => {
    const { caller } = await initTest();
    const before = (await caller.invites.getAll({ serverId: 1 })).length;

    await caller.invites.add({ serverId: 1, expiresAt: 0, maxUses: 0 });

    const invites = await caller.invites.getAll({ serverId: 1 });
    expect(invites.length).toBe(before + 1);
    expect(invites[invites.length - 1]!.expiresAt).toBeNull();
  });

  test('should create new invite with default values', async () => {
    const { caller } = await initTest();

    await caller.invites.add({ serverId: 1 });

    const invites = await caller.invites.getAll({ serverId: 1 });

    expect(invites.length).toBeGreaterThan(0);

    const newInvite = invites[invites.length - 1];
    expect(newInvite).toBeDefined();
    expect(newInvite!.code).toBeDefined();
    expect(newInvite!.code.length).toBeGreaterThan(0);
    expect(newInvite!.maxUses).toBeNull();
    expect(newInvite!.uses).toBe(0);
    expect(newInvite!.expiresAt).toBeNull();
  });

  test('should create new invite with custom maxUses', async () => {
    const { caller } = await initTest();

    await caller.invites.add({
      serverId: 1,
      maxUses: 5
    });

    const invites = await caller.invites.getAll({ serverId: 1 });
    const newInvite = invites[invites.length - 1];

    expect(newInvite).toBeDefined();
    expect(newInvite!.maxUses).toBe(5);
  });

  test('should create new invite with custom code', async () => {
    const { caller } = await initTest();

    await caller.invites.add({
      serverId: 1,
      code: 'custom-code-123'
    });

    const invites = await caller.invites.getAll({ serverId: 1 });
    const newInvite = invites.find((i) => i.code === 'custom-code-123');

    expect(newInvite).toBeDefined();
    expect(newInvite?.code).toBe('custom-code-123');
  });

  test('should create new invite with expiration', async () => {
    const { caller } = await initTest();

    const expiresAt = Date.now() + 86400000; // 1 day from now

    await caller.invites.add({
      serverId: 1,
      expiresAt
    });

    const invites = await caller.invites.getAll({ serverId: 1 });
    const newInvite = invites[invites.length - 1];

    expect(newInvite).toBeDefined();
    expect(newInvite!.expiresAt).toBe(expiresAt);
  });

  test('should throw error when creating invite with duplicate code', async () => {
    const { caller } = await initTest();

    await caller.invites.add({
      serverId: 1,
      code: 'duplicate-code'
    });

    await expect(
      caller.invites.add({
        serverId: 1,
        code: 'duplicate-code'
      })
    ).rejects.toThrow('An invite with this code already exists');
  });

  test('should delete existing invite', async () => {
    const { caller } = await initTest();

    await caller.invites.add({
      serverId: 1,
      code: 'to-be-deleted'
    });

    const invitesBefore = await caller.invites.getAll({ serverId: 1 });
    const inviteToDelete = invitesBefore.find(
      (i) => i.code === 'to-be-deleted'
    );

    expect(inviteToDelete).toBeDefined();

    await caller.invites.delete({
      inviteId: inviteToDelete!.id
    });

    const invitesAfter = await caller.invites.getAll({ serverId: 1 });
    const deletedInvite = invitesAfter.find((i) => i.code === 'to-be-deleted');

    expect(deletedInvite).toBeUndefined();
  });

  test('should throw error when deleting non-existing invite', async () => {
    const { caller } = await initTest();

    await expect(
      caller.invites.delete({
        inviteId: 999999
      })
    ).rejects.toThrow('Invite not found');
  });

  test('should create multiple invites', async () => {
    const { caller } = await initTest();

    const initialInvites = await caller.invites.getAll({ serverId: 1 });
    const initialCount = initialInvites.length;

    await caller.invites.add({ serverId: 1, code: 'invite-1' });
    await caller.invites.add({ serverId: 1, code: 'invite-2' });
    await caller.invites.add({ serverId: 1, code: 'invite-3' });

    const finalInvites = await caller.invites.getAll({ serverId: 1 });

    expect(finalInvites.length).toBe(initialCount + 3);
  });
});

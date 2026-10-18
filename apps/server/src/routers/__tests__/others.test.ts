import {
  Permission,
  ServerEvents,
  STORAGE_MAX_FILE_SIZE,
  STORAGE_MAX_QUOTA_PER_USER,
  STORAGE_OVERFLOW_ACTION,
  type TTempFile
} from '@pulse/shared';
import { describe, expect, spyOn, test } from 'bun:test';
import { createTestRole, grantTestUserRole } from '../../__tests__/fixtures';
import {
  getCaller,
  initTest,
  login,
  uploadFile
} from '../../__tests__/helpers';
import { pubsub } from '../../utils/pubsub';

describe('others router', () => {
  test('should throw when user tries to join with no handshake', async () => {
    const { caller } = await getCaller(1);

    await expect(
      caller.others.joinServer({
        handshakeHash: ''
      })
    ).rejects.toThrow('Invalid handshake hash');
  });

  test('should allow user to join with valid handshake', async () => {
    const joiningUserId = 1;

    const { caller } = await getCaller(joiningUserId);
    const { handshakeHash } = await caller.others.handshake();

    const result = await caller.others.joinServer({
      handshakeHash
    });

    expect(result).toHaveProperty('categories');
    expect(result).toHaveProperty('channels');
    expect(result).toHaveProperty('serverId');
    expect(result).toHaveProperty('serverName');
    expect(result).toHaveProperty('ownUserId');
    expect(result).toHaveProperty('roles');
    expect(result).toHaveProperty('channelPermissions');

    // Users, emojis, and voice state are now fetched separately via deferred endpoints
    expect(result).not.toHaveProperty('users');
    expect(result).not.toHaveProperty('emojis');
    expect(result).not.toHaveProperty('voiceMap');

    expect(result.ownUserId).toBe(joiningUserId);
  });

  test('handshake should not include hasPassword', async () => {
    const { caller } = await initTest(1);

    await caller.others.updateSettings({ serverId: 1, password: 'testpassword' });

    const result = await caller.others.handshake();
    expect(result).not.toHaveProperty('hasPassword');
    expect(result).toHaveProperty('handshakeHash');

    // Clean up
    await caller.others.updateSettings({ serverId: 1, password: null });
  });

  test('should allow existing member to join without password even if server has one', async () => {
    const { caller } = await initTest(1);

    await caller.others.updateSettings({ serverId: 1, password: 'testpassword' });

    const { handshakeHash } = await caller.others.handshake();
    const result = await caller.others.joinServer({ handshakeHash });

    expect(result).toHaveProperty('categories');
    expect(result).toHaveProperty('channels');

    // Clean up
    await caller.others.updateSettings({ serverId: 1, password: null });
  });

  test('should update server settings', async () => {
    const { caller } = await initTest(1);

    const newSettings = {
      name: 'Updated Test Server',
      description: 'An updated description',
      allowNewUsers: false,
      storageUploadEnabled: false
    };

    await caller.others.updateSettings({ serverId: 1, ...newSettings });

    const settings = await caller.others.getSettings({ serverId: 1 });

    expect(settings.name).toBe(newSettings.name);
    expect(settings.description).toBe(newSettings.description);
    expect(settings.allowNewUsers).toBe(newSettings.allowNewUsers);
    expect(settings.storageUploadEnabled).toBe(
      newSettings.storageUploadEnabled
    );
  });

  test('the whole General form saves for a non-owner admin holding MANAGE_SETTINGS', async () => {
    await initTest(1);
    const { caller: admin } = await initTest(2);
    const roleId = await createTestRole({
      serverId: 1,
      name: 'Admin',
      permissions: [Permission.MANAGE_SETTINGS]
    });
    await grantTestUserRole(2, roleId);

    // Every field the General screen sends on Save, with the values the
    // form holds after a plain load (federatable unchanged, no card).
    const form = {
      serverId: 1,
      name: 'Renamed by admin',
      description: 'x'.repeat(128),
      allowNewUsers: true,
      enablePlugins: false,
      enableEvents: true,
      discoverable: false,
      federatable: false,
      directoryListed: false,
      directoryDescription: '',
      directoryTags: [] as string[],
      directoryGame: '',
      storageUploadEnabled: true,
      storageUploadMaxFileSize: STORAGE_MAX_FILE_SIZE,
      storageSpaceQuotaByUser: STORAGE_MAX_QUOTA_PER_USER,
      storageOverflowAction: STORAGE_OVERFLOW_ACTION
    };
    await admin.others.updateSettings(form);
    const saved = await admin.others.getSettings({ serverId: 1 });
    expect(saved.name).toBe('Renamed by admin');
    expect(saved.description).toHaveLength(128);

    // What such an admin can still trip on: the bounds the form must
    // surface instead of swallowing.
    await expect(
      admin.others.updateSettings({ ...form, description: 'x'.repeat(129) })
    ).rejects.toThrow();
    await expect(admin.others.updateSettings({ ...form, name: 'x' })).rejects.toThrow();
    await expect(
      admin.others.updateSettings({ ...form, federatable: true })
    ).rejects.toThrow('Only the server owner');
    await expect(
      admin.others.updateSettings({ ...form, directoryListed: true })
    ).rejects.toThrow('must be discoverable');
  });

  test('the Planner switch round-trips and reaches members live', async () => {
    const { caller } = await initTest(1);
    const { caller: member } = await initTest(2);
    expect((await caller.others.getSettings({ serverId: 1 })).enableEvents).toBe(true);

    const spy = spyOn(pubsub, 'publishFor');
    try {
      await caller.others.updateSettings({ serverId: 1, enableEvents: false });
      const settings = spy.mock.calls.filter(
        ([, topic]) => topic === ServerEvents.SERVER_SETTINGS_UPDATE
      );
      expect(settings).toHaveLength(1);
      expect([...(settings[0]![0] as number[])].sort()).toEqual([1, 2, 3]);
      expect(settings[0]![2]).toMatchObject({ id: 1, enableEvents: false });
    } finally {
      spy.mockRestore();
    }
    expect((await caller.others.getSettings({ serverId: 1 })).enableEvents).toBe(false);
    await expect(member.events.templates.list()).rejects.toThrow('Planner is turned off');

    await caller.others.updateSettings({ serverId: 1, enableEvents: true });
    expect((await caller.others.getSettings({ serverId: 1 })).enableEvents).toBe(true);
    expect(await member.events.templates.list()).toEqual([]);
  });

  test('should change logo', async () => {
    const { caller } = await initTest(1);

    const response = await login('testowner', 'password123');
    const { accessToken: token } = (await response.json()) as { accessToken: string };

    const logoFile = new File(['logo content'], 'logo.png', {
      type: 'image/png'
    });

    const uploadResponse = await uploadFile(logoFile, token);
    const tempFile = (await uploadResponse.json()) as TTempFile;

    expect(tempFile).toBeDefined();
    expect(tempFile.id).toBeDefined();

    const settingsBefore = await caller.others.getSettings({ serverId: 1 });

    expect(settingsBefore.logo).toBeNull();

    await caller.others.changeLogo({ serverId: 1, fileId: tempFile.id });

    const settingsAfter = await caller.others.getSettings({ serverId: 1 });

    expect(settingsAfter.logo).toBeDefined();
    expect(settingsAfter.logo?.originalName).toBe(logoFile.name);

    await caller.others.changeLogo({ serverId: 1,});

    const settingsAfterRemoval = await caller.others.getSettings({ serverId: 1 });

    expect(settingsAfterRemoval.logo).toBeNull();
  });
});

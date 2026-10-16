import { ChannelType, type TTempFile } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createTestUser } from '../../__tests__/fixtures';
import { initTest, uploadFile } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { users } from '../../db/schema';

describe('moderation inputs', () => {
  test('ban / kick reasons are capped at 256 and self-kick is refused', async () => {
    const { caller } = await initTest(1);
    const long = 'x'.repeat(257);

    await expect(caller.users.ban({ userId: 2, reason: long })).rejects.toThrow();
    await expect(caller.users.kick({ userId: 2, reason: long })).rejects.toThrow();
    await expect(caller.users.kick({ userId: 1 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.users.ban({ userId: 1 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('unban clears bannedAt and the ban reason', async () => {
    const { caller } = await initTest(1);
    await caller.users.ban({ userId: 2, reason: 'spam' });

    let [row] = await getTestDb().select().from(users).where(eq(users.id, 2));
    expect(row!.banned).toBe(true);
    expect(row!.bannedAt).not.toBeNull();

    await caller.users.unban({ userId: 2 });
    [row] = await getTestDb().select().from(users).where(eq(users.id, 2));
    expect(row!.banned).toBe(false);
    expect(row!.banReason).toBeNull();
    expect(row!.bannedAt).toBeNull();
  });

  test('getInfo never returns the auth subject id', async () => {
    const { caller } = await initTest(1);
    const info = await caller.users.getInfo({ userId: 2 });
    expect(info.user.supabaseId).toBe('');
    expect(info.user.id).toBe(2);
  });

  test('setUserNickname refuses non-members', async () => {
    const { caller } = await initTest(1);
    const outsider = await createTestUser({ name: 'outsider' });
    await expect(
      caller.users.setUserNickname({ userId: outsider, nickname: 'nope' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await caller.users.setUserNickname({ userId: 2, nickname: 'ok' });
  });
});

describe('array and id bounds', () => {
  test('reorder routes reject duplicates and oversized lists', async () => {
    const { caller } = await initTest(1);

    await expect(caller.categories.reorder({ categoryIds: [1, 1] })).rejects.toMatchObject({
      code: 'BAD_REQUEST'
    });
    await expect(
      caller.channels.reorder({ categoryId: 1, channelIds: [1, 1] })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.categories.reorder({ categoryIds: Array.from({ length: 201 }, (_, i) => i + 1) })
    ).rejects.toThrow();
    await expect(caller.categories.reorder({ categoryIds: [0] })).rejects.toThrow();
    await expect(caller.categories.reorder({ categoryIds: [1.5] })).rejects.toThrow();
  });

  test('emoji batches and file ids are bounded', async () => {
    const { caller } = await initTest(1);
    const emoji = { fileId: 'f', name: 'e' };
    await expect(
      caller.emojis.add({ serverId: 1, emojis: Array.from({ length: 21 }, () => emoji) })
    ).rejects.toThrow();
    await expect(
      caller.emojis.add({ serverId: 1, emojis: [{ fileId: 'x'.repeat(65), name: 'e' }] })
    ).rejects.toThrow();
    await expect(caller.emojis.add({ serverId: 1, emojis: [] })).rejects.toThrow();
    await expect(caller.users.changeAvatar({ fileId: 'x'.repeat(65) })).rejects.toThrow();
    await expect(caller.others.changeLogo({ serverId: 1, fileId: 'x'.repeat(65) })).rejects.toThrow();
  });

  test('invite expiry must be a future timestamp', async () => {
    const { caller } = await initTest(1);
    await expect(
      caller.invites.add({ serverId: 1, expiresAt: Date.now() - 1000 })
    ).rejects.toThrow(/future/);
    await expect(caller.invites.add({ serverId: 1, expiresAt: -5 })).rejects.toThrow();
    const invite = await caller.invites.add({ serverId: 1, expiresAt: Date.now() + 60_000 });
    expect(invite.expiresAt).toBeGreaterThan(Date.now());
  });

  test('serverChannelMap is capped at 200 entries and pruned on merge', async () => {
    const { caller } = await initTest(1);
    const tooMany = Object.fromEntries(
      Array.from({ length: 201 }, (_, i) => [`s${i}`, i + 1])
    );
    await expect(caller.users.updatePreferences({ serverChannelMap: tooMany })).rejects.toThrow();

    const first = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`a${i}`, i + 1]));
    const second = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`b${i}`, i + 1]));
    await caller.users.updatePreferences({ serverChannelMap: first });
    const merged = await caller.users.updatePreferences({ serverChannelMap: second });
    expect(Object.keys(merged.serverChannelMap).length).toBe(200);
    expect(merged.serverChannelMap.b99).toBe(100);
    expect(merged.serverChannelMap.a0).toBeUndefined();
  });

  test('name caps are the same on create and update', async () => {
    const { caller } = await initTest(1);
    const name24 = 'c'.repeat(24);
    const channelId = await caller.channels.add({
      type: ChannelType.TEXT,
      name: name24,
      categoryId: 1,
      serverId: 1
    });
    await caller.channels.update({ channelId, name: name24 });
    await expect(caller.channels.update({ channelId, name: 'c'.repeat(25) })).rejects.toThrow();

    const name32 = 'k'.repeat(32);
    const categoryId = await caller.categories.add({ serverId: 1, name: name32 });
    await caller.categories.update({ categoryId, name: name32 });
    await expect(caller.categories.update({ categoryId, name: 'k'.repeat(33) })).rejects.toThrow();
  });
});

describe('server settings', () => {
  test('a partial updateSettings leaves the password alone; explicit null clears it', async () => {
    const { caller } = await initTest(1);

    await caller.others.updateSettings({ serverId: 1, password: 'secret' });
    await caller.others.updateSettings({ serverId: 1, discoverable: true });
    let settings = await caller.others.getSettings({ serverId: 1 });
    expect(settings.password).toBe('secret');
    expect(settings.discoverable).toBe(true);

    await caller.others.updateSettings({ serverId: 1, password: null });
    settings = await caller.others.getSettings({ serverId: 1 });
    expect(settings.password).toBeNull();
  });

  test('getSettings on an unknown server is a TRPC error, not a crash', async () => {
    const { caller } = await initTest(1);
    await expect(caller.others.getSettings({ serverId: 999999 })).rejects.toMatchObject({
      code: expect.stringMatching(/NOT_FOUND|FORBIDDEN/)
    });
  });

  test('changeLogo requires an image', async () => {
    const { caller, mockedToken } = await initTest(1);
    const file = new File(['not an image'], 'logo.txt', { type: 'text/plain' });
    const upload = (await (await uploadFile(file, mockedToken)).json()) as TTempFile;

    await expect(caller.others.changeLogo({ serverId: 1, fileId: upload.id })).rejects.toMatchObject({
      code: 'BAD_REQUEST'
    });

    const image = new File(['png bytes'], 'logo.png', { type: 'image/png' });
    const imageUpload = (await (await uploadFile(image, mockedToken)).json()) as TTempFile;
    await caller.others.changeLogo({ serverId: 1, fileId: imageUpload.id });
    const settings = await caller.others.getSettings({ serverId: 1 });
    expect(settings.logo).not.toBeNull();
  });
});

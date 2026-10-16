import { ServerEvents } from '@pulse/shared';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getTestDb } from '../../__tests__/mock-db';
import { createTestUser } from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import {
  dmChannelMembers,
  dmChannels,
  files,
  friendships
} from '../../db/schema';
import { UPLOADS_PATH } from '../../helpers/paths';
import { fileManager } from '../../utils/file-manager';
import { pubsub } from '../../utils/pubsub';

const befriend = async (a: number, b: number) => {
  await getTestDb()
    .insert(friendships)
    .values({ userId: a, friendId: b, createdAt: Date.now() });
};

const makeGroup = async (ownerId: number, memberIds: number[]) => {
  const tdb = getTestDb();
  const now = Date.now();
  const [row] = await tdb
    .insert(dmChannels)
    .values({ ownerId, isGroup: true, createdAt: now })
    .returning();
  await tdb.insert(dmChannelMembers).values(
    memberIds.map((userId) => ({ dmChannelId: row!.id, userId, createdAt: now }))
  );
  return row!.id;
};

const memberIdsOf = async (dmChannelId: number) =>
  (
    await getTestDb()
      .select({ userId: dmChannelMembers.userId })
      .from(dmChannelMembers)
      .where(eq(dmChannelMembers.dmChannelId, dmChannelId))
  )
    .map((r) => r.userId)
    .sort();

const channelRow = async (dmChannelId: number) => {
  const [row] = await getTestDb()
    .select()
    .from(dmChannels)
    .where(eq(dmChannels.id, dmChannelId))
    .limit(1);
  return row;
};

/** Stage a temp upload the way /upload does, with the given extension. */
const stageTempFile = async (userId: number, ext: string) => {
  await fs.mkdir(UPLOADS_PATH, { recursive: true });
  const name = `group-icon-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`;
  const filePath = path.join(UPLOADS_PATH, name);
  await fs.writeFile(filePath, 'not really pixels');
  const stats = await fs.stat(filePath);
  return fileManager.addTemporaryFile({
    filePath,
    size: stats.size,
    originalName: name,
    userId
  });
};

describe('dms.createGroup', () => {
  test('dedupes ids, refuses self and non-friends, bounds ids', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);
    await initTest(3);
    await befriend(1, 2);
    await befriend(3, 1);

    await expect(
      caller1.dms.createGroup({ userIds: [2, 1] })
    ).rejects.toThrow('Cannot add yourself');
    await expect(
      caller1.dms.createGroup({ userIds: [2.5] })
    ).rejects.toThrow();
    await expect(caller1.dms.createGroup({ userIds: [] })).rejects.toThrow();

    const stranger = await createTestUser({ name: 'Stranger' });
    await expect(
      caller1.dms.createGroup({ userIds: [2, stranger] })
    ).rejects.toThrow('You can only add friends to a group DM');

    const group = await caller1.dms.createGroup({
      userIds: [2, 2, 3, 3],
      name: '  '
    });
    expect(group.isGroup).toBe(true);
    expect(group.ownerId).toBe(1);
    expect(group.name).toBeNull();
    expect(await memberIdsOf(group.id)).toEqual([1, 2, 3]);
  });
});

describe('dms.updateGroup', () => {
  afterEach(() => mock.restore());

  test('owner renames; non-owner, non-member and 1:1 are refused', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const { caller: caller3 } = await initTest(3);
    const groupId = await makeGroup(1, [1, 2]);

    await expect(
      caller2.dms.updateGroup({ dmChannelId: groupId, name: 'nope' })
    ).rejects.toThrow('Only the group owner can update the group');
    await expect(
      caller3.dms.updateGroup({ dmChannelId: groupId, name: 'nope' })
    ).rejects.toThrow('Only the group owner can update the group');

    const direct = await caller1.dms.getOrCreateChannel({ userId: 2 });
    await expect(
      caller1.dms.updateGroup({ dmChannelId: direct.id, name: 'nope' })
    ).rejects.toThrow('Group DM not found');
    await expect(
      caller1.dms.updateGroup({ dmChannelId: groupId, name: 'x'.repeat(101) })
    ).rejects.toThrow();

    const spy = spyOn(pubsub, 'publishFor');
    const result = await caller1.dms.updateGroup({
      dmChannelId: groupId,
      name: '  Team  '
    });
    expect(result).toEqual({ name: 'Team', iconFileId: null });
    const updates = spy.mock.calls.filter(
      ([, topic]) => topic === ServerEvents.DM_CHANNEL_UPDATE
    );
    expect(updates.map(([userIds]) => userIds).sort()).toEqual([1, 2]);
    expect(updates[0]![2]).toEqual({
      dmChannelId: groupId,
      name: 'Team',
      iconFileId: null
    });
    expect((await channelRow(groupId))!.name).toBe('Team');

    // Empty name clears the custom name.
    await caller1.dms.updateGroup({ dmChannelId: groupId, name: '' });
    expect((await channelRow(groupId))!.name).toBeNull();
  });

  test('icon: image temp upload is saved and projected; non-image refused; null clears and drops the file', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const groupId = await makeGroup(1, [1, 2]);
    const tdb = getTestDb();

    const text = await stageTempFile(1, '.txt');
    await expect(
      caller1.dms.updateGroup({ dmChannelId: groupId, iconTempFileId: text.id })
    ).rejects.toThrow('Group icon must be an image');
    expect((await channelRow(groupId))!.iconFileId).toBeNull();

    // Someone else's pending upload is not addressable.
    const foreign = await stageTempFile(2, '.png');
    await expect(
      caller1.dms.updateGroup({
        dmChannelId: groupId,
        iconTempFileId: foreign.id
      })
    ).rejects.toThrow('Temporary file not found');
    await expect(
      caller1.dms.updateGroup({
        dmChannelId: groupId,
        iconTempFileId: 'does-not-exist'
      })
    ).rejects.toThrow('Temporary file not found');

    const image = await stageTempFile(1, '.png');
    const { iconFileId } = await caller1.dms.updateGroup({
      dmChannelId: groupId,
      iconTempFileId: image.id
    });
    expect(iconFileId).toBeGreaterThan(0);
    const [saved] = await tdb.select().from(files).where(eq(files.id, iconFileId!));
    expect(saved!.mimeType).toBe('image/png');
    expect(saved!.userId).toBe(1);

    // Channel projection carries the icon for every member — the id and
    // the public file name the client needs to render it.
    const channels = await caller2.dms.getChannels();
    const projected = channels.find((c) => c.id === groupId)!;
    expect(projected.iconFileId).toBe(iconFileId);
    expect(projected.icon).toEqual({ id: iconFileId!, name: saved!.name });

    // Replacing the icon drops the previous file row.
    const image2 = await stageTempFile(1, '.png');
    const second = await caller1.dms.updateGroup({
      dmChannelId: groupId,
      iconTempFileId: image2.id
    });
    expect(second.iconFileId).not.toBe(iconFileId);
    expect(
      await tdb.select().from(files).where(eq(files.id, iconFileId!))
    ).toHaveLength(0);

    // Clearing removes the reference and the file.
    const cleared = await caller1.dms.updateGroup({
      dmChannelId: groupId,
      iconTempFileId: null
    });
    expect(cleared.iconFileId).toBeNull();
    expect((await channelRow(groupId))!.iconFileId).toBeNull();
    expect(
      (await caller2.dms.getChannels()).find((c) => c.id === groupId)!.icon
    ).toBeNull();
    expect(
      await tdb.select().from(files).where(eq(files.id, second.iconFileId!))
    ).toHaveLength(0);
  });
});

describe('dms.leave', () => {
  afterEach(() => mock.restore());

  test('member leaves a group: remaining members notified, leaver told to drop it', async () => {
    await initTest(1);
    const { caller: caller2 } = await initTest(2);
    await initTest(3);
    const groupId = await makeGroup(1, [1, 2, 3]);

    const spy = spyOn(pubsub, 'publishFor');
    await caller2.dms.leave({ dmChannelId: groupId });

    const removes = spy.mock.calls.filter(
      ([, topic]) => topic === ServerEvents.DM_MEMBER_REMOVE
    );
    expect(removes.map(([userIds]) => userIds).sort()).toEqual([1, 3]);
    expect(removes[0]![2]).toEqual({ dmChannelId: groupId, userId: 2 });
    const deletes = spy.mock.calls.filter(
      ([, topic]) => topic === ServerEvents.DM_CHANNEL_DELETE
    );
    expect(deletes.map(([userIds]) => userIds)).toEqual([2]);

    expect(await memberIdsOf(groupId)).toEqual([1, 3]);
    expect((await channelRow(groupId))!.ownerId).toBe(1);

    await expect(
      caller2.dms.leave({ dmChannelId: groupId })
    ).rejects.toThrow('Not a member of this DM channel');
  });

  test('owner leaving hands the group to a remaining member', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);
    await initTest(3);
    const groupId = await makeGroup(1, [1, 2, 3]);

    await caller1.dms.leave({ dmChannelId: groupId });

    const row = (await channelRow(groupId))!;
    expect(row.ownerId).not.toBeNull();
    expect([2, 3]).toContain(row.ownerId as number);
    expect(await memberIdsOf(groupId)).toEqual([2, 3]);
  });

  test('last member leaving deletes the channel', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    await caller1.dms.sendMessage({ dmChannelId: channel.id, content: 'hi' });

    await caller1.dms.leave({ dmChannelId: channel.id });
    expect(await channelRow(channel.id)).toBeDefined();
    expect(await memberIdsOf(channel.id)).toEqual([2]);

    await caller2.dms.leave({ dmChannelId: channel.id });
    expect(await channelRow(channel.id)).toBeUndefined();

    await expect(
      caller1.dms.leave({ dmChannelId: channel.id })
    ).rejects.toThrow('DM channel not found');
    await expect(caller1.dms.leave({ dmChannelId: 0 })).rejects.toThrow();
  });
});

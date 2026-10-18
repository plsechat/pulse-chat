import { ChannelType } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import {
  createTestCategory,
  createTestChannel,
  insertOtherServer
} from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { channels, servers } from '../../db/schema';

/**
 * Cross-server scope through the procedure builders: every route that
 * acts on an id must refuse an id that belongs to another server, and
 * a permission held in one server must not reach another. One group per
 * builder (serverProcedure, channelProcedure, instanceOwnerProcedure,
 * serverProcedureFor). Setup lives inside each test (the global
 * per-test TRUNCATE runs between tests, not around beforeEach).
 */

/** A channel + category in a server the caller is not a member of. */
const insertForeignChannel = async () => {
  const other = await insertOtherServer();
  const categoryId = await createTestCategory({ serverId: other.id });
  const channelId = await createTestChannel({
    serverId: other.id,
    categoryId,
    name: 'foreign'
  });

  return { other, categoryId, channelId };
};

describe('serverProcedure — ids are scoped to the active server', () => {
  test('MANAGE_* in the active server does not reach another server\'s rows', async () => {
    const { categoryId, channelId } = await insertForeignChannel();
    // User 1 owns server 1 (every permission there) and is active in it.
    const { caller } = await initTest(1);

    await expect(
      caller.categories.update({ categoryId, name: 'taken over' })
    ).rejects.toThrow('Category not found');
    await expect(
      caller.categories.get({ categoryId })
    ).rejects.toThrow('Category not found');
    await expect(
      caller.channels.rotateFileAccessToken({ channelId })
    ).rejects.toThrow('Channel not found');
    await expect(
      caller.channels.updatePermissions({
        channelId,
        roleId: 1,
        permissions: []
      })
    ).rejects.toThrow('Channel not found');
    await expect(
      caller.channels.deletePermissions({ channelId, roleId: 1 })
    ).rejects.toThrow('Channel not found');
    await expect(
      caller.messages.purge({ channelId, confirmChannelName: 'foreign' })
    ).rejects.toThrow('Channel not found');

    // The rows are untouched.
    const [row] = await getTestDb()
      .select({ name: channels.name })
      .from(channels)
      .where(eq(channels.id, channelId));
    expect(row!.name).toBe('foreign');
  });
});

describe('channelProcedure — channelId is scoped to the active server', () => {
  test('a channel of another server reads as nonexistent on every channel route', async () => {
    const { channelId } = await insertForeignChannel();
    const { caller } = await initTest(1);

    await expect(
      caller.messages.get({ channelId, limit: 10 })
    ).rejects.toThrow('Channel not found');
    await expect(caller.messages.getPinned({ channelId })).rejects.toThrow(
      'Channel not found'
    );
    await expect(
      caller.messages.send({ channelId, content: 'hello' })
    ).rejects.toThrow('Channel not found');
    await expect(
      caller.messages.signalTyping({ channelId })
    ).rejects.toThrow('Channel not found');
    await expect(caller.channels.markAsRead({ channelId })).rejects.toThrow(
      'Channel not found'
    );
    await expect(
      caller.channels.getVisibleUsers({ channelId })
    ).rejects.toThrow('Channel not found');
    await expect(caller.threads.getAll({ channelId })).rejects.toThrow(
      'Channel not found'
    );
    await expect(
      caller.threads.createForumPost({ channelId, title: 't', content: 'c' })
    ).rejects.toThrow('Channel not found');
    await expect(
      caller.notifications.setSetting({ channelId, level: 'all' })
    ).rejects.toThrow('Channel not found');
  });

  test('preview carve-out: reads permitted, writes refused, unlisted routes out of scope', async () => {
    const { caller: owner } = await initTest(1);
    const target = await owner.servers.create({ name: 'Preview Scope' });
    const tdb = getTestDb();
    await tdb
      .update(servers)
      .set({ discoverable: true })
      .where(eq(servers.id, target.id));
    const [publicChannel] = await tdb
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.serverId, target.id),
          eq(channels.type, ChannelType.TEXT)
        )
      )
      .limit(1);

    const { caller: previewer } = await initTest(2);
    await previewer.servers.preview({ serverId: target.id });

    // 'permit': the previewed channel is readable.
    const page = await previewer.messages.get({
      channelId: publicChannel!.id,
      limit: 10
    });
    expect(Array.isArray(page.messages)).toBe(true);
    expect(
      await previewer.messages.getPinned({ channelId: publicChannel!.id })
    ).toEqual([]);

    // 'refuse': a listed channel, but the route writes or enumerates.
    await expect(
      previewer.channels.markAsRead({ channelId: publicChannel!.id })
    ).rejects.toThrow('read-only');
    await expect(
      previewer.channels.getVisibleUsers({ channelId: publicChannel!.id })
    ).rejects.toThrow('read-only');

    // default: a route the preview never exposes treats the channel as
    // out of scope.
    await expect(
      previewer.notifications.setSetting({
        channelId: publicChannel!.id,
        level: 'all'
      })
    ).rejects.toThrow('Channel not found');
  });
});

describe('instanceOwnerProcedure — a server owner is not the operator', () => {
  test('the owner of another server cannot read instance disk metrics for it', async () => {
    const { caller } = await initTest(2);
    const own = await caller.servers.create({ name: 'Not The Instance' });

    await expect(
      caller.others.getStorageSettings({ serverId: own.id })
    ).rejects.toThrow('Only the instance owner');
    await expect(
      caller.plugins.getLogs({ pluginId: 'anything' })
    ).rejects.toThrow('Only the instance owner');
  });
});

describe('serverProcedureFor — permission is evaluated in the named server', () => {
  test('owning server B grants nothing in server A, and vice versa', async () => {
    // User 2 is a plain member of server 1 and becomes the owner of a
    // second server: every permission there, none in server 1.
    const { caller } = await initTest(2);
    const own = await caller.servers.create({ name: 'Mine' });

    await caller.categories.add({ serverId: own.id, name: 'ok here' });
    expect(await caller.roles.getAll({ serverId: own.id })).not.toHaveLength(0);

    await expect(
      caller.categories.add({ serverId: 1, name: 'not here' })
    ).rejects.toThrow('Insufficient permissions');
    await expect(caller.roles.getAll({ serverId: 1 })).rejects.toThrow(
      'Insufficient permissions'
    );
    await expect(caller.invites.add({ serverId: 1 })).rejects.toThrow(
      'Insufficient permissions'
    );
    await expect(
      caller.others.updateSettings({ serverId: 1, name: 'renamed' })
    ).rejects.toThrow('Insufficient permissions');

    // And the bootstrap owner's standing in server 1 does not reach
    // server B.
    const { caller: instanceOwner } = await initTest(1);
    await expect(
      instanceOwner.categories.add({ serverId: own.id, name: 'nope' })
    ).rejects.toThrow('Insufficient permissions');
    await expect(
      instanceOwner.others.getSettings({ serverId: own.id })
    ).rejects.toThrow('Insufficient permissions');
  });
});

import { ChannelPermission, ChannelType } from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { describe, expect, test } from 'bun:test';
import { createEmptyTextChannel } from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import {
  channelUserPermissions,
  channels,
  files,
  messageFiles
} from '../../db/schema';

/** A private TEXT channel in the bootstrap server with no override rows. */
const insertPrivateChannel = async (name: string) => {
  const [channel] = await getTestDb()
    .insert(channels)
    .values({
      type: ChannelType.TEXT,
      name,
      position: 60,
      private: true,
      fileAccessToken: randomUUIDv7(),
      fileAccessTokenUpdatedAt: Date.now(),
      publicId: randomUUIDv7(),
      categoryId: 1,
      serverId: 1,
      createdAt: Date.now()
    })
    .returning();
  return channel!;
};

/** Attach a stored file row to a message (bypasses the upload path). */
const attachFile = async (messageId: number) => {
  const tdb = getTestDb();
  const suffix = randomUUIDv7();
  const [file] = await tdb
    .insert(files)
    .values({
      name: `search-${suffix}.png`,
      originalName: 'pic.png',
      md5: `md5-${suffix}`,
      userId: 1,
      size: 64,
      mimeType: 'image/png',
      extension: '.png',
      createdAt: Date.now()
    })
    .returning();
  await tdb.insert(messageFiles).values({
    messageId,
    fileId: file!.id,
    createdAt: Date.now()
  });
  return file!;
};

describe('search router', () => {
  test('server-wide search skips private channels the caller cannot view', async () => {
    const tdb = getTestDb();
    const { caller: owner } = await initTest(1);
    const { caller: member } = await initTest(2);
    const secret = await insertPrivateChannel('search-secret');

    const secretId = await owner.messages.send({
      channelId: secret.id,
      content: 'zebra in the vault'
    });
    await attachFile(secretId);

    // Owner sees it (owner bypasses channel permissions).
    const ownerHits = await owner.search.messages({ query: 'zebra' });
    expect(ownerHits.messages.map((m) => m.id)).toContain(secretId);

    // A member without an override gets nothing — with or without the
    // file filter, and an explicit channelId is refused outright.
    const hits = await member.search.messages({ query: 'zebra' });
    expect(hits.messages).toHaveLength(0);

    const fileHits = await member.search.messages({
      query: 'zebra',
      hasFile: true
    });
    expect(fileHits.messages).toHaveLength(0);

    await expect(
      member.search.messages({ query: 'zebra', channelId: secret.id })
    ).rejects.toThrow('Insufficient channel permissions');

    // Granting VIEW makes it visible — the filter is permission-driven,
    // not "private channels never".
    await tdb.insert(channelUserPermissions).values({
      channelId: secret.id,
      userId: 2,
      permission: ChannelPermission.VIEW_CHANNEL,
      allow: true,
      createdAt: Date.now()
    });
    const { caller: memberAgain } = await initTest(2);
    const afterGrant = await memberAgain.search.messages({ query: 'zebra' });
    expect(afterGrant.messages.map((m) => m.id)).toContain(secretId);
    // The attachment token is minted only now that the channel is viewable.
    expect(afterGrant.messages[0]!.files[0]!._accessToken).toBeDefined();
  });

  test('hasFile returns only messages with attachments', async () => {
    const { caller } = await initTest(1);
    const channel = await createEmptyTextChannel('search-files');

    const withFile = await caller.messages.send({
      channelId: channel.id,
      content: 'attachment here'
    });
    await attachFile(withFile);
    await caller.messages.send({
      channelId: channel.id,
      content: 'attachment mentioned, none attached'
    });

    const all = await caller.search.messages({
      query: 'attachment',
      channelId: channel.id
    });
    expect(all.messages).toHaveLength(2);

    const onlyFiles = await caller.search.messages({
      query: 'attachment',
      channelId: channel.id,
      hasFile: true
    });
    expect(onlyFiles.messages).toHaveLength(1);
    expect(onlyFiles.messages[0]!.id).toBe(withFile);
    expect(onlyFiles.messages[0]!.files).toHaveLength(1);
  });

  test('reply previews are limited to the searched channels', async () => {
    const { caller } = await initTest(1);
    const channel = await createEmptyTextChannel('search-replies');

    const target = await caller.messages.send({
      channelId: channel.id,
      content: 'reply target'
    });
    const reply = await caller.messages.send({
      channelId: channel.id,
      content: 'searchable reply',
      replyToId: target
    });

    const hits = await caller.search.messages({
      query: 'searchable reply',
      channelId: channel.id
    });
    expect(hits.messages).toHaveLength(1);
    expect(hits.messages[0]!.id).toBe(reply);
    expect(hits.messages[0]!.replyTo?.content).toBe('reply target');
  });

  test('rejects non-integer ids and cursors', async () => {
    const { caller } = await initTest(1);

    await expect(
      caller.search.messages({ query: 'x', channelId: 1.5 })
    ).rejects.toThrow();
    await expect(
      caller.search.messages({ query: 'x', limit: 51 })
    ).rejects.toThrow();
  });
});

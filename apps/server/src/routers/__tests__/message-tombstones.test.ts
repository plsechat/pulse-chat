import { ServerEvents } from '@pulse/shared';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { createEmptyTextChannel } from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import {
  getChannelUnreadForUsers,
  getChannelsReadStatesForUser
} from '../../db/queries/channels';
import { getServerUnreadCount } from '../../db/queries/servers';
import {
  channelReadStates,
  files,
  messageFiles,
  messageReactions,
  messages,
  polls,
  reports,
  userRoles
} from '../../db/schema';
import { pubsub } from '../../utils/pubsub';

/**
 * Deleted messages leave a tombstone (owner decision D55): the row stays
 * with deletedAt/deletedBy and nothing else, every path that reacts to
 * a delete follows it, and nothing can be done to one but read it in
 * place.
 */

type PublishCall = [number | number[], string, unknown];
const callsFor = (spy: { mock: { calls: unknown[][] } }, topic: string) =>
  (spy.mock.calls as PublishCall[]).filter(([, t]) => t === topic);

afterEach(() => mock.restore());

const rowOf = async (messageId: number) => {
  const [row] = await getTestDb()
    .select()
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  return row;
};

const insertFileRow = async (userId: number, name: string) => {
  const [row] = await getTestDb()
    .insert(files)
    .values({
      name,
      originalName: name,
      md5: `md5-${name}`,
      userId,
      size: 3,
      mimeType: 'text/plain',
      extension: '.txt',
      createdAt: Date.now()
    })
    .returning({ id: files.id });
  return row!.id;
};

const attachFile = async (messageId: number, userId: number) => {
  const fileId = await insertFileRow(userId, `tomb-${messageId}-${Date.now()}.txt`);
  await getTestDb()
    .insert(messageFiles)
    .values({ messageId, fileId, createdAt: Date.now() });
  return fileId;
};

/** User 2 with their roles removed: a member who holds no permission. */
const strangerCaller = async () => {
  const { caller, ctx } = await initTest(2);
  await getTestDb().delete(userRoles).where(eq(userRoles.userId, 2));
  ctx.invalidatePermissionCache();
  return caller;
};

describe('messages.delete leaves a tombstone', () => {
  test('the row stays with deletedAt/deletedBy and nothing else; files, reactions, pin and poll go', async () => {
    const { caller: owner } = await initTest(1);
    const { caller: member } = await initTest(2);
    const channel = await createEmptyTextChannel('tomb');
    const tdb = getTestDb();

    const messageId = await member.messages.send({
      channelId: channel.id,
      content: 'hello <@1> everyone',
      files: []
    });
    const fileId = await attachFile(messageId, 2);
    await owner.messages.toggleReaction({ messageId, emoji: '👍' });
    await owner.messages.pin({ messageId });
    await tdb
      .update(messages)
      .set({
        metadata: [{ url: 'https://example.org', title: 'Example', mediaType: 'link' }],
        mentionedUserIds: [1],
        edited: true
      })
      .where(eq(messages.id, messageId));
    await tdb.insert(polls).values({
      messageId,
      channelId: channel.id,
      question: 'q',
      options: [{ key: 'a', label: 'A' }],
      createdAt: Date.now()
    });

    const spy = spyOn(pubsub, 'publishFor');
    const before = Date.now();
    await member.messages.delete({ messageId });

    const row = await rowOf(messageId);
    expect(row).toBeDefined();
    expect(row!.deletedAt).toBeGreaterThanOrEqual(before);
    expect(row!.deletedBy).toBe(2);
    expect(row).toMatchObject({
      content: null,
      metadata: null,
      mentionedUserIds: null,
      mentionsAll: false,
      edited: false,
      pinned: false,
      pinnedAt: null,
      pinnedBy: null,
      channelId: channel.id,
      userId: 2
    });
    expect(await tdb.select().from(files).where(eq(files.id, fileId))).toHaveLength(0);
    expect(
      await tdb.select().from(messageFiles).where(eq(messageFiles.messageId, messageId))
    ).toHaveLength(0);
    expect(
      await tdb.select().from(messageReactions).where(eq(messageReactions.messageId, messageId))
    ).toHaveLength(0);
    expect(await tdb.select().from(polls).where(eq(polls.messageId, messageId))).toHaveLength(0);

    // The fan-out carries the tombstone; the pin's removal is announced
    // like an unpin so pinned surfaces refetch.
    const [deletion] = callsFor(spy, ServerEvents.MESSAGE_DELETE);
    expect(deletion![2]).toEqual({
      messageId,
      channelId: channel.id,
      deletedAt: row!.deletedAt,
      deletedBy: 2
    });
    expect(callsFor(spy, ServerEvents.MESSAGE_UNPIN)).toHaveLength(1);

    // Still listed, in place, as a tombstone; not pinned any more.
    const { messages: listed } = await owner.messages.get({ channelId: channel.id });
    const listedRow = listed.find((m) => m.id === messageId);
    expect(listedRow).toMatchObject({
      deletedAt: row!.deletedAt,
      deletedBy: 2,
      content: null,
      files: [],
      reactions: []
    });
    expect(await owner.messages.getPinned({ channelId: channel.id })).toEqual([]);

    // Deleting a tombstone again is refused with a clear message.
    await expect(member.messages.delete({ messageId })).rejects.toThrow(
      'Message is already deleted'
    );
  });

  test('who may delete: the author, a MANAGE_MESSAGES holder, not a stranger', async () => {
    const { caller: owner } = await initTest(1);
    const { caller: author } = await initTest(3);
    const channel = await createEmptyTextChannel('tomb-who');

    const byAuthor = await author.messages.send({ channelId: channel.id, content: 'mine', files: [] });
    const byMod = await author.messages.send({ channelId: channel.id, content: 'theirs', files: [] });
    const untouchable = await author.messages.send({ channelId: channel.id, content: 'no', files: [] });

    const stranger = await strangerCaller();
    await expect(stranger.messages.delete({ messageId: untouchable })).rejects.toThrow(
      'You do not have permission to delete this message'
    );

    await author.messages.delete({ messageId: byAuthor });
    expect((await rowOf(byAuthor))!.deletedBy).toBe(3);

    await owner.messages.delete({ messageId: byMod });
    expect((await rowOf(byMod))!.deletedBy).toBe(1);

    expect((await rowOf(untouchable))!.deletedAt).toBeNull();
  });

  test('edit, react, pin, forward, reply and thread on a tombstone are refused', async () => {
    const { caller: owner } = await initTest(1);
    const channel = await createEmptyTextChannel('tomb-actions');
    const messageId = await owner.messages.send({ channelId: channel.id, content: 'gone soon', files: [] });
    await owner.messages.delete({ messageId });

    await expect(owner.messages.edit({ messageId, content: 'resurrect' })).rejects.toThrow(
      'This message was deleted'
    );
    await expect(owner.messages.toggleReaction({ messageId, emoji: '👍' })).rejects.toThrow(
      'This message was deleted'
    );
    await expect(owner.messages.pin({ messageId })).rejects.toThrow('This message was deleted');
    await expect(
      owner.messages.send({
        channelId: channel.id,
        content: 'fwd',
        files: [],
        forwardedFrom: { sourceKind: 'channel', sourceId: messageId }
      })
    ).rejects.toThrow('Source message was deleted');
    await expect(
      owner.messages.send({ channelId: channel.id, content: 're', files: [], replyToId: messageId })
    ).rejects.toThrow('You cannot reply to a deleted message');
    await expect(owner.threads.create({ messageId, name: 'Thread' })).rejects.toThrow(
      'This message was deleted'
    );

    expect((await rowOf(messageId))!.content).toBeNull();
  });

  test('an existing reply shows the deleted target; a thread keeps its tombstoned root', async () => {
    const { caller: owner } = await initTest(1);
    const channel = await createEmptyTextChannel('tomb-reply');
    const target = await owner.messages.send({ channelId: channel.id, content: 'target', files: [] });
    const reply = await owner.messages.send({
      channelId: channel.id,
      content: 'reply',
      files: [],
      replyToId: target
    });
    const { threadId } = await owner.threads.create({ messageId: target, name: 'Root thread' });

    await owner.messages.delete({ messageId: target });

    const { messages: listed } = await owner.messages.get({ channelId: channel.id });
    const replyRow = listed.find((m) => m.id === reply);
    expect(replyRow!.replyTo).toMatchObject({ id: target, content: null, hasFiles: false });
    expect(listed.find((m) => m.id === target)!.threadId).toBe(threadId);

    // Jump-to-message on the tombstone still lands on its anchor.
    const around = await owner.messages.get({ channelId: channel.id, aroundId: target, limit: 10 });
    expect(around.messages.map((m) => m.id)).toContain(target);
  });

  test('search, unread and mention counts exclude tombstones', async () => {
    const { caller: owner } = await initTest(1);
    const { caller: member } = await initTest(2);
    const channel = await createEmptyTextChannel('tomb-counts');
    const tdb = getTestDb();

    // Member 2 has read the first message; two more arrive, one of
    // which mentions them, then one of those is deleted.
    const first = await owner.messages.send({ channelId: channel.id, content: 'first', files: [] });
    await tdb.insert(channelReadStates).values({
      userId: 2,
      channelId: channel.id,
      lastReadMessageId: first,
      lastReadAt: Date.now()
    });
    const keep = await owner.messages.send({ channelId: channel.id, content: 'needle kept', files: [] });
    const gone = await owner.messages.send({ channelId: channel.id, content: 'needle <@2> gone', files: [] });
    await tdb.update(messages).set({ mentionedUserIds: [2] }).where(eq(messages.id, gone));

    const beforeStates = await getChannelsReadStatesForUser(2, channel.id);
    expect(beforeStates.readStates[channel.id]).toBe(2);
    expect(beforeStates.mentionStates[channel.id]).toBe(1);

    await owner.messages.delete({ messageId: gone });

    const states = await getChannelsReadStatesForUser(2, channel.id);
    expect(states.readStates[channel.id]).toBe(1);
    expect(states.mentionStates[channel.id]).toBeUndefined();
    expect((await getChannelUnreadForUsers([2], channel.id)).get(2)).toEqual({
      count: 1,
      mentionCount: 0
    });
    const serverCounts = await getServerUnreadCount(2, 1);
    expect(serverCounts.mentionCount).toBe(0);

    const found = await member.search.messages({ query: 'needle', channelId: channel.id });
    expect(found.messages.map((m) => m.id)).toEqual([keep]);
  });

  test('bulk delete tombstones the live rows only and reports how many', async () => {
    const { caller: owner } = await initTest(1);
    const channel = await createEmptyTextChannel('tomb-bulk');
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await owner.messages.send({ channelId: channel.id, content: `bulk ${i}`, files: [] }));
    }
    await attachFile(ids[0]!, 1);
    await owner.messages.delete({ messageId: ids[2]! });

    const spy = spyOn(pubsub, 'publishFor');
    const result = await owner.messages.bulkDelete({ messageIds: ids });
    expect(result.deletedCount).toBe(2);

    const [bulk] = callsFor(spy, ServerEvents.MESSAGE_BULK_DELETE);
    expect(bulk![2]).toMatchObject({
      messageIds: [ids[0], ids[1]],
      channelId: channel.id,
      deletedBy: 1
    });
    expect((bulk![2] as { deletedAt: number }).deletedAt).toBeGreaterThan(0);

    const { messages: listed } = await owner.messages.get({ channelId: channel.id });
    expect(listed).toHaveLength(3);
    expect(listed.every((m) => m.deletedAt != null && m.content === null)).toBe(true);
    expect(
      await getTestDb().select().from(messageFiles).where(eq(messageFiles.messageId, ids[0]!))
    ).toHaveLength(0);

    // Nothing live left to bulk-delete.
    await expect(owner.messages.bulkDelete({ messageIds: ids })).rejects.toThrow('No messages found');
  });

  test('purge stays a hard wipe: tombstones go with everything else', async () => {
    const { caller: owner } = await initTest(1);
    const channel = await createEmptyTextChannel('tomb-purge');
    const a = await owner.messages.send({ channelId: channel.id, content: 'a', files: [] });
    await owner.messages.send({ channelId: channel.id, content: 'b', files: [] });
    await owner.messages.delete({ messageId: a });

    await owner.messages.purge({ channelId: channel.id, confirmChannelName: 'tomb-purge' });

    expect(
      await getTestDb().select().from(messages).where(eq(messages.channelId, channel.id))
    ).toHaveLength(0);
  });

  test('a report takedown is a tombstone attributed to the resolving moderator', async () => {
    const { caller: owner } = await initTest(1);
    const { caller: member } = await initTest(2);
    const { caller: author } = await initTest(3);
    const channel = await createEmptyTextChannel('tomb-report');
    const messageId = await author.messages.send({ channelId: channel.id, content: 'bad', files: [] });
    await member.reports.create({ kind: 'message', targetId: messageId, reason: 'spam' });
    const [report] = await getTestDb()
      .select({ id: reports.id })
      .from(reports)
      .where(and(eq(reports.targetMessageId, messageId), eq(reports.status, 'open')));

    const spy = spyOn(pubsub, 'publishFor');
    await owner.reports.resolveServer({ reportId: report!.id, action: 'delete-content' });

    const row = await rowOf(messageId);
    expect(row).toMatchObject({ content: null, deletedBy: 1 });
    expect(row!.deletedAt).toBeGreaterThan(0);
    // The takedown's fan-out is fire-and-forget (it resolves the
    // channel's viewers first).
    for (let i = 0; i < 100 && callsFor(spy, ServerEvents.MESSAGE_DELETE).length === 0; i++) {
      await Bun.sleep(5);
    }
    const [deletion] = callsFor(spy, ServerEvents.MESSAGE_DELETE);
    expect(deletion![2]).toMatchObject({ messageId, deletedBy: 1 });
  });

  test('the mod view of a member lists no tombstones', async () => {
    const { caller: owner } = await initTest(1);
    const { caller: author } = await initTest(3);
    const channel = await createEmptyTextChannel('tomb-modview');
    const kept = await author.messages.send({ channelId: channel.id, content: 'kept', files: [] });
    const gone = await author.messages.send({ channelId: channel.id, content: 'gone', files: [] });
    await owner.messages.delete({ messageId: gone });

    const info = await owner.users.getInfo({ userId: 3 });
    const ids = info.messages.map((m) => m.id);
    expect(ids).toContain(kept);
    expect(ids).not.toContain(gone);
  });
});
